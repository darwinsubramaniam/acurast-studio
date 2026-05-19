import * as vscode from 'vscode';
import { WalletService } from '../wallet/walletService';
import { AcurastContext } from '../context';
import { acurastClient } from '../sdk/acurastClient';
import { getAcknowledgedProcessors, walletFromMnemonic, jobIdFromChainJson } from '@acurast/sdk/chain';
import type { UnsubEvent } from '@acurast/sdk/chain';
import { SYMBOL, type AcurastNetwork } from '../sdk/constants';

type Route = 'home' | 'wallets' | 'settings' | 'deploy';

interface NavigateMsg { type: 'navigate'; route: Route; }
interface ReadyMsg { type: 'ready'; }
interface WalletActionMsg {
  type: 'wallet';
  action: 'create' | 'import' | 'reveal' | 'delete' | 'copyAddress' | 'rename' | 'editDescription' | 'setActive';
  id?: string;
}
interface RefreshBalanceMsg { type: 'refreshBalance'; }
interface ConfigSaveMsg { type: 'config.save'; projectKey: string; patch: Record<string, unknown>; }
interface ConfigOpenJsonMsg { type: 'config.openJson'; }
interface ConfigChooseMsg { type: 'config.choose'; }
interface DeployStartMsg { type: 'deploy.start'; }
interface DeployOpenOutputMsg { type: 'deploy.openOutput'; }
interface DeployQueryProcessorsMsg { type: 'deploy.queryProcessors'; }
interface DeployCopyMsg { type: 'deploy.copy'; text: string; }
interface DeployDeregisterMsg { type: 'deploy.deregister'; origin: string; localId: number; }
type InMsg =
  | NavigateMsg | ReadyMsg | WalletActionMsg | RefreshBalanceMsg
  | ConfigSaveMsg | ConfigOpenJsonMsg | ConfigChooseMsg
  | DeployStartMsg | DeployOpenOutputMsg | DeployQueryProcessorsMsg | DeployCopyMsg
  | DeployDeregisterMsg;

const BALANCE_POLL_MS = 30_000;

type DeployStageId =
  | 'bundle' | 'upload' | 'prepare' | 'submit'
  | 'match' | 'acknowledge' | 'envvars';
type StageStatus = 'pending' | 'active' | 'done' | 'error';

interface DeployStage {
  id: DeployStageId;
  label: string;
  status: StageStatus;
  detail?: string;
}

interface DeployJobId {
  origin: string;       // acurast address (consumer)
  localId: number;      // numeric on-chain job id (the "deployment ID")
  deregistering?: boolean;
  deregistered?: boolean;
  deregisterTxHash?: string;
  deregisterError?: string;
}

interface ProcessorPubKey {
  curve: string;
  key: string;
}

interface ProcessorInfo {
  address: string;
  slot?: number;
  startDelay?: number;
  feePerExecution?: string;
  acknowledged?: boolean;
  slaTotal?: string;
  slaMet?: string;
  pubKeys?: ProcessorPubKey[];
}

interface ProcessorsState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  list?: ProcessorInfo[];
  message?: string;
  fetchedAt?: number;
}

interface ChainEvent {
  ts: number;
  section: string;
  method: string;
  jobLocalId?: number;
  summary: string;
  kind: 'started' | 'reported' | 'finalized' | 'other';
}

interface DeployState {
  active: boolean;
  startedAt: number;
  finishedAt?: number;
  result?: 'ok' | 'error';
  errorMessage?: string;
  project?: string;
  network?: string;
  ipfsHash?: string;
  txHash?: string;
  ackCount?: number;
  jobIds: DeployJobId[];
  processors?: ProcessorsState;
  stages: DeployStage[];
  chainEvents: ChainEvent[];
  watching: boolean;
}

function defaultStages(): DeployStage[] {
  return [
    { id: 'bundle',      label: 'Package bundle',      status: 'pending' },
    { id: 'upload',      label: 'Upload to IPFS',      status: 'pending' },
    { id: 'prepare',     label: 'Prepare job',         status: 'pending' },
    { id: 'submit',      label: 'Submit transaction',  status: 'pending' },
    { id: 'match',       label: 'Match processor',     status: 'pending' },
    { id: 'acknowledge', label: 'Acknowledge',         status: 'pending' },
    { id: 'envvars',     label: 'Set env vars',        status: 'pending' },
  ];
}

export class StudioPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'acurastStudio';
  private _view: vscode.WebviewView | undefined;
  private _route: Route = 'home';
  private _balanceTimer: NodeJS.Timeout | undefined;
  private _deploy: DeployState | null = null;
  private _chainEventUnsub: UnsubEvent | undefined;
  private _chainWatchToken = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ctx: AcurastContext,
    private readonly wallet: WalletService
  ) {
    wallet.onDidChange(() => this.pushWallets());
    ctx.onDidChangeActiveConfig(() => {
      this.pushContext();
      if (this._route === 'settings') this.pushConfig();
    });
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.ctx.configPath && doc.fileName === this.ctx.configPath) this.pushConfig();
    });
  }

  private pushContext() {
    this.post({
      type: 'context',
      isAcurastProject: this.ctx.isAcurastProject,
      configPath: this.ctx.configPath ?? null,
      configRel: this.ctx.configPath
        ? vscode.workspace.asRelativePath(this.ctx.configPath)
        : null,
    });
  }

  private get network(): AcurastNetwork {
    return vscode.workspace.getConfiguration('acurast').get<AcurastNetwork>('network', 'mainnet');
  }

  async navigate(route: Route) {
    this._route = route;
    this.updateRouteContext();
    if (this._view) {
      this.post({ type: 'route', route });
      if (route === 'wallets') {
        await this.pushWallets();
        this.startBalancePoll();
      } else {
        this.stopBalancePoll();
      }
      if (route === 'settings') await this.pushConfig();
      if (route === 'deploy') this.pushDeploy();
    }
    // Reveal the view (auto-generated focus command)
    await vscode.commands.executeCommand('acurastStudio.focus');
  }

  private updateRouteContext() {
    vscode.commands.executeCommand('setContext', 'acurast.studio.route', this._route);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.onDidChangeVisibility(() => {
      if (view.visible && this._route === 'wallets') this.startBalancePoll();
      else this.stopBalancePoll();
    });
    view.onDidDispose(() => { this.stopBalancePoll(); void this.stopChainWatch(); });

    view.webview.onDidReceiveMessage((msg: InMsg) => this.handle(msg));
  }

  private async handle(msg: InMsg) {
    switch (msg.type) {
      case 'ready':
        this.pushAll();
        break;
      case 'navigate':
        this._route = msg.route;
        this.updateRouteContext();
        this.post({ type: 'route', route: msg.route });
        if (msg.route === 'wallets') {
          await this.pushWallets();
          this.startBalancePoll();
        } else {
          this.stopBalancePoll();
        }
        if (msg.route === 'settings') await this.pushConfig();
        if (msg.route === 'deploy') this.pushDeploy();
        break;
      case 'wallet':
        await this.runWalletAction(msg);
        break;
      case 'refreshBalance':
        await this.pushBalance();
        break;
      case 'config.save':
        await this.saveConfigPatch(msg.projectKey, msg.patch);
        break;
      case 'config.openJson':
        await this.openJson();
        break;
      case 'config.choose':
        await vscode.commands.executeCommand('acurast.chooseConfig');
        break;
      case 'deploy.start':
        await vscode.commands.executeCommand('acurast.deploy');
        break;
      case 'deploy.openOutput':
        await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        break;
      case 'deploy.queryProcessors':
        await this.queryProcessors();
        break;
      case 'deploy.copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.setStatusBarMessage(`Copied "${msg.text}"`, 1500);
        }
        break;
      case 'deploy.deregister':
        await this.deregisterDeployment(msg.origin, msg.localId);
        break;
    }
  }

  private async runWalletAction(msg: WalletActionMsg) {
    const cmdMap: Record<WalletActionMsg['action'], string> = {
      create: 'acurast.wallet.create',
      import: 'acurast.wallet.import',
      reveal: 'acurast.wallet.reveal',
      delete: 'acurast.wallet.delete',
      copyAddress: 'acurast.wallet.copyAddress',
      rename: 'acurast.wallet.rename',
      editDescription: 'acurast.wallet.editDescription',
      setActive: 'acurast.wallet.setActive',
    };
    if (msg.action === 'setActive' && msg.id) {
      await this.wallet.setActive(msg.id);
      return;
    }
    await vscode.commands.executeCommand(cmdMap[msg.action], msg.id);
  }

  private post(msg: unknown) {
    this._view?.webview.postMessage(msg);
  }

  private async pushAll() {
    this.post({ type: 'route', route: this._route });
    this.pushContext();
    await this.pushWallets();
    if (this._route === 'wallets') this.startBalancePoll();
    if (this._route === 'settings') await this.pushConfig();
    if (this._route === 'deploy') this.pushDeploy();
  }

  private async pushWallets() {
    const wallets = await this.wallet.list();
    const activeId = await this.wallet.getActiveId();
    this.post({
      type: 'wallets.state',
      wallets,
      activeId,
      network: this.network,
      symbol: SYMBOL[this.network],
    });
    if (activeId && this._route === 'wallets') await this.pushBalance();
  }

  private startBalancePoll() {
    this.stopBalancePoll();
    this._balanceTimer = setInterval(() => this.pushBalance(), BALANCE_POLL_MS);
  }

  private stopBalancePoll() {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer);
      this._balanceTimer = undefined;
    }
  }

  private async pushBalance() {
    const active = await this.wallet.getActive();
    if (!active) return;
    this.post({ type: 'wallets.balance', status: 'loading' });
    try {
      const balance = await acurastClient.getBalance(this.network, active.address);
      this.post({
        type: 'wallets.balance',
        status: 'ok',
        value: balance,
        symbol: SYMBOL[this.network],
        network: this.network,
      });
    } catch (err: unknown) {
      this.post({ type: 'wallets.balance', status: 'error', message: (err as Error).message });
    }
  }

  private async pushConfig() {
    const raw = await this.readConfig();
    this.post({ type: 'config.state', config: raw });
  }

  private async readConfig(): Promise<unknown | undefined> {
    if (!this.ctx.configPath) return undefined;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.ctx.configPath));
      return JSON.parse(new TextDecoder('utf-8').decode(data));
    } catch {
      return undefined;
    }
  }

  private async openJson() {
    if (!this.ctx.configPath) return;
    await vscode.window.showTextDocument(vscode.Uri.file(this.ctx.configPath));
  }

  /* ---------------- Deploy state ---------------- */

  beginDeploy(opts: { project: string; network: string }) {
    const stages = defaultStages();
    stages[0].status = 'active';
    this._deploy = {
      active: true,
      startedAt: Date.now(),
      project: opts.project,
      network: opts.network,
      jobIds: [],
      stages,
      chainEvents: [],
      watching: false,
    };
    void this.stopChainWatch();
    void this.navigate('deploy');
  }

  recordDeployStatus(status: string, data: unknown) {
    if (!this._deploy) return;
    const d = this._deploy;

    const idxOf = (id: DeployStageId) => d.stages.findIndex((s) => s.id === id);
    const setStatus = (id: DeployStageId, status: StageStatus, detail?: string) => {
      const stage = d.stages.find((s) => s.id === id);
      if (!stage) return;
      stage.status = status;
      if (detail !== undefined) stage.detail = detail;
    };
    const advanceTo = (id: DeployStageId) => {
      const idx = idxOf(id);
      if (idx < 0) return;
      for (let i = 0; i < idx; i++) {
        if (d.stages[i].status === 'pending' || d.stages[i].status === 'active') {
          d.stages[i].status = 'done';
        }
      }
      if (d.stages[idx].status === 'pending') d.stages[idx].status = 'active';
    };

    const obj = (data ?? {}) as Record<string, unknown>;

    // jobIds arrive on WaitingForMatch and Matched as [[{acurast: addr}, localId]]
    const incomingJobIds = parseJobIds(obj.jobIds);
    if (incomingJobIds.length) d.jobIds = mergeJobIds(d.jobIds, incomingJobIds);

    switch (status) {
      case 'Uploaded': {
        const hash = typeof obj.ipfsHash === 'string' ? obj.ipfsHash : undefined;
        if (hash) d.ipfsHash = hash;
        setStatus('bundle', 'done');
        setStatus('upload', 'done', hash);
        advanceTo('prepare');
        break;
      }
      case 'Prepared': {
        setStatus('prepare', 'done');
        advanceTo('submit');
        break;
      }
      case 'Submit': {
        const tx = typeof obj.txHash === 'string' ? obj.txHash : undefined;
        if (tx) d.txHash = tx;
        setStatus('submit', 'done', tx);
        advanceTo('match');
        break;
      }
      case 'WaitingForMatch': {
        // SDK can emit WaitingForMatch before Submit's txHash arrives.
        setStatus('submit', d.txHash ? 'done' : 'active');
        advanceTo('match');
        break;
      }
      case 'Matched': {
        setStatus('match', 'done');
        advanceTo('acknowledge');
        break;
      }
      case 'Acknowledged': {
        const n = typeof obj.acknowledged === 'number' ? obj.acknowledged : 1;
        d.ackCount = n;
        setStatus('acknowledge', 'done', `${n} processor${n === 1 ? '' : 's'}`);
        advanceTo('envvars');
        void this.queryProcessors();
        void this.startChainWatch();
        break;
      }
      case 'EnvironmentVariablesSet': {
        setStatus('envvars', 'done');
        break;
      }
    }
    this.pushDeploy();
  }

  endDeploy(result: 'ok' | 'error', message?: string) {
    if (!this._deploy) return;
    this._deploy.active = false;
    this._deploy.finishedAt = Date.now();
    this._deploy.result = result;
    this._deploy.errorMessage = message;
    if (result === 'error') {
      const active = this._deploy.stages.find((s) => s.status === 'active');
      if (active) active.status = 'error';
      void this.stopChainWatch();
    }
    this.pushDeploy();
  }

  private pushDeploy() {
    this.post({ type: 'deploy.state', state: this._deploy });
  }

  private async queryProcessors() {
    const d = this._deploy;
    if (!d || !d.jobIds.length) return;
    const network = (d.network ?? 'mainnet') as AcurastNetwork;
    d.processors = { status: 'loading', list: d.processors?.list };
    this.pushDeploy();
    try {
      const svc = await acurastClient.service(network);
      if (!svc.api) throw new Error('SDK service has no api after connect');
      const all: ProcessorInfo[] = [];
      for (const j of d.jobIds) {
        const chainJobId: [{ acurast: string }, number] = [{ acurast: j.origin }, j.localId];
        const infos = await getAcknowledgedProcessors(svc.api, chainJobId);
        for (const info of infos) {
          all.push({
            address: info.processor,
            slot: info.assignment.slot,
            startDelay: info.assignment.startDelay,
            feePerExecution: info.assignment.feePerExecution?.toString(),
            acknowledged: info.assignment.acknowledged,
            slaTotal: info.assignment.sla?.total?.toString(),
            slaMet: info.assignment.sla?.met?.toString(),
            pubKeys: flattenPubKeys(info.assignment.pubKeys),
          });
        }
      }
      d.processors = { status: 'ok', list: all, fetchedAt: Date.now() };
    } catch (err: unknown) {
      d.processors = { status: 'error', message: (err as Error).message, fetchedAt: Date.now() };
    }
    this.pushDeploy();
  }

  private async startChainWatch() {
    const d = this._deploy;
    if (!d || !d.jobIds.length) return;
    await this.stopChainWatch();
    const token = ++this._chainWatchToken;
    const network = (d.network ?? 'mainnet') as AcurastNetwork;

    const targets = new Map<number, string>(d.jobIds.map((j) => [j.localId, j.origin]));
    const seen = new Set<string>();

    try {
      const svc = await acurastClient.service(network);
      if (token !== this._chainWatchToken) return;

      const onEvent = (entry: ChainEvent) => {
        if (token !== this._chainWatchToken) return;
        if (!this._deploy) return;
        // De-dupe at the event-data level so re-fired events on different blocks don't spam.
        const dedupeKey = `${entry.section}.${entry.method}.${entry.jobLocalId ?? ''}.${entry.summary}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        this._deploy.chainEvents.push(entry);
        this.pushDeploy();
      };

      this._chainEventUnsub = await svc.subscribeToEvent({
        filter: (event) => event.section === 'acurast' || event.section === 'acurastMarketplace',
        map: (event) => {
          const dataJson = event.data?.toJSON?.() as unknown;
          let jobLocalId: number | undefined;
          if (Array.isArray(dataJson) && dataJson.length > 0) {
            try {
              const id = jobIdFromChainJson(dataJson[0]);
              if (id && targets.has(id[1])) jobLocalId = id[1];
            } catch { /* not a JobId — ignore */ }
          }
          return {
            ts: Date.now(),
            section: event.section,
            method: event.method,
            jobLocalId,
            summary: safeStringifyShort(dataJson),
            kind: classifyEvent(event.method),
          } satisfies ChainEvent;
        },
        sub: (entry) => {
          if (entry.jobLocalId === undefined) return; // not one of ours
          onEvent(entry);
        },
      });

      if (this._deploy) {
        this._deploy.watching = true;
        this.pushDeploy();
      }
    } catch (err: unknown) {
      // Best-effort; don't crash the panel if the subscription can't start.
      if (this._deploy) {
        this._deploy.watching = false;
        this.pushDeploy();
      }
      console.warn('Acurast chain watch failed to start:', (err as Error).message);
    }
  }

  dispose() {
    void this.stopChainWatch();
    this.stopBalancePoll();
  }

  private async stopChainWatch() {
    this._chainWatchToken++;
    if (this._chainEventUnsub) {
      try { this._chainEventUnsub(); } catch { /* ignore */ }
      this._chainEventUnsub = undefined;
    }
    if (this._deploy) {
      this._deploy.watching = false;
    }
  }

  private async deregisterDeployment(origin: string, localId: number) {
    const d = this._deploy;
    if (!d) return;
    const target = d.jobIds.find((j) => j.origin === origin && j.localId === localId);
    if (!target) return;
    if (target.deregistering || target.deregistered) return;

    const confirm = await vscode.window.showWarningMessage(
      `Deregister deployment ${localId}?`,
      { modal: true, detail: `This cancels the job on-chain. It cannot be undone.\n\nOrigin: ${origin}\nNetwork: ${d.network ?? 'mainnet'}` },
      'Deregister'
    );
    if (confirm !== 'Deregister') return;

    const activeWallet = await this.wallet.getActive();
    if (!activeWallet) {
      vscode.window.showErrorMessage('No active wallet. Set one as active to sign the deregister tx.');
      return;
    }
    if (activeWallet.address !== origin) {
      const proceed = await vscode.window.showWarningMessage(
        'Active wallet does not match the deployment origin. The chain will reject the tx.',
        { modal: true, detail: `Origin: ${origin}\nActive wallet: ${activeWallet.address}` },
        'Try anyway'
      );
      if (proceed !== 'Try anyway') return;
    }

    const password = await vscode.window.showInputBox({
      prompt: `Enter password for "${activeWallet.name}" to sign deregister`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;

    let mnemonic: string;
    try {
      mnemonic = await this.wallet.reveal(activeWallet.id, password);
    } catch (err: unknown) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }

    target.deregistering = true;
    target.deregisterError = undefined;
    this.pushDeploy();

    try {
      const network = (d.network ?? 'mainnet') as AcurastNetwork;
      const svc = await acurastClient.service(network);
      const keypair = await walletFromMnemonic(mnemonic);
      const hash = await svc.deregisterJob(keypair, localId);
      const txHash = hash.toHex();
      target.deregistering = false;
      target.deregistered = true;
      target.deregisterTxHash = txHash;
      vscode.window.showInformationMessage(`Deregistered deployment ${localId}`);
      this.pushDeploy();
      void this.queryProcessors();
      if (d.jobIds.every((j) => j.deregistered)) {
        await this.stopChainWatch();
        this.pushDeploy();
      }
    } catch (err: unknown) {
      const msg = (err as Error).message;
      target.deregistering = false;
      target.deregisterError = msg;
      vscode.window.showErrorMessage(`Deregister failed: ${msg}`);
      this.pushDeploy();
    }
  }

  private async saveConfigPatch(projectKey: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.ctx.configPath) return;
    const uri = vscode.Uri.file(this.ctx.configPath);
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(new TextDecoder('utf-8').decode(data)) as {
        projects?: Record<string, Record<string, unknown>>;
      };
      if (!json.projects || !json.projects[projectKey]) {
        vscode.window.showErrorMessage(`Project "${projectKey}" not found in acurast.json`);
        return;
      }
      json.projects[projectKey] = { ...json.projects[projectKey], ...patch };
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n')
      );
      vscode.window.showInformationMessage('Updated acurast.json');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Save failed: ${(err as Error).message}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>Acurast Studio</title>
<style>
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 0 8px 12px;
    margin: 0;
  }

  /* Topbar with back button */
  .topbar {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 0;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    margin: -2px 0 8px;
  }
  .topbar .title-icon {
    width: 16px; height: 16px;
    color: var(--vscode-descriptionForeground);
    display: inline-flex; align-items: center; justify-content: center;
  }
  .topbar .title-icon svg { width: 16px; height: 16px; }
  .topbar h2 { font-size: 12px; margin: 0; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); }

  /* Home */
  .hero {
    padding: 14px 4px 6px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
  }
  .hero svg { width: 36px; height: 36px; opacity: 0.7; }
  .hero h1 { font-size: 14px; margin: 8px 0 4px; color: var(--vscode-foreground); }
  .hero p { font-size: 12px; margin: 0; line-height: 1.4; }

  .nav-grid { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; }
  .nav-card {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    cursor: pointer;
    text-align: left;
    width: 100%;
    font: inherit;
    color: var(--vscode-foreground);
  }
  .nav-card:hover {
    background: var(--vscode-list-hoverBackground);
    border-color: var(--vscode-focusBorder);
  }
  .nav-card:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .nav-card:disabled:hover { background: var(--vscode-editor-background); border-color: var(--vscode-panel-border, transparent); }
  .nav-card .icon {
    width: 22px; height: 22px; display: flex; align-items: center; justify-content: center;
    color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .nav-card .icon svg { width: 18px; height: 18px; }
  .nav-card .body { flex: 1; min-width: 0; }
  .nav-card .title { font-size: 13px; font-weight: 600; }
  .nav-card .sub { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .nav-card .chev { color: var(--vscode-descriptionForeground); opacity: 0.6; }
  .nav-card .chev svg { width: 12px; height: 12px; }
  .badge {
    display: inline-block;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-left: 6px;
    vertical-align: middle;
  }

  /* Inputs / buttons */
  button {
    padding: 4px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; border-radius: 2px; cursor: pointer;
    font-family: inherit; font-size: inherit;
  }
  button:hover { background: var(--vscode-button-hoverBackground); }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.full { width: 100%; margin-bottom: 6px; }
  button.with-icon { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
  button.with-icon svg { width: 12px; height: 12px; }
  select, input[type="text"], input[type="number"], textarea {
    width: 100%; padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px; font-family: inherit; font-size: inherit;
    box-sizing: border-box;
  }
  select:focus, input:focus, textarea:focus { outline: 1px solid var(--vscode-focusBorder); border-color: var(--vscode-focusBorder); }

  /* Wallets list */
  .toolbar { display: flex; gap: 6px; margin: 0 0 8px; }
  .wallet-card {
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    padding: 10px;
    margin: 6px 0;
    background: var(--vscode-editor-background);
  }
  .wallet-card.active {
    border-color: var(--vscode-focusBorder);
    background: var(--vscode-textBlockQuote-background);
  }
  .wallet-card-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
  .wallet-card-head .name { flex: 1; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .active-badge {
    font-size: 9px; padding: 2px 5px;
    background: var(--vscode-focusBorder); color: var(--vscode-button-foreground);
    border-radius: 2px; text-transform: uppercase; letter-spacing: 0.05em;
  }
  .description { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 6px; font-style: italic; word-break: break-word; }
  .address {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    padding: 4px 6px; background: var(--vscode-input-background);
    border-radius: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-bottom: 6px;
  }
  .balance-row { display: flex; align-items: center; gap: 6px; margin: 6px 0; padding: 6px 8px; background: var(--vscode-input-background); border-radius: 2px; }
  .balance-value { flex: 1; font-size: 14px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .balance-value.muted { color: var(--vscode-descriptionForeground); font-style: italic; font-weight: normal; font-size: 11px; }
  .balance-value.error { color: var(--vscode-errorForeground); font-size: 11px; font-weight: normal; }
  .balance-network { font-size: 9px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.05em; }
  .actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
  .actions button { padding: 3px 8px; font-size: 11px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, transparent); }
  .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .actions button.danger { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .actions button.danger:hover { background: var(--vscode-inputValidation-errorBackground); }
  .actions button.icon-action {
    padding: 3px 6px;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .actions button.icon-action svg { width: 12px; height: 12px; }
  .icon-btn { padding: 2px 4px !important; display: inline-flex; align-items: center; }
  .icon-btn svg { width: 12px; height: 12px; }

  /* Settings form */
  .field { margin-bottom: 10px; }
  .field label { display: block; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); margin-bottom: 3px; }
  .field .hint { font-size: 10px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .section { margin: 12px 0; }
  .section-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); font-weight: 600; border-bottom: 1px solid var(--vscode-panel-border, transparent); padding-bottom: 4px; margin-bottom: 8px; }
  .section-title.dirty::after { content: '●'; color: var(--vscode-charts-yellow, orange); margin-left: 6px; }
  .checkbox-field { display: flex; align-items: center; gap: 6px; }
  .checkbox-field input { width: auto; }
  .save-bar { position: sticky; bottom: 0; background: var(--vscode-sideBar-background); padding: 8px 0; border-top: 1px solid var(--vscode-panel-border, transparent); display: flex; gap: 6px; margin-top: 12px; }
  .save-bar button { flex: 1; }
  .active-config {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px;
    margin: 4px 0 8px;
    background: var(--vscode-input-background);
    border-radius: 2px;
    font-size: 11px;
  }
  .active-config-label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); flex-shrink: 0; }
  .active-config-path {
    flex: 1; min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    color: var(--vscode-foreground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .active-config-switch {
    padding: 2px 6px; font-size: 10px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .active-config-switch:hover { background: var(--vscode-toolbar-hoverBackground); }

  .empty { padding: 16px 4px; color: var(--vscode-descriptionForeground); }

  /* Deploy */
  .dep-head {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; margin: 0 0 10px;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
  }
  .dep-head .proj { flex: 1; min-width: 0; }
  .dep-head .proj-name { font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .dep-head .proj-meta { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .dep-status {
    font-size: 10px; padding: 2px 6px; border-radius: 2px;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .dep-status.running { background: var(--vscode-statusBarItem-prominentBackground, var(--vscode-badge-background)); color: var(--vscode-badge-foreground); }
  .dep-status.ok      { background: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); color: var(--vscode-editor-background); }
  .dep-status.err     { background: var(--vscode-errorForeground); color: var(--vscode-editor-background); }
  .dep-status.idle    { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  .stages { list-style: none; padding: 0; margin: 0 0 12px; }
  .stage {
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 10px;
    border-left: 2px solid var(--vscode-panel-border, transparent);
    position: relative;
  }
  .stage + .stage { margin-top: 2px; }
  .stage .dot {
    width: 14px; height: 14px; border-radius: 50%;
    flex-shrink: 0; margin-top: 2px;
    border: 2px solid var(--vscode-descriptionForeground);
    background: transparent;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 9px; color: var(--vscode-editor-background);
  }
  .stage.pending .dot { opacity: 0.5; }
  .stage.active  .dot {
    border-color: var(--vscode-progressBar-background, var(--vscode-focusBorder));
    background: var(--vscode-progressBar-background, var(--vscode-focusBorder));
    animation: pulse 1.2s ease-in-out infinite;
  }
  .stage.done .dot {
    border-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }
  .stage.done .dot::after { content: '✓'; font-weight: 700; }
  .stage.error .dot {
    border-color: var(--vscode-errorForeground);
    background: var(--vscode-errorForeground);
  }
  .stage.error .dot::after { content: '!'; font-weight: 700; }
  .stage .body { flex: 1; min-width: 0; }
  .stage .label { font-size: 12px; font-weight: 500; }
  .stage.pending .label { color: var(--vscode-descriptionForeground); }
  .stage .detail {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    margin-top: 2px; word-break: break-all;
  }
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 var(--vscode-progressBar-background, var(--vscode-focusBorder)); opacity: 1; }
    50%      { box-shadow: 0 0 0 4px transparent; opacity: 0.6; }
  }

  /* Deployment ID card */
  .dep-id {
    padding: 10px 12px; margin: 0 0 10px;
    background: var(--vscode-textBlockQuote-background);
    border: 1px solid var(--vscode-focusBorder);
    border-radius: 4px;
  }
  .dep-id .label { font-size: 9px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
  .dep-id .id-row { display: flex; align-items: baseline; gap: 8px; }
  .dep-id .id-num {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums;
    color: var(--vscode-foreground);
  }
  .dep-id .id-origin {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    flex: 1; min-width: 0;
  }
  .dep-id .id-actions { display: flex; gap: 4px; margin-top: 8px; }
  .dep-id .id-actions button { padding: 3px 8px; font-size: 11px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, transparent); }
  .dep-id .id-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .dep-id + .dep-id { margin-top: -6px; }
  .dep-id.deregistered { opacity: 0.7; border-color: var(--vscode-panel-border, transparent); background: var(--vscode-editor-background); }
  .dep-id .dereg-badge {
    display: inline-block; margin-left: 8px;
    font-size: 9px; padding: 1px 6px; border-radius: 2px;
    background: var(--vscode-errorForeground); color: var(--vscode-editor-background);
    text-transform: uppercase; letter-spacing: 0.05em;
    vertical-align: middle;
  }
  .dep-id .id-actions button.danger { color: var(--vscode-errorForeground); border-color: var(--vscode-errorForeground); }
  .dep-id .id-actions button.danger:hover { background: var(--vscode-inputValidation-errorBackground); }
  .dep-id .dereg-error {
    margin-top: 6px;
    font-size: 10.5px; color: var(--vscode-errorForeground);
    word-break: break-word;
  }
  .dep-id .dereg-tx {
    margin-top: 6px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    word-break: break-all;
  }

  /* Processors list */
  .proc-section { margin-top: 10px; }
  .proc-head {
    display: flex; align-items: center; gap: 6px;
    margin: 0 0 6px;
  }
  .proc-head h3 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); flex: 1; }
  .proc-head button { padding: 2px 8px; font-size: 11px; background: transparent; color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border, transparent); }
  .proc-head button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .proc-card {
    padding: 8px 10px; margin: 4px 0;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    font-size: 11px;
  }
  .proc-addr {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; word-break: break-all;
    color: var(--vscode-foreground);
  }
  .proc-meta { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 4px; font-size: 10.5px; color: var(--vscode-descriptionForeground); }
  .proc-meta span b { color: var(--vscode-foreground); font-weight: 500; }
  .proc-ack    { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .proc-noack  { color: var(--vscode-descriptionForeground); }
  .proc-empty  { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
  .proc-loading { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; }
  .proc-error  { padding: 8px 10px; color: var(--vscode-errorForeground); font-size: 11px; }
  .proc-keys {
    margin-top: 6px; padding-top: 6px;
    border-top: 1px dashed var(--vscode-panel-border, transparent);
  }
  .proc-keys-label {
    font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground); margin-bottom: 4px;
  }
  .pk-row {
    display: flex; gap: 6px; align-items: center;
    padding: 3px 0;
  }
  .pk-curve {
    flex-shrink: 0;
    font-size: 9px; font-weight: 600;
    padding: 1px 5px; border-radius: 2px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  .pk-key {
    flex: 1; min-width: 0;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .pk-copy {
    padding: 1px 6px !important; font-size: 9px !important;
    background: transparent; color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .pk-copy:hover { background: var(--vscode-toolbar-hoverBackground); }

  /* Lifecycle (chain events) */
  .lc-section { margin-top: 10px; }
  .lc-head {
    display: flex; align-items: center; gap: 6px;
    margin: 0 0 6px;
  }
  .lc-head h3 { margin: 0; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--vscode-descriptionForeground); flex: 1; }
  .lc-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    box-shadow: 0 0 0 0 currentColor;
    animation: pulse 1.4s ease-in-out infinite;
  }
  .lc-dot.off { background: var(--vscode-descriptionForeground); animation: none; }
  .lc-list { list-style: none; padding: 0; margin: 0; }
  .lc-row {
    display: flex; gap: 8px; align-items: baseline;
    padding: 6px 10px;
    border-left: 2px solid var(--vscode-panel-border, transparent);
    font-size: 11px;
  }
  .lc-row + .lc-row { margin-top: 2px; }
  .lc-row .ts {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px; color: var(--vscode-descriptionForeground);
    flex-shrink: 0;
  }
  .lc-row .meth { font-weight: 600; }
  .lc-row .sec { font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 4px; }
  .lc-row .payload {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px; color: var(--vscode-descriptionForeground);
    word-break: break-all; margin-top: 2px;
  }
  .lc-row.started   { border-left-color: var(--vscode-progressBar-background, var(--vscode-focusBorder)); }
  .lc-row.reported  { border-left-color: var(--vscode-charts-blue, var(--vscode-focusBorder)); }
  .lc-row.finalized { border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
  .lc-empty { padding: 8px 10px; color: var(--vscode-descriptionForeground); font-size: 11px; font-style: italic; }

  .dep-error {
    padding: 8px 10px; margin: 0 0 10px;
    background: var(--vscode-inputValidation-errorBackground);
    border: 1px solid var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
    border-radius: 4px;
    font-size: 11px; color: var(--vscode-errorForeground);
    word-break: break-word;
  }

</style>
</head>
<body>
<div id="topbar"></div>
<div id="root"></div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const root = document.getElementById('root');
const topbar = document.getElementById('topbar');

let app = {
  route: 'home',
  ctx: { isAcurastProject: false, configPath: null, configRel: null },
  wallets: { list: [], activeId: null, network: 'mainnet', symbol: 'ACU', balance: null },
  config: { data: null, projectKey: null, draft: {}, dirty: false },
  deploy: null,
};

const ICONS = {
  wallet: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M22.0049 6.99979H23.0049V16.9998H22.0049V19.9998C22.0049 20.5521 21.5572 20.9998 21.0049 20.9998H3.00488C2.4526 20.9998 2.00488 20.5521 2.00488 19.9998V3.99979C2.00488 3.4475 2.4526 2.99979 3.00488 2.99979H21.0049C21.5572 2.99979 22.0049 3.4475 22.0049 3.99979V6.99979ZM20.0049 16.9998H14.0049C11.2435 16.9998 9.00488 14.7612 9.00488 11.9998C9.00488 9.23836 11.2435 6.99979 14.0049 6.99979H20.0049V4.99979H4.00488V18.9998H20.0049V16.9998ZM21.0049 14.9998V8.99979H14.0049C12.348 8.99979 11.0049 10.3429 11.0049 11.9998C11.0049 13.6566 12.348 14.9998 14.0049 14.9998H21.0049ZM14.0049 10.9998H17.0049V12.9998H14.0049V10.9998Z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9.95401 2.2106C11.2876 1.93144 12.6807 1.92263 14.0449 2.20785C14.2219 3.3674 14.9048 4.43892 15.9997 5.07103C17.0945 5.70313 18.364 5.75884 19.4566 5.3323C20.3858 6.37118 21.0747 7.58203 21.4997 8.87652C20.5852 9.60958 19.9997 10.736 19.9997 11.9992C19.9997 13.2632 20.5859 14.3902 21.5013 15.1232C21.29 15.7636 21.0104 16.3922 20.6599 16.9992C20.3094 17.6063 19.9049 18.1627 19.4559 18.6659C18.3634 18.2396 17.0943 18.2955 15.9997 18.9274C14.9057 19.559 14.223 20.6294 14.0453 21.7879C12.7118 22.067 11.3187 22.0758 9.95443 21.7906C9.77748 20.6311 9.09451 19.5595 7.99967 18.9274C6.90484 18.2953 5.63539 18.2396 4.54272 18.6662C3.61357 17.6273 2.92466 16.4164 2.49964 15.1219C3.41412 14.3889 3.99968 13.2624 3.99968 11.9992C3.99968 10.7353 3.41344 9.60827 2.49805 8.87524C2.70933 8.23482 2.98894 7.60629 3.33942 6.99923C3.68991 6.39217 4.09443 5.83576 4.54341 5.33257C5.63593 5.75881 6.90507 5.703 7.99967 5.07103C9.09364 4.43942 9.7764 3.3691 9.95401 2.2106ZM11.9997 14.9992C13.6565 14.9992 14.9997 13.6561 14.9997 11.9992C14.9997 10.3424 13.6565 8.99923 11.9997 8.99923C10.3428 8.99923 8.99967 10.3424 8.99967 11.9992C8.99967 13.6561 10.3428 14.9992 11.9997 14.9992Z"/></svg>',
  deployments: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M20.59 12L13 19.59l-1.41-1.42L17.76 12l-6.17-6.17L13 4.41 20.59 12z"/><path d="M11 12L3.41 19.59 2 18.17 8.17 12 2 5.83 3.41 4.41 11 12z"/></svg>',
  logs: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 8v12.993A1 1 0 0 1 20.007 22H3.993A.993.993 0 0 1 3 21.008V2.992C3 2.455 3.449 2 4.002 2h10.995L21 8zm-2 1h-5V4H5v16h14V9zM8 7h3v2H8V7zm0 4h8v2H8v-2zm0 4h8v2H8v-2z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M5.46257 4.43262C7.21556 2.91255 9.5007 2 12 2C17.5228 2 22 6.47715 22 12C22 14.1361 21.3302 16.1158 20.1892 17.7406L17 12H20C20 7.58172 16.4183 4 12 4C9.84982 4 7.89777 4.84827 6.46023 6.22842L5.46257 4.43262ZM18.5374 19.5674C16.7844 21.0875 14.4993 22 12 22C6.47715 22 2 17.5228 2 12C2 9.86386 2.66979 7.88416 3.8108 6.25944L7 12H4C4 16.4183 7.58172 20 12 20C14.1502 20 16.1022 19.1517 17.5398 17.7716L18.5374 19.5674Z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M13.1714 12.0007L8.22168 7.05093L9.63589 5.63672L15.9999 12.0007L9.63589 18.3646L8.22168 16.9504L13.1714 12.0007Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V9.48907C3 9.18048 3.14247 8.88917 3.38606 8.69972L11.3861 2.47749C11.7472 2.19663 12.2528 2.19663 12.6139 2.47749L20.6139 8.69972C20.8575 8.88917 21 9.18048 21 9.48907V20ZM7 15V17H17V15H7Z"/></svg>',
  home: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 20C21 20.5523 20.5523 21 20 21H4C3.44772 21 3 20.5523 3 20V9.48907C3 9.18048 3.14247 8.88917 3.38606 8.69972L11.3861 2.47749C11.7472 2.19663 12.2528 2.19663 12.6139 2.47749L20.6139 8.69972C20.8575 8.88917 21 9.18048 21 9.48907V20ZM7 15V17H17V15H7Z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M17 6H22V8H20V21C20 21.5523 19.5523 22 19 22H5C4.44772 22 4 21.5523 4 21V8H2V6H7V3C7 2.44772 7.44772 2 8 2H16C16.5523 2 17 2.44772 17 3V6ZM18 8H6V20H18V8ZM13.4142 13.9997L15.182 15.7675L13.7678 17.1817L12 15.4139L10.2322 17.1817L8.81802 15.7675L10.5858 13.9997L8.81802 12.232L10.2322 10.8178L12 12.5855L13.7678 10.8178L15.182 12.232L13.4142 13.9997ZM9 4V6H15V4H9Z"/></svg>',
  importIcon: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 3H3C2.44772 3 2 3.44772 2 4V20C2 20.5523 2.44772 21 3 21H21C21.5523 21 22 20.5523 22 20V4C22 3.44772 21.5523 3 21 3ZM12 16C10.3431 16 9 14.6569 9 13H4V5H20V13H15C15 14.6569 13.6569 16 12 16ZM16 9H13V6H11V9H8L12 13.5L16 9Z"/></svg>',
};

function escHtml(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]); }

function navigate(route) {
  app.route = route;
  vscode.postMessage({ type: 'navigate', route });
  render();
}

function send(type, extra) { vscode.postMessage(Object.assign({ type }, extra || {})); }

function renderTopbar() {
  if (app.route === 'home') { topbar.innerHTML = ''; return; }
  const titles = { wallets: 'Wallets', settings: 'Project Settings', deploy: 'Deployment' };
  const titleIcons = { wallets: ICONS.wallet, settings: ICONS.settings, deploy: ICONS.deployments };
  topbar.innerHTML = '<div class="topbar"><span class="title-icon">' + (titleIcons[app.route] || '') + '</span><h2>' + titles[app.route] + '</h2></div>';
}

/* ---- HOME ---- */
function renderHome() {
  const walletCount = app.wallets.list.length;
  const walletSub = walletCount
    ? walletCount + ' wallet' + (walletCount === 1 ? '' : 's') + (app.wallets.activeId ? ' • active set' : '')
    : 'Create or import to begin';
  const projectDisabled = !app.ctx.isAcurastProject;
  const projectSub = projectDisabled
    ? 'No acurast.json selected'
    : (app.ctx.configRel || 'acurast.json');

  root.innerHTML = '' +
    '<div class="hero">' +
      '<div>' + ICONS.home + '</div>' +
      '<h1>Acurast Studio</h1>' +
      '<p>Wallets, project config, and deployments in one place.</p>' +
    '</div>' +
    '<div class="nav-grid">' +
      navCard('wallets', ICONS.wallet, 'Wallets', walletSub, false) +
      navCard('settings', ICONS.settings, 'Project Settings', projectSub, projectDisabled) +
      navCard('deploy', ICONS.deployments, 'Deployments', deploySub(), false) +
      navCard(null, ICONS.logs, 'Live Logs', 'Coming soon', true, 'Soon') +
    '</div>';

  root.querySelectorAll('[data-route]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.route));
  });
}

function navCard(route, icon, title, sub, disabled, badge) {
  const badgeHtml = badge ? '<span class="badge">' + badge + '</span>' : '';
  const dataAttr = route && !disabled ? ' data-route="' + route + '"' : '';
  return '<button class="nav-card"' + dataAttr + (disabled ? ' disabled' : '') + '>' +
    '<span class="icon">' + icon + '</span>' +
    '<div class="body"><div class="title">' + escHtml(title) + badgeHtml + '</div><div class="sub">' + escHtml(sub) + '</div></div>' +
    '<span class="chev">' + ICONS.chev + '</span>' +
  '</button>';
}

/* ---- WALLETS ---- */
function renderWallets() {
  const { list, activeId, network } = app.wallets;
  if (!list.length) {
    root.innerHTML = '' +
      '<div class="empty" style="text-align:center;">' +
        '<div style="margin: 12px 0; opacity:0.7;">' + ICONS.wallet + '</div>' +
        '<p>No wallets yet. Create or import one to deploy jobs on Acurast.</p>' +
        '<button class="full" data-walletact="create">Create New Wallet</button>' +
        '<button class="full secondary with-icon" data-walletact="import">' + ICONS.importIcon + 'Import Existing</button>' +
      '</div>';
  } else {
    const active = list.find(w => w.id === activeId);
    const others = list.filter(w => w.id !== activeId);
    const ordered = active ? [active, ...others] : list;
    root.innerHTML = '' +
      '<div class="toolbar">' +
        '<button data-walletact="create">+ New</button>' +
        '<button class="secondary with-icon" data-walletact="import">' + ICONS.importIcon + 'Import</button>' +
      '</div>' +
      ordered.map(w => walletCard(w, activeId, network)).join('');
  }
  bindWalletActions();
}

function walletCard(w, activeId, network) {
  const isActive = w.id === activeId;
  const short = w.address.slice(0, 8) + '…' + w.address.slice(-6);
  const desc = w.description ? '<div class="description">' + escHtml(w.description) + '</div>' : '';
  const badge = isActive ? '<span class="active-badge">Active</span>' : '';
  const balance = isActive
    ? '<div class="balance-row"><div class="balance-value muted" id="balance">…</div><div class="balance-network">' + escHtml(network || '') + '</div><button class="icon-btn" data-walletact="refreshBalance" title="Refresh">' + ICONS.refresh + '</button></div>'
    : '';
  const activateBtn = isActive ? '' : '<button data-walletact="setActive" data-id="' + w.id + '">Set Active</button>';
  return '<div class="wallet-card ' + (isActive ? 'active' : '') + '">' +
    '<div class="wallet-card-head"><div class="name">' + escHtml(w.name) + '</div>' + badge + '</div>' +
    desc +
    '<div class="address" title="' + escHtml(w.address) + '">' + escHtml(short) + '</div>' +
    balance +
    '<div class="actions">' +
      activateBtn +
      '<button data-walletact="copyAddress" data-id="' + w.id + '">Copy</button>' +
      '<button data-walletact="rename" data-id="' + w.id + '">Rename</button>' +
      '<button data-walletact="editDescription" data-id="' + w.id + '">Edit Desc</button>' +
      '<button data-walletact="reveal" data-id="' + w.id + '">Reveal</button>' +
      '<button class="danger icon-action" data-walletact="delete" data-id="' + w.id + '" title="Delete wallet">' + ICONS.trash + '</button>' +
    '</div>' +
  '</div>';
}

function bindWalletActions() {
  root.querySelectorAll('[data-walletact]').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.walletact;
      if (action === 'refreshBalance') { send('refreshBalance'); return; }
      send('wallet', { action, id: el.dataset.id });
    });
  });
}

function renderBalance(msg) {
  const el = document.getElementById('balance');
  if (!el) return;
  el.className = 'balance-value';
  if (msg.status === 'loading') { el.textContent = 'Loading…'; el.classList.add('muted'); }
  else if (msg.status === 'ok') { el.textContent = msg.value.toFixed(4) + ' ' + msg.symbol; }
  else { el.textContent = msg.message || 'Failed'; el.classList.add('error'); }
}

/* ---- SETTINGS ---- */
function readDraft(key, fallback) {
  return key in app.config.draft ? app.config.draft[key] : fallback;
}
function patchField(key, value) { app.config.draft[key] = value; app.config.dirty = true; updateDirtyUI(); }
function updateDirtyUI() {
  document.querySelectorAll('.section-title').forEach(el => el.classList.toggle('dirty', app.config.dirty));
  document.querySelectorAll('[data-save],[data-discard]').forEach(b => { b.disabled = !app.config.dirty; });
}
function settingsField(label, key, value, type, hint) {
  const id = 'fld_' + key.replace(/\\W/g, '_');
  const v = readDraft(key, value);
  let input;
  if (type === 'number') input = '<input type="number" id="' + id + '" data-bind="' + key + '" data-type="number" value="' + (v ?? '') + '">';
  else if (type === 'checkbox') input = '<div class="checkbox-field"><input type="checkbox" id="' + id + '" data-bind="' + key + '" data-type="checkbox" ' + (v ? 'checked' : '') + '><label for="' + id + '" style="margin:0;text-transform:none;letter-spacing:0;">enabled</label></div>';
  else input = '<input type="text" id="' + id + '" data-bind="' + key + '" data-type="text" value="' + escHtml(String(v ?? '')) + '">';
  const hintEl = hint ? '<div class="hint">' + hint + '</div>' : '';
  return '<div class="field"><label for="' + id + '">' + label + '</label>' + input + hintEl + '</div>';
}
function settingsSelect(label, key, value, options, hint) {
  const id = 'fld_' + key.replace(/\\W/g, '_');
  const v = readDraft(key, value);
  const opts = options.map(o => '<option value="' + o + '"' + (o === v ? ' selected' : '') + '>' + o + '</option>').join('');
  const hintEl = hint ? '<div class="hint">' + hint + '</div>' : '';
  return '<div class="field"><label for="' + id + '">' + label + '</label><select id="' + id + '" data-bind="' + key + '" data-type="text">' + opts + '</select>' + hintEl + '</div>';
}
function readSettingsField(key, type) {
  const el = document.getElementById('fld_' + key.replace(/\\W/g, '_'));
  if (!el) return undefined;
  if (type === 'number') {
    if (el.value === '') return null;
    const n = Number(el.value);
    return isNaN(n) ? null : n;
  }
  if (type === 'checkbox') return el.checked;
  return el.value;
}
function bindSettingsInputs() {
  root.querySelectorAll('[data-bind]').forEach(el => {
    const key = el.dataset.bind;
    const type = el.dataset.type || 'text';
    const evt = (type === 'checkbox' || el.tagName === 'SELECT') ? 'change' : 'input';
    el.addEventListener(evt, () => patchField(key, readSettingsField(key, type)));
  });
}
function buildPatch() {
  const draft = app.config.draft;
  const project = app.config.data.projects[app.config.projectKey];
  const patch = {};
  for (const [k, v] of Object.entries(draft)) {
    if (k === 'includeEnvironmentVariables' && typeof v === 'string') {
      patch[k] = v.split(',').map(s => s.trim()).filter(Boolean);
      continue;
    }
    if (k.includes('.')) {
      const [head, tail] = k.split('.');
      patch[head] = patch[head] || {};
      patch[head][tail] = v;
    } else {
      patch[k] = v;
    }
  }
  for (const k of Object.keys(patch)) {
    if (typeof patch[k] === 'object' && !Array.isArray(patch[k]) && project[k] && typeof project[k] === 'object') {
      patch[k] = Object.assign({}, project[k], patch[k]);
    }
  }
  return patch;
}

function renderSettings() {
  if (!app.config.data) {
    root.innerHTML = '<div class="empty"><p>No active <code>acurast.json</code>.</p><button class="full" data-cfgact="choose">Choose acurast.json…</button></div>';
    bindConfigToolbar();
    return;
  }
  const projects = app.config.data.projects || {};
  const keys = Object.keys(projects);
  if (!keys.length) {
    root.innerHTML = '<div class="empty"><p>No projects in acurast.json.</p></div>';
    return;
  }
  if (!app.config.projectKey || !projects[app.config.projectKey]) {
    app.config.projectKey = keys[0];
    app.config.draft = {};
    app.config.dirty = false;
  }
  const p = projects[app.config.projectKey];
  const pickerOpts = keys.map(k => '<option value="' + escHtml(k) + '"' + (k === app.config.projectKey ? ' selected' : '') + '>' + escHtml(k) + '</option>').join('');
  const envVars = readDraft('includeEnvironmentVariables', (p.includeEnvironmentVariables || []).join(','));

  const activePath = app.ctx.configRel || 'acurast.json';
  root.innerHTML = '' +
    '<div class="active-config" title="' + escHtml(app.ctx.configPath || '') + '">' +
      '<span class="active-config-label">FILE</span>' +
      '<code class="active-config-path">' + escHtml(activePath) + '</code>' +
      '<button class="active-config-switch" data-cfgact="choose" title="Switch acurast.json">Switch</button>' +
    '</div>' +
    '<div class="toolbar"><button class="secondary" data-cfgact="openJson">Open acurast.json</button></div>' +
    '<div class="field"><label>Project</label><select id="projectPicker">' + pickerOpts + '</select></div>' +
    '<div class="section"><div class="section-title">Identity</div>' +
      settingsField('Project Name', 'projectName', p.projectName, 'text') +
      settingsSelect('Network', 'network', p.network || 'mainnet', ['mainnet','canary']) +
      settingsField('File URL', 'fileUrl', p.fileUrl, 'text', 'Path to the bundled file (e.g. dist/bundle.js)') +
    '</div>' +
    '<div class="section"><div class="section-title">Runtime</div>' +
      settingsSelect('Runtime', 'runtime', p.runtime || 'NodeJSWithBundle', ['NodeJSWithBundle','NodeJS','Shell']) +
      settingsField('Only attested devices', 'onlyAttestedDevices', p.onlyAttestedDevices, 'checkbox') +
      settingsField('Enable DevTools', 'enableDevtools', p.enableDevtools, 'checkbox') +
    '</div>' +
    '<div class="section"><div class="section-title">Execution</div>' +
      settingsSelect('Type', 'execution.type', (p.execution && p.execution.type) || 'onetime', ['onetime','interval']) +
      settingsField('Max execution time (ms)', 'execution.maxExecutionTimeInMs', (p.execution && p.execution.maxExecutionTimeInMs) ?? 10000, 'number') +
      settingsField('Max start delay (ms)', 'maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs ?? 10000, 'number') +
    '</div>' +
    '<div class="section"><div class="section-title">Scaling &amp; Cost</div>' +
      settingsField('Replicas', 'numberOfReplicas', p.numberOfReplicas ?? 1, 'number') +
      settingsField('Max cost per execution', 'maxCostPerExecution', p.maxCostPerExecution ?? 0, 'number', 'Planck units of ACU/cACU (1 ACU = 1e12 planck)') +
      settingsField('Min processor reputation', 'minProcessorReputation', p.minProcessorReputation ?? 0, 'number') +
    '</div>' +
    '<div class="section"><div class="section-title">Advanced</div>' +
      settingsSelect('Mutability', 'mutability', p.mutability || 'Immutable', ['Immutable','Mutable']) +
      settingsField('Include env vars (comma-separated)', 'includeEnvironmentVariables', envVars, 'text', 'Reads from .env at deploy time') +
    '</div>' +
    '<div class="save-bar">' +
      '<button data-save data-cfgact="save" disabled>Save Changes</button>' +
      '<button class="secondary" data-discard data-cfgact="discard" disabled>Discard</button>' +
    '</div>';

  document.getElementById('projectPicker').addEventListener('change', (e) => {
    if (app.config.dirty && !confirm('Discard unsaved changes?')) { e.target.value = app.config.projectKey; return; }
    app.config.projectKey = e.target.value;
    app.config.draft = {};
    app.config.dirty = false;
    renderSettings();
  });

  bindConfigToolbar();
  bindSettingsInputs();
}

function bindConfigToolbar() {
  root.querySelectorAll('[data-cfgact]').forEach(el => {
    el.addEventListener('click', () => {
      const act = el.dataset.cfgact;
      if (act === 'openJson') send('config.openJson');
      else if (act === 'choose') send('config.choose');
      else if (act === 'save') {
        if (!app.config.dirty) return;
        send('config.save', { projectKey: app.config.projectKey, patch: buildPatch() });
      } else if (act === 'discard') {
        app.config.draft = {};
        app.config.dirty = false;
        renderSettings();
      }
    });
  });
}

/* ---- DEPLOY ---- */
function deploySub() {
  const d = app.deploy;
  if (!d) return 'No deployments yet';
  if (d.active) {
    const stage = (d.stages || []).find(s => s.status === 'active');
    return stage ? 'Running · ' + stage.label : 'Running';
  }
  if (d.result === 'ok')    return 'Last deploy succeeded' + (d.project ? ' · ' + d.project : '');
  if (d.result === 'error') return 'Last deploy failed';
  return 'Idle';
}

function depStatusBadge(d) {
  if (d.active)            return '<span class="dep-status running">Running</span>';
  if (d.result === 'ok')   return '<span class="dep-status ok">Success</span>';
  if (d.result === 'error') return '<span class="dep-status err">Failed</span>';
  return '<span class="dep-status idle">Idle</span>';
}

function fmtTimeShort(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

function renderStageList(stages) {
  return '<ul class="stages">' + stages.map(s => (
    '<li class="stage ' + s.status + '">' +
      '<span class="dot"></span>' +
      '<div class="body">' +
        '<div class="label">' + escHtml(s.label) + '</div>' +
        (s.detail ? '<div class="detail">' + escHtml(s.detail) + '</div>' : '') +
      '</div>' +
    '</li>'
  )).join('') + '</ul>';
}

function renderDeploy() {
  const d = app.deploy;
  if (!d) {
    root.innerHTML = '' +
      '<div class="empty" style="text-align:center;">' +
        '<div style="margin: 12px 0; opacity:0.7;">' + ICONS.deployments + '</div>' +
        '<p>No active deployment.</p>' +
        (app.ctx.isAcurastProject
          ? '<button class="full" data-depact="start">Deploy now</button>'
          : '<p style="font-size:11px;">Select an <code>acurast.json</code> from Project Settings to enable deploy.</p>') +
      '</div>';
    bindDeployActions();
    return;
  }

  const headMeta = (d.project ? escHtml(d.project) : 'Unknown project') +
    (d.network ? ' · ' + escHtml(d.network) : '');
  const errorHtml = d.errorMessage
    ? '<div class="dep-error">' + escHtml(d.errorMessage) + '</div>'
    : '';
  const footer = !d.active
    ? '<div class="toolbar" style="margin-top:10px;">' +
        '<button data-depact="start"' + (app.ctx.isAcurastProject ? '' : ' disabled') + '>' +
          (d.result === 'error' ? 'Retry deploy' : 'Deploy again') +
        '</button>' +
        '<button class="secondary" data-depact="openOutput">Open output</button>' +
      '</div>'
    : '<div class="toolbar" style="margin-top:10px;">' +
        '<button class="secondary" data-depact="openOutput">Open output</button>' +
      '</div>';

  root.innerHTML = '' +
    '<div class="dep-head">' +
      '<div class="proj">' +
        '<div class="proj-name">' + headMeta + '</div>' +
        '<div class="proj-meta" title="Times for the deploy flow (upload → register → ack → env vars). The job continues executing on processors after this.">' +
          'Started ' + escHtml(fmtTimeShort(d.startedAt)) +
          (d.finishedAt
            ? ' · ' + (d.result === 'error' ? 'failed' : 'registered') + ' ' + escHtml(fmtTimeShort(d.finishedAt))
            : '') +
        '</div>' +
      '</div>' +
      depStatusBadge(d) +
    '</div>' +
    errorHtml +
    renderJobIdCards(d) +
    renderStageList(d.stages || []) +
    renderProcessorsBlock(d) +
    renderLifecycleBlock(d) +
    footer;

  bindDeployActions();
}

function renderJobIdCards(d) {
  const ids = d.jobIds || [];
  if (!ids.length) return '';
  return ids.map((j) => {
    const badge = j.deregistered ? '<span class="dereg-badge">Deregistered</span>' : '';
    const deregLabel = j.deregistering ? 'Deregistering…' : (j.deregistered ? 'Deregistered' : 'Deregister');
    const deregBtn = j.deregistered
      ? ''
      : '<button class="danger" data-depact="deregister" data-origin="' + escHtml(j.origin) + '" data-id="' + escHtml(j.localId) + '"' + (j.deregistering ? ' disabled' : '') + '>' + escHtml(deregLabel) + '</button>';
    const txLine = j.deregisterTxHash
      ? '<div class="dereg-tx" title="' + escHtml(j.deregisterTxHash) + '">tx ' + escHtml(j.deregisterTxHash) + '</div>'
      : '';
    const errLine = j.deregisterError ? '<div class="dereg-error">' + escHtml(j.deregisterError) + '</div>' : '';
    return '<div class="dep-id ' + (j.deregistered ? 'deregistered' : '') + '">' +
      '<div class="label">Deployment ID' + badge + '</div>' +
      '<div class="id-row">' +
        '<div class="id-num">' + escHtml(j.localId) + '</div>' +
        '<div class="id-origin" title="' + escHtml(j.origin) + '">' + escHtml(j.origin) + '</div>' +
      '</div>' +
      '<div class="id-actions">' +
        '<button data-depact="copyId" data-id="' + escHtml(j.localId) + '">Copy ID</button>' +
        '<button data-depact="copyOrigin" data-origin="' + escHtml(j.origin) + '">Copy origin</button>' +
        deregBtn +
      '</div>' +
      txLine +
      errLine +
    '</div>';
  }).join('');
}

function renderProcessorsBlock(d) {
  if (!(d.jobIds || []).length) return '';
  const proc = d.processors || { status: 'idle' };
  let body = '';
  if (proc.status === 'idle')    body = '<div class="proc-empty">Click "Refresh" to query assigned processors.</div>';
  else if (proc.status === 'loading') body = '<div class="proc-loading">Querying chain…</div>';
  else if (proc.status === 'error')   body = '<div class="proc-error">' + escHtml(proc.message || 'Query failed') + '</div>';
  else if (proc.status === 'ok') {
    if (!proc.list || !proc.list.length) body = '<div class="proc-empty">No processors assigned yet.</div>';
    else body = proc.list.map(renderProcessorCard).join('');
  }
  const stamp = proc.fetchedAt ? ' · ' + escHtml(fmtTimeShort(proc.fetchedAt)) : '';
  return '<div class="proc-section">' +
    '<div class="proc-head">' +
      '<h3>Processors' + stamp + '</h3>' +
      '<button data-depact="queryProcessors"' + (proc.status === 'loading' ? ' disabled' : '') + '>Refresh</button>' +
    '</div>' +
    body +
  '</div>';
}

function renderLifecycleBlock(d) {
  if (!(d.jobIds || []).length) return '';
  const events = d.chainEvents || [];
  const watching = !!d.watching;
  const stamp = watching ? '<span class="lc-dot" title="Live"></span>' : '<span class="lc-dot off" title="Not watching"></span>';
  const headLabel = watching ? 'Live' : (events.length ? 'Stopped' : 'Idle');

  let body;
  if (!events.length) {
    body = '<div class="lc-empty">' + (watching ? 'Waiting for on-chain events…' : 'No on-chain events captured yet.') + '</div>';
  } else {
    body = '<ul class="lc-list">' + events.slice().reverse().map(e => (
      '<li class="lc-row ' + e.kind + '">' +
        '<span class="ts">' + escHtml(fmtTimeShort(e.ts)) + '</span>' +
        '<div style="flex:1; min-width:0;">' +
          '<span class="meth">' + escHtml(e.method) + '</span>' +
          '<span class="sec">' + escHtml(e.section) + (e.jobLocalId != null ? ' · job ' + escHtml(e.jobLocalId) : '') + '</span>' +
          (e.summary ? '<div class="payload">' + escHtml(e.summary) + '</div>' : '') +
        '</div>' +
      '</li>'
    )).join('') + '</ul>';
  }
  return '<div class="lc-section">' +
    '<div class="lc-head">' +
      stamp +
      '<h3>Lifecycle · ' + escHtml(headLabel) + ' · ' + events.length + '</h3>' +
    '</div>' +
    body +
  '</div>';
}

function renderProcessorCard(p) {
  const ack = p.acknowledged
    ? '<span class="proc-ack">✓ acknowledged</span>'
    : '<span class="proc-noack">pending ack</span>';
  const slot     = p.slot != null ? '<span>slot <b>' + escHtml(p.slot) + '</b></span>' : '';
  const fee      = p.feePerExecution != null ? '<span>fee <b>' + escHtml(p.feePerExecution) + '</b></span>' : '';
  const sla      = (p.slaTotal != null) ? '<span>SLA <b>' + escHtml(p.slaMet ?? '0') + '/' + escHtml(p.slaTotal) + '</b></span>' : '';
  const delay    = p.startDelay != null ? '<span>delay <b>' + escHtml(p.startDelay) + 'ms</b></span>' : '';
  const keys = Array.isArray(p.pubKeys) && p.pubKeys.length
    ? '<div class="proc-keys">' +
        '<div class="proc-keys-label">Public keys (for topup)</div>' +
        p.pubKeys.map(k => (
          '<div class="pk-row">' +
            '<span class="pk-curve">' + escHtml(k.curve) + '</span>' +
            '<span class="pk-key" title="' + escHtml(k.key) + '">' + escHtml(k.key) + '</span>' +
            '<button class="pk-copy" data-depact="copyKey" data-key="' + escHtml(k.key) + '">Copy</button>' +
          '</div>'
        )).join('') +
      '</div>'
    : '';
  return '<div class="proc-card">' +
    '<div class="proc-addr" title="' + escHtml(p.address) + '">' + escHtml(p.address) + '</div>' +
    '<div class="proc-meta">' + ack + slot + fee + sla + delay + '</div>' +
    keys +
  '</div>';
}

function bindDeployActions() {
  root.querySelectorAll('[data-depact]').forEach(el => {
    el.addEventListener('click', () => {
      const act = el.dataset.depact;
      if (act === 'start') send('deploy.start');
      else if (act === 'openOutput') send('deploy.openOutput');
      else if (act === 'queryProcessors') send('deploy.queryProcessors');
      else if (act === 'copyId') send('deploy.copy', { text: el.dataset.id });
      else if (act === 'copyOrigin') send('deploy.copy', { text: el.dataset.origin });
      else if (act === 'copyKey') send('deploy.copy', { text: el.dataset.key });
      else if (act === 'deregister') send('deploy.deregister', { origin: el.dataset.origin, localId: Number(el.dataset.id) });
    });
  });
}

/* ---- Render dispatch ---- */
function render() {
  renderTopbar();
  if (app.route === 'home') renderHome();
  else if (app.route === 'wallets') renderWallets();
  else if (app.route === 'settings') renderSettings();
  else if (app.route === 'deploy') renderDeploy();
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'route':
      app.route = msg.route;
      render();
      break;
    case 'context':
      app.ctx.isAcurastProject = msg.isAcurastProject;
      app.ctx.configPath = msg.configPath;
      app.ctx.configRel = msg.configRel;
      if (app.route === 'home') renderHome();
      else if (app.route === 'settings') renderSettings();
      break;
    case 'wallets.state':
      app.wallets.list = msg.wallets;
      app.wallets.activeId = msg.activeId;
      app.wallets.network = msg.network;
      app.wallets.symbol = msg.symbol;
      if (app.route === 'wallets' || app.route === 'home') render();
      break;
    case 'wallets.balance':
      if (app.route === 'wallets') renderBalance(msg);
      break;
    case 'config.state':
      app.config.data = msg.config;
      app.config.draft = {};
      app.config.dirty = false;
      if (app.route === 'settings') renderSettings();
      break;
    case 'deploy.state':
      app.deploy = msg.state;
      if (app.route === 'deploy' || app.route === 'home') render();
      break;
  }
});

vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
  }
}

function safeStringifyShort(v: unknown, max = 160): string {
  let s: string;
  try { s = JSON.stringify(v); }
  catch { s = String(v); }
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function flattenPubKeys(raw: unknown): ProcessorPubKey[] {
  if (!Array.isArray(raw)) return [];
  const out: ProcessorPubKey[] = [];
  for (const pk of raw) {
    if (!pk || typeof pk !== 'object') continue;
    for (const [curve, key] of Object.entries(pk as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length) out.push({ curve, key });
    }
  }
  return out;
}

function classifyEvent(method: string): ChainEvent['kind'] {
  const m = method.toLowerCase();
  if (m.includes('final') || m.includes('removed') || m.includes('closed')) return 'finalized';
  if (m.includes('report') || m.includes('executed') || m.includes('executiondone') || m.includes('success') || m.includes('failure')) return 'reported';
  if (m.includes('match') || m.includes('start') || m.includes('assigned')) return 'started';
  return 'other';
}

function parseJobIds(raw: unknown): DeployJobId[] {
  if (!Array.isArray(raw)) return [];
  const out: DeployJobId[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const origin = entry[0] as { acurast?: string } | string | undefined;
    const localId = entry[1];
    const originStr = typeof origin === 'string'
      ? origin
      : (origin && typeof origin === 'object' && typeof origin.acurast === 'string' ? origin.acurast : '');
    const n = typeof localId === 'number' ? localId : Number(localId);
    if (!originStr || !Number.isFinite(n)) continue;
    out.push({ origin: originStr, localId: n });
  }
  return out;
}

function mergeJobIds(existing: DeployJobId[], next: DeployJobId[]): DeployJobId[] {
  const key = (j: DeployJobId) => `${j.origin}:${j.localId}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...next.filter((j) => !seen.has(key(j)))];
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
