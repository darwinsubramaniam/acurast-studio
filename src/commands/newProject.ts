// "Acurast: Init Project" — a native scaffolding wizard. The CLI's `acurast
// init` only produces NodeJS-shaped configs, so instead of shelling out to a
// terminal we ask runtime (Node.js or Shell), schedule, and — for Shell — the
// rootfs image, then write acurast.json plus starter files ourselves. The
// Shell image can be skipped and filled in later via Project Settings; the
// SDK blocks deploys until it's set, so nothing ships half-configured.
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { AcurastContext } from '../context';
import { BUNDLED_DISTROS } from '../sdk/distros';
import type { DistroImage } from '../studio/types';
import {
  buildScaffold,
  parseDurationMs,
  type ImageRef,
  type InitExecution,
  type InitRuntime,
} from '../lib/projectInit';

const SHA256_RE = /^[a-fA-F0-9]{64}$/;

export async function newProject(ctx: AcurastContext) {
  const folder = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: 'Select parent folder',
  });
  if (!folder?.length) return;

  const name = await vscode.window.showInputBox({
    prompt: 'Project name',
    ignoreFocusOut: true,
    validateInput: (v) => {
      const t = v.trim();
      if (!t) return 'Name required';
      if (!/^[a-zA-Z0-9_-]+$/.test(t)) return 'Use letters, numbers, dashes, underscores only';
      return undefined;
    },
  });
  if (!name) return;

  const targetDir = path.join(folder[0].fsPath, name.trim());
  if (await exists(targetDir)) {
    vscode.window.showErrorMessage(`Folder already exists: ${targetDir}`);
    return;
  }

  const runtime = await pickRuntime();
  if (!runtime) return;

  let image: ImageRef | undefined;
  if (runtime === 'Shell') {
    const picked = await pickImage();
    if (picked === undefined) return; // dismissed
    image = picked.image; // undefined when skipped → fill in later
  }

  const execution = await pickExecution();
  if (!execution) return;

  // Start the project on the Studio target network so a fresh project doesn't
  // immediately trip the network-mismatch warning; both are editable later.
  const scaffold = buildScaffold({ name: name.trim(), runtime, network: ctx.network, execution, image });

  try {
    for (const [rel, content] of Object.entries(scaffold.files)) {
      const abs = path.join(targetDir, ...rel.split('/'));
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
    }
    for (const rel of scaffold.executable) {
      await fs.chmod(path.join(targetDir, ...rel.split('/')), 0o755);
    }
  } catch (err: unknown) {
    vscode.window.showErrorMessage(`Could not create project: ${(err as Error).message}`);
    return;
  }

  const imagePending = runtime === 'Shell' && !(image?.url && image?.sha256);
  const message =
    `Created "${name.trim()}" (${runtime === 'Shell' ? 'Shell' : 'Node.js'} runtime).` +
    (imagePending ? ' Set the rootfs image URL + SHA256 in Project Settings before deploying.' : '');

  const targetUri = vscode.Uri.file(targetDir);
  const configUri = vscode.Uri.file(path.join(targetDir, 'acurast.json'));

  // Inside the open workspace: activate the config in place. Otherwise offer
  // to open the new folder (which re-activates the extension there).
  if (vscode.workspace.getWorkspaceFolder(targetUri)) {
    await ctx.setActiveConfig(configUri);
    await vscode.window.showTextDocument(configUri);
    vscode.window.showInformationMessage(message);
    return;
  }
  const action = await vscode.window.showInformationMessage(message, 'Open Project', 'Open in New Window');
  if (action === 'Open Project' || action === 'Open in New Window') {
    await vscode.commands.executeCommand('vscode.openFolder', targetUri, {
      forceNewWindow: action === 'Open in New Window',
    });
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function pickRuntime(): Promise<InitRuntime | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'Node.js',
        description: 'runtime: NodeJS',
        detail: 'Run a JavaScript file on the processor.',
        runtime: 'NodeJS' as const,
      },
      {
        label: 'Shell',
        description: 'runtime: Shell',
        detail: 'Run a shell entrypoint inside a Linux rootfs image (proot-distro).',
        runtime: 'Shell' as const,
      },
    ],
    { placeHolder: 'Which runtime should this project use?', ignoreFocusOut: true }
  );
  return picked?.runtime;
}

type ImagePickItem = vscode.QuickPickItem & { action?: 'skip' | 'manual'; distro?: DistroImage };

/**
 * Returns undefined when the picker is dismissed (abort the wizard), or an
 * object whose `image` is undefined when the user chose to fill it in later.
 */
async function pickImage(): Promise<{ image: ImageRef | undefined } | undefined> {
  const items: ImagePickItem[] = [
    {
      label: '$(circle-slash) Skip for now',
      detail: 'Leave image.url / image.sha256 empty — set them later in Project Settings',
      action: 'skip',
    },
    {
      label: '$(edit) Enter manually',
      detail: 'Paste a rootfs .tar.xz URL and its SHA256',
      action: 'manual',
    },
  ];
  for (const group of BUNDLED_DISTROS.groups) {
    items.push({
      label: `${group.label} · ${group.host}`,
      kind: vscode.QuickPickItemKind.Separator,
    });
    for (const d of group.distros) {
      items.push({ label: d.name, description: d.id, detail: d.comment, distro: d });
    }
  }
  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: 'Rootfs image for the Shell runtime (aarch64)',
    ignoreFocusOut: true,
    matchOnDescription: true,
  });
  if (!picked) return undefined;
  if (picked.action === 'skip') return { image: undefined };
  if (picked.distro) return { image: { url: picked.distro.url, sha256: picked.distro.sha256 } };

  const url = await vscode.window.showInputBox({
    prompt: 'Rootfs image URL (HTTPS .tar.xz)',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim().startsWith('https://') ? undefined : 'Must be an https:// URL'),
  });
  if (!url) return undefined;
  const sha256 = await vscode.window.showInputBox({
    prompt: 'SHA256 of the image (the processor verifies it on download)',
    ignoreFocusOut: true,
    validateInput: (v) => (SHA256_RE.test(v.trim()) ? undefined : 'Must be a 64-character hex string'),
  });
  if (!sha256) return undefined;
  return { image: { url: url.trim(), sha256: sha256.trim().toLowerCase() } };
}

async function pickExecution(): Promise<InitExecution | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        label: 'One time',
        detail: 'Run once, then the deployment ends',
        type: 'onetime' as const,
      },
      {
        label: 'Interval',
        detail: 'Run repeatedly on a fixed interval',
        type: 'interval' as const,
      },
    ],
    { placeHolder: 'Should the app run once or on an interval?', ignoreFocusOut: true }
  );
  if (!picked) return undefined;

  const validateDuration = (v: string) =>
    parseDurationMs(v) === undefined ? 'Enter a duration like 30s, 10min or 2h' : undefined;

  if (picked.type === 'onetime') {
    const duration = await vscode.window.showInputBox({
      prompt: 'How long may the execution run? (e.g. 30s, 10min, 2h)',
      value: '10min',
      ignoreFocusOut: true,
      validateInput: validateDuration,
    });
    if (!duration) return undefined;
    return { type: 'onetime', maxExecutionTimeInMs: parseDurationMs(duration)! };
  }

  const interval = await vscode.window.showInputBox({
    prompt: 'Time between executions (e.g. 30s, 10min, 2h)',
    value: '10min',
    ignoreFocusOut: true,
    validateInput: validateDuration,
  });
  if (!interval) return undefined;
  const count = await vscode.window.showInputBox({
    prompt: 'How many executions?',
    value: '10',
    ignoreFocusOut: true,
    validateInput: (v) =>
      Number.isInteger(Number(v)) && Number(v) > 0 ? undefined : 'Enter a whole number greater than 0',
  });
  if (!count) return undefined;
  return { type: 'interval', intervalInMs: parseDurationMs(interval)!, numberOfExecutions: Number(count) };
}
