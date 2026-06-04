import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { deployProject, loadAcurastConfig } from '@acurast/sdk/deploy';
import { normalizeMinProcessorVersions } from '../sdk/configCompat';
import { walletFromMnemonic, convertConfigToJob } from '@acurast/sdk/chain';
import { AcurastContext } from '../context';
import { WalletService } from '../wallet/walletService';
import { StudioPanel } from '../studio/studioPanel';
import { IPFS_DEFAULTS, RPC_ENDPOINTS, SYMBOL, type AcurastNetwork } from '../sdk/constants';

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
  let config;
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

  // Resolve relative paths against the project root (the directory holding acurast.json),
  // because the SDK reads fileUrl via fs.statSync against process.cwd().
  const resolvedConfig = normalizeMinProcessorVersions({
    ...config,
    fileUrl: resolveAgainst(projectRoot, config.fileUrl),
  } as typeof config);

  const bundleFolder = path.join(projectRoot, '.acurast', 'bundles');

  const network = (config.network ?? 'mainnet') as AcurastNetwork;
  const symbol = SYMBOL[network];

  // The deploy targets acurast.json's network — call out when that differs from
  // the network Acurast Studio (balance/processors/status bar) is pointed at, so
  // a stale status-bar reading doesn't mislead about where this job lands.
  const studioNetwork = vscode.workspace.getConfiguration('acurast').get<string>('network', 'mainnet');
  const mismatchNote =
    studioNetwork !== network
      ? `\n\n⚠️ Acurast Studio is targeting ${studioNetwork}, but this deploys to ${network} (from acurast.json).`
      : '';

  const confirm = await vscode.window.showWarningMessage(
    `Deploy "${config.projectName}" to ${network}?`,
    {
      modal: true,
      detail: `Replicas: ${config.numberOfReplicas ?? 1}\nMax cost/exec: ${config.maxCostPerExecution ?? 'n/a'} (planck ${symbol})${mismatchNote}`,
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
  studioPanel.beginDeploy({ project: config.projectName, network, enableDevtools: !!config.enableDevtools });

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Deploying ${config.projectName} to ${network}…`,
      cancellable: false,
    },
    async (progress) => {
      // SDK writes a transient `temp_script.js` to process.cwd() during IPFS upload
      // with no override; force cwd to a writable temp dir for the call.
      const originalCwd = process.cwd();
      const scratchCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'acurast-deploy-'));
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
          statusCallback: (status, data) => {
            const msg = `[${status}]${data ? ' ' + JSON.stringify(data) : ''}`;
            output.appendLine(msg);
            progress.report({ message: String(status) });
            studioPanel.recordDeployStatus(String(status), data);
          },
          logger: {
            debug: (m) => output.appendLine(`[debug] ${m}`),
            warn:  (m) => output.appendLine(`[warn] ${m}`),
            error: (m) => output.appendLine(`[error] ${m}`),
            log:   (m) => output.appendLine(m),
          },
        });

        output.appendLine(`[done] job registered`);
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
        try { fs.rmSync(scratchCwd, { recursive: true, force: true }); } catch { /* ignore */ }
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
