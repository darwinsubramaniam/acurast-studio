import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { deployProject, loadAcurastConfig } from '@acurast/sdk/deploy';
import { normalizeMinProcessorVersions } from '../sdk/configCompat';
import { validateDeployConfig, formatIssue } from '../sdk/validateDeployConfig';
import { walletFromMnemonic, convertConfigToJob } from '@acurast/sdk/chain';
import { AcurastContext } from '../context';
import { WalletService } from '../wallet/walletService';
import { StudioPanel } from '../studio/studioPanel';
import { IPFS_DEFAULTS, RPC_ENDPOINTS, SYMBOL, type AcurastNetwork } from '../sdk/constants';
import { getTargetNetwork } from '../wallet/networkSetting';
import { resolveDeployEnvVars } from '../lib/env';
import { readBuildConfig, runProjectBuild } from './build';

interface DeployOptions {
  ctx: AcurastContext;
  wallet: WalletService;
  output: vscode.OutputChannel;
  studioPanel: StudioPanel;
}

export async function deploy({ ctx, wallet, output, studioPanel }: DeployOptions) {
  if (!ctx.configPath || !ctx.projectRoot) {
    vscode.window.showErrorMessage('No active acurast.json. Choose one from the Acurast Studio sidebar.');
    return;
  }

  const activeWallet = await wallet.getActive();
  if (!activeWallet) {
    vscode.window.showErrorMessage('No active wallet. Create one or set one active in the Acurast Studio sidebar.');
    return;
  }

  const projectRoot = ctx.projectRoot;
  let config: ReturnType<typeof loadAcurastConfig>;
  try {
    config = loadAcurastConfig({ filePath: ctx.configPath });
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Failed to load acurast.json: ${(err as Error).message}`);
    return;
  }
  if (!config) {
    vscode.window.showErrorMessage('No project found in acurast.json.');
    return;
  }
  // Optional build step (acurast.json `build.command`). When `build.output` is set
  // it becomes the deployed artifact, overriding fileUrl. Read from raw JSON since
  // the SDK's typed config drops the custom field.
  const buildCfg = readBuildConfig(ctx.configPath)?.build;
  const effectiveFileUrl = buildCfg?.output ?? config.fileUrl;

  if (!effectiveFileUrl) {
    vscode.window.showErrorMessage('acurast.json has no "fileUrl" — set the path to your script (or an ipfs:// URL / CID), or a build.output, to deploy.');
    return;
  }

  // Pre-deploy config validation against the SDK's zod schema. Hard errors block
  // before we prompt for a password or sign anything; advisory notes (Shell needs
  // an image, start time too soon, unattested devices, tight interval timing…)
  // surface in the confirm dialog below. Validate with effectiveFileUrl so
  // build.output projects (which may leave the raw fileUrl empty) aren't wrongly
  // flagged for a missing fileUrl.
  const { errors: configErrors, notes: configNotes } = validateDeployConfig({
    ...config,
    fileUrl: effectiveFileUrl,
  });
  if (configErrors.length > 0) {
    await vscode.window.showErrorMessage(
      `acurast.json has ${configErrors.length} validation error${configErrors.length === 1 ? '' : 's'} — fix ${configErrors.length === 1 ? 'it' : 'them'} before deploying.`,
      { modal: true, detail: configErrors.map(formatIssue).join('\n') }
    );
    return;
  }

  // Running a shell command sourced from acurast.json requires a trusted workspace.
  if (buildCfg?.command && !vscode.workspace.isTrusted) {
    vscode.window.showErrorMessage('This deployment has a build step, which runs a shell command and requires a trusted workspace.');
    return;
  }

  // Resolve relative paths against the project root (the directory holding acurast.json),
  // because the SDK reads fileUrl via fs.statSync against process.cwd().
  const resolvedConfig = normalizeMinProcessorVersions({
    ...config,
    fileUrl: resolveAgainst(projectRoot, effectiveFileUrl),
  } as NonNullable<typeof config>);

  const bundleFolder = path.join(projectRoot, '.acurast', 'bundles');

  const network = (config.network ?? 'mainnet') as AcurastNetwork;
  const symbol = SYMBOL[network];

  // The deploy targets acurast.json's network — call out when that differs from
  // the network Acurast Studio (balance/processors/status bar) is pointed at, so
  // a stale status-bar reading doesn't mislead about where this job lands.
  const studioNetwork = getTargetNetwork();
  const mismatchNote =
    studioNetwork !== network
      ? `\n\n⚠️ Acurast Studio is targeting ${studioNetwork}, but this deploys to ${network} (from acurast.json).`
      : '';

  // Source the values for the `includeEnvironmentVariables` whitelist from the
  // project's .env (then process.env). The SDK encrypts + submits these after
  // ack, but only sends what we pass — values were previously never resolved,
  // so nothing reached the processor.
  const { envVars, missing } = resolveDeployEnvVars(projectRoot, config.includeEnvironmentVariables);
  if (missing.length > 0) {
    // Soft gate, not a hard block: a job's code may tolerate an absent value.
    const proceed = await vscode.window.showWarningMessage(
      `Missing environment variables for "${config.projectName}"`,
      {
        modal: true,
        detail:
          `These are listed in includeEnvironmentVariables but were not found in ` +
          `.env or the environment:\n\n${missing.join('\n')}\n\n` +
          `They will NOT be sent to the processor. Deploy anyway?`,
      },
      'Deploy anyway'
    );
    if (proceed !== 'Deploy anyway') return; // Cancel / Esc aborts
  }

  // Surface the build command in the confirm dialog — the deploy gate doubles as
  // consent to run it, since it's an arbitrary shell command from acurast.json.
  const buildNote = buildCfg?.command ? `\n\nBuild step: ${buildCfg.command}` : '';

  // Advisory config notes (non-blocking) — shown so the user can back out and fix
  // them, but they can still proceed.
  const notesNote = configNotes.length
    ? `\n\n⚠️ ${configNotes.length} note${configNotes.length === 1 ? '' : 's'}:\n` +
      configNotes.map((n) => `• ${formatIssue(n)}`).join('\n')
    : '';

  const confirm = await vscode.window.showWarningMessage(
    `Deploy "${config.projectName}" to ${network}?`,
    {
      modal: true,
      detail: `Replicas: ${config.numberOfReplicas ?? 1}\nMax cost/exec: ${config.maxCostPerExecution ?? 'n/a'} (planck ${symbol})${buildNote}${notesNote}${mismatchNote}`,
    },
    'Deploy'
  );
  if (confirm !== 'Deploy') return;

  const password = await vscode.window.showInputBox({
    prompt: `Enter password for "${activeWallet.name}" to sign deploy`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!password) return;

  let mnemonic: string;
  try {
    mnemonic = await wallet.reveal(activeWallet.id, password);
  } catch (err: unknown) {
    vscode.window.showErrorMessage((err as Error).message);
    return;
  }

  output.clear();
  output.show(true);
  output.appendLine(`[deploy] project=${config.projectName} network=${network}`);
  // Log NAMES only — never the values (secrets).
  output.appendLine(
    `[deploy] env: ${envVars.length} var(s)${envVars.length ? ': ' + envVars.map((e) => e.key).join(', ') : ''}`
  );
  if (missing.length > 0) {
    output.appendLine(`[warn] env: skipping ${missing.length} unresolved var(s): ${missing.join(', ')}`);
  }
  studioPanel.beginDeploy({ project: config.projectName, network, enableDevtools: !!config.enableDevtools, hasBuild: !!buildCfg?.command });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Deploying ${config.projectName} to ${network}…`,
      cancellable: false,
    },
    async (progress) => {
      // Build first, while cwd is still the original (runProjectBuild resolves its
      // own cwd from projectRoot, so this is robust either way). A failure aborts
      // before any temp dir / SDK work. Runs before the chdir below.
      if (buildCfg?.command) {
        try {
          await runProjectBuild({
            projectRoot,
            build: buildCfg,
            output,
            onStage: (phase) => {
              if (phase === 'start') studioPanel.recordDeployStatus('Building', {});
              else if (phase === 'done') studioPanel.recordDeployStatus('Built', {});
            },
            onLog: (level, text) => studioPanel.appendDeployLog(level, text),
          });
        } catch (err: unknown) {
          const msg = (err as Error).message;
          output.appendLine(`[fail] ${msg}`);
          studioPanel.appendDeployLog('error', msg);
          studioPanel.endDeploy('error', msg);
          vscode.window.showErrorMessage(`Build failed: ${msg}`);
          return undefined;
        }
      }

      // SDK writes a transient `temp_script.js` to process.cwd() during IPFS upload
      // with no override; force cwd to a writable temp dir for the call.
      const originalCwd = process.cwd();
      const scratchCwd = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'acurast-deploy-'));
      try {
        process.chdir(scratchCwd);

        const keypair = await walletFromMnemonic(mnemonic);
        const job = convertConfigToJob(resolvedConfig);

        const rpcEndpoint = RPC_ENDPOINTS[network];

        const result = await deployProject(resolvedConfig, job, {
          wallet: keypair,
          rpcEndpoint,
          ipfs: IPFS_DEFAULTS,
          bundleFolder,
          envVars,
          statusCallback: (status, data) => {
            const msg = `[${status}]${data ? ' ' + JSON.stringify(data) : ''}`;
            output.appendLine(msg);
            progress.report({ message: String(status) });
            // Attribute the status marker to the still-active stage before it advances.
            studioPanel.appendDeployLog('debug', msg);
            studioPanel.recordDeployStatus(String(status), data);
          },
          logger: {
            debug: (m) => { output.appendLine(`[debug] ${m}`); studioPanel.appendDeployLog('debug', m); },
            warn:  (m) => { output.appendLine(`[warn] ${m}`); studioPanel.appendDeployLog('warn', m); },
            error: (m) => { output.appendLine(`[error] ${m}`); studioPanel.appendDeployLog('error', m); },
            log:   (m) => { output.appendLine(m); studioPanel.appendDeployLog('info', m); },
          },
        });

        output.appendLine(`[done] job registered`);
        studioPanel.appendDeployLog('info', 'job registered');
        studioPanel.endDeploy('ok');
        if (config.enableDevtools) void studioPanel.fetchDevtoolsUrl();
        vscode.window.showInformationMessage(`Deployed "${config.projectName}" to ${network}.`);
        return result;
      } catch (err: unknown) {
        const msg = (err as Error).message;
        output.appendLine(`[fail] ${msg}`);
        studioPanel.endDeploy('error', msg);
        vscode.window.showErrorMessage(`Deploy failed: ${msg}`);
        return undefined;
      } finally {
        try { process.chdir(originalCwd); } catch { /* ignore */ }
        try { await fs.promises.rm(scratchCwd, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  );
}

/** Resolve a relative fileUrl against the project root. Leaves IPFS hashes and absolute paths alone. */
function resolveAgainst(root: string, fileUrl: string | undefined): string | undefined {
  if (!fileUrl) return fileUrl;
  if (path.isAbsolute(fileUrl)) return fileUrl;
  if (/^(ipfs:\/\/|https?:\/\/|Qm[1-9A-HJ-NP-Za-km-z]{44}|b[A-Za-z2-7]{58})/.test(fileUrl)) {
    return fileUrl; // IPFS CID / URL — let SDK handle as-is
  }
  return path.resolve(root, fileUrl);
}
