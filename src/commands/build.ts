import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { AcurastContext } from '../context';
import { stripAnsi } from '../lib/log';
import type { LogLevel } from '../studio/types';

/**
 * Per-project build step declared in `acurast.json` under `projects.<key>.build`.
 * `acurast.json` only declares `fileUrl` (the final artifact); this declares how
 * to *produce* it, so non-JS toolchains (cargo, make, a TS bundler, …) can be run
 * before deploy. The command is language-agnostic — it's just a shell command.
 */
export interface ProjectBuildConfig {
  /** Shell command run before deploy (and by the standalone "Build" action). */
  command: string;
  /** Working dir for the command, relative to the project root. Defaults to the project root. */
  cwd?: string;
  /** Artifact the build produces; deployed in place of `fileUrl` when set. Relative to the project root. */
  output?: string;
}

export interface ReadBuildResult {
  build: ProjectBuildConfig;
  /** The acurast.json object key the build belongs to. */
  projectKey: string;
}

/** Thrown when a build is attempted in an untrusted workspace. */
export class WorkspaceUntrustedError extends Error {
  constructor() {
    super(
      'Refusing to run the project build command: acurast.json `build.command` runs an ' +
        'arbitrary shell command and requires a trusted workspace.',
    );
    this.name = 'WorkspaceUntrustedError';
  }
}

/**
 * Defense-in-depth guard for the shell sink. The command entry points already
 * check Workspace Trust before calling `runProjectBuild`, but the executor must
 * not rely on every caller remembering — a repository-sourced `build.command`
 * only ever runs after this returns true.
 */
export function ensureWorkspaceTrustedForBuild(isTrusted: boolean): void {
  if (!isTrusted) throw new WorkspaceUntrustedError();
}

// IPFS CIDs / ipfs:// / https:// references are not local files — skip existence
// checks for them. Mirrors deploy.ts:resolveAgainst so output behaves like fileUrl.
const REMOTE_REF = /^(ipfs:\/\/|https?:\/\/|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58})/;

/** True when `ref` points at a local path (not an ipfs/https/CID reference). */
export function isLocalPath(ref: string | undefined): boolean {
  return !!ref && !REMOTE_REF.test(ref);
}

/**
 * Re-read raw acurast.json and return the build block for the active project.
 *
 * Mirrors the SDK's `loadAcurastConfig` selection: a project is keyed by its
 * object key (not `projectName`). When `projectKey` is omitted only a single-
 * project file resolves — deploy itself only supports the single-project case.
 * Returns undefined when there is no usable build command. Never throws (matches
 * `StudioPanel.readConfig` resilience on malformed JSON).
 */
export function readBuildConfig(configPath: string, projectKey?: string): ReadBuildResult | undefined {
  let json: { projects?: Record<string, Record<string, unknown>> };
  try {
    json = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    return undefined;
  }
  const projects = json.projects;
  if (!projects || typeof projects !== 'object') return undefined;
  const keys = Object.keys(projects);

  let key: string | undefined;
  if (projectKey && keys.includes(projectKey)) key = projectKey;
  else if (keys.length === 1) key = keys[0];
  if (!key) return undefined;

  const raw = projects[key]?.build;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const cfg = raw as Record<string, unknown>;
  if (typeof cfg.command !== 'string' || cfg.command.trim() === '') return undefined;

  const build: ProjectBuildConfig = {
    command: cfg.command,
    cwd: typeof cfg.cwd === 'string' && cfg.cwd.trim() ? cfg.cwd : undefined,
    output: typeof cfg.output === 'string' && cfg.output.trim() ? cfg.output : undefined,
  };
  return { build, projectKey: key };
}

export interface RunBuildOptions {
  /** Directory containing acurast.json — relative `cwd`/`output` resolve against it. */
  projectRoot: string;
  build: ProjectBuildConfig;
  output: vscode.OutputChannel;
  /** Stage hooks so callers (e.g. the deploy pipeline) can mirror progress in the UI. */
  onStage?: (phase: 'start' | 'done' | 'error', detail?: string) => void;
  /** Per-line log hook (ANSI-stripped) for the per-stage colored log view. */
  onLog?: (level: LogLevel, text: string) => void;
}

/**
 * Spawn `build.command` in the resolved working directory, stream stdout/stderr to
 * the output channel, and verify the declared output artifact exists afterwards.
 * Rejects on spawn failure, a non-zero exit code, or a missing local output.
 *
 * `spawn` with `shell: true` (not `execFile`) so command strings with args/pipes —
 * `cargo build --release`, `npm run build`, `make` — parse the way users expect.
 * The cwd is resolved here from `projectRoot`, so this is correct regardless of the
 * caller's `process.cwd()` (deploy.ts chdirs to a scratch dir for the SDK).
 */
export function runProjectBuild(opts: RunBuildOptions): Promise<void> {
  const { projectRoot, build, output, onStage, onLog } = opts;
  const cwd = path.resolve(projectRoot, build.cwd ?? '.');
  return new Promise<void>((resolve, reject) => {
    // Never execute a workspace-sourced shell command in an untrusted workspace,
    // regardless of whether the caller remembered to check.
    try {
      ensureWorkspaceTrustedForBuild(vscode.workspace.isTrusted);
    } catch (err) {
      onStage?.('error', (err as Error).message);
      reject(err as Error);
      return;
    }
    // Write each line to both the output channel (ANSI-stripped — the channel
    // can't render colors anyway) and the per-stage log hook.
    const emit = (level: LogLevel, line: string) => {
      const clean = stripAnsi(line);
      output.appendLine(clean);
      onLog?.(level, clean);
    };

    emit('info', `[build] $ ${build.command}`);
    emit('info', `[build] cwd: ${cwd}`);
    onStage?.('start');

    // Child output arrives in arbitrary chunks; buffer into whole lines so the
    // log view is line-oriented (stdout → info, stderr → warn).
    let outBuf = '';
    let errBuf = '';
    const pump = (chunk: string, level: LogLevel, isErr: boolean) => {
      const parts = ((isErr ? errBuf : outBuf) + chunk).split('\n');
      const remainder = parts.pop() ?? '';
      for (const line of parts) emit(level, line);
      if (isErr) errBuf = remainder; else outBuf = remainder;
    };
    const flush = () => {
      if (outBuf) { emit('info', outBuf); outBuf = ''; }
      if (errBuf) { emit('warn', errBuf); errBuf = ''; }
    };

    const child = spawn(build.command, { cwd, shell: true, env: process.env });
    child.stdout?.on('data', (d: Buffer) => pump(d.toString(), 'info', false));
    child.stderr?.on('data', (d: Buffer) => pump(d.toString(), 'warn', true));

    child.on('error', (err: Error) => {
      const msg = `Failed to start build command: ${err.message}`;
      onStage?.('error', msg);
      reject(new Error(msg));
    });

    child.on('close', (code: number | null) => {
      flush();
      if (code !== 0) {
        const msg = `Build command exited with code ${code}`;
        onStage?.('error', msg);
        reject(new Error(msg));
        return;
      }
      if (isLocalPath(build.output)) {
        const abs = path.resolve(projectRoot, build.output as string);
        if (!fs.existsSync(abs)) {
          const msg = `Build finished but output not found: ${build.output}`;
          onStage?.('error', msg);
          reject(new Error(msg));
          return;
        }
      }
      emit('info', '[build] done');
      onStage?.('done');
      resolve();
    });
  });
}

export interface BuildCommandDeps {
  ctx: AcurastContext;
  output: vscode.OutputChannel;
}

/**
 * Standalone "Build" command (`acurast.build`): run the project's build without
 * deploying, for iterating on the artifact. Gated by Workspace Trust because it
 * runs an arbitrary shell command sourced from acurast.json.
 */
export async function acurastBuild(deps: BuildCommandDeps, projectKey?: string): Promise<void> {
  const { ctx, output } = deps;
  if (!ctx.configPath || !ctx.projectRoot) {
    vscode.window.showErrorMessage('No active acurast.json. Choose one from the Acurast Studio sidebar.');
    return;
  }
  if (!vscode.workspace.isTrusted) {
    vscode.window.showErrorMessage('Building runs the project\'s build command and requires a trusted workspace.');
    return;
  }
  const found = readBuildConfig(ctx.configPath, projectKey);
  if (!found) {
    vscode.window.showWarningMessage(
      'No build command configured. Add a "build" block in Project Settings → Build (or to acurast.json).'
    );
    return;
  }

  output.clear();
  output.show(true);
  output.appendLine(`[build] project=${found.projectKey}`);
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building ${found.projectKey}…`, cancellable: false },
    async () => {
      try {
        await runProjectBuild({ projectRoot: ctx.projectRoot as string, build: found.build, output });
        vscode.window.showInformationMessage(`Build succeeded for "${found.projectKey}".`);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        output.appendLine(`[build fail] ${msg}`);
        vscode.window.showErrorMessage(`Build failed: ${msg}`);
      }
    }
  );
}
