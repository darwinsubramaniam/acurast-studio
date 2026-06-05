import * as vscode from 'vscode';
import * as path from 'path';

export interface AcurastConfig {
  name?: string;
  runtime?: string;
  execution?: {
    type: string;
    interval?: number;
    maxExecutionTime?: number;
  };
  maxCostPerExecution?: string;
  numberOfReplicas?: number;
  minReplicas?: number;
  maxReplicas?: number;
  assignmentStrategy?: { type: string };
  includeEnvironmentVariables?: string[];
}

const STATE_KEY = 'acurast.activeConfigPath';

export class AcurastContext {
  readonly extensionContext: vscode.ExtensionContext;
  private _onDidChangeActiveConfig = new vscode.EventEmitter<string | undefined>();
  readonly onDidChangeActiveConfig = this._onDidChangeActiveConfig.event;

  private _isAcurastProject = false;
  private _configPath: string | undefined;
  private _config: AcurastConfig | undefined;

  constructor(extensionContext: vscode.ExtensionContext) {
    this.extensionContext = extensionContext;
  }

  async initialize() {
    await this.detectProject();

    this.extensionContext.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.detectProject()),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this._configPath && doc.fileName === this._configPath) {
          this.loadConfig();
        }
      })
    );

    const watcher = vscode.workspace.createFileSystemWatcher('**/acurast.json');
    watcher.onDidCreate(() => this.detectProject());
    watcher.onDidDelete(() => this.detectProject());
    watcher.onDidChange(() => this.detectProject());
    this.extensionContext.subscriptions.push(watcher);
  }

  /** Active acurast.json file path, or undefined. */
  get configPath(): string | undefined {
    return this._configPath;
  }

  /** Directory containing the active acurast.json (used as project cwd). */
  get projectRoot(): string | undefined {
    return this._configPath ? path.dirname(this._configPath) : undefined;
  }

  get config() {
    return this._config;
  }

  get isAcurastProject() {
    return this._isAcurastProject;
  }

  get cliPath(): string {
    return vscode.workspace.getConfiguration('acurast').get<string>('cliPath', 'acurast');
  }

  get network(): string {
    return vscode.workspace.getConfiguration('acurast').get<string>('network', 'mainnet');
  }

  /** Pick a specific file as the active acurast.json. Persists across sessions. */
  async setActiveConfig(uri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.stat(uri);
    } catch {
      throw new Error(`File not found: ${uri.fsPath}`);
    }
    if (path.basename(uri.fsPath) !== 'acurast.json') {
      throw new Error('Selected file must be named acurast.json');
    }
    await this.extensionContext.workspaceState.update(STATE_KEY, uri.fsPath);
    this._configPath = uri.fsPath;
    await this.loadConfig();
    this.setIsAcurastProject(true);
    this._onDidChangeActiveConfig.fire(this._configPath);
  }

  async clearActiveConfig(): Promise<void> {
    await this.extensionContext.workspaceState.update(STATE_KEY, undefined);
    this._configPath = undefined;
    this._config = undefined;
    this.setIsAcurastProject(false);
    this._onDidChangeActiveConfig.fire(undefined);
  }

  /** Scan the workspace for all acurast.json files. */
  async findAllConfigs(): Promise<vscode.Uri[]> {
    return vscode.workspace.findFiles('**/acurast.json', '**/node_modules/**', 50);
  }

  private async detectProject() {
    const stored = this.extensionContext.workspaceState.get<string>(STATE_KEY);

    if (stored) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(stored));
        this._configPath = stored;
        await this.loadConfig();
        this.setIsAcurastProject(true);
        this._onDidChangeActiveConfig.fire(this._configPath);
        return;
      } catch {
        // The stored config was deleted/moved — drop the stale pointer and fall
        // through to fresh detection instead of pinning a dead path and claiming
        // the workspace is an Acurast project.
        await this.extensionContext.workspaceState.update(STATE_KEY, undefined);
        this._configPath = undefined;
        this._config = undefined;
      }
    }

    const folders = vscode.workspace.workspaceFolders ?? [];

    // Try workspace-root acurast.json files first
    for (const folder of folders) {
      const candidate = vscode.Uri.joinPath(folder.uri, 'acurast.json');
      try {
        await vscode.workspace.fs.stat(candidate);
        this._configPath = candidate.fsPath;
        await this.loadConfig();
        this.setIsAcurastProject(true);
        this._onDidChangeActiveConfig.fire(this._configPath);
        return;
      } catch {
        // continue
      }
    }

    // Fall back to a recursive scan; pick the first if exactly one is found
    const found = await this.findAllConfigs();
    if (found.length === 1) {
      this._configPath = found[0].fsPath;
      await this.loadConfig();
      this.setIsAcurastProject(true);
      this._onDidChangeActiveConfig.fire(this._configPath);
      return;
    }

    this._configPath = undefined;
    this._config = undefined;
    this.setIsAcurastProject(false);
    this._onDidChangeActiveConfig.fire(undefined);
  }

  private async loadConfig() {
    if (!this._configPath) {
      this._config = undefined;
      return;
    }
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this._configPath));
      const raw = new TextDecoder('utf-8').decode(data);
      this._config = JSON.parse(raw) as AcurastConfig;
    } catch {
      this._config = undefined;
    }
  }

  private setIsAcurastProject(value: boolean) {
    this._isAcurastProject = value;
    vscode.commands.executeCommand('setContext', 'acurast.isAcurastProject', value);
  }
}
