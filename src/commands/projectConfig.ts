import * as vscode from 'vscode';
import * as path from 'path';
import { AcurastContext } from '../context';

export async function setActiveConfig(ctx: AcurastContext, uri?: vscode.Uri) {
  let target = uri;
  if (!target) {
    target = await pickConfig(ctx, 'Select acurast.json to use');
    if (!target) return;
  }
  try {
    await ctx.setActiveConfig(target);
    vscode.window.showInformationMessage(
      `Active acurast.json → ${vscode.workspace.asRelativePath(target)}`
    );
  } catch (err: unknown) {
    vscode.window.showErrorMessage((err as Error).message);
  }
}

export async function chooseConfig(ctx: AcurastContext) {
  const picked = await pickConfig(ctx, 'Choose the acurast.json for this workspace');
  if (!picked) return;
  await ctx.setActiveConfig(picked);
  vscode.window.showInformationMessage(
    `Active acurast.json → ${vscode.workspace.asRelativePath(picked)}`
  );
}

export async function clearActiveConfig(ctx: AcurastContext) {
  await ctx.clearActiveConfig();
  vscode.window.showInformationMessage('Cleared active acurast.json.');
}

async function pickConfig(ctx: AcurastContext, placeHolder: string): Promise<vscode.Uri | undefined> {
  const found = await ctx.findAllConfigs();
  if (!found.length) {
    vscode.window.showInformationMessage('No acurast.json files found in this workspace.');
    return undefined;
  }
  if (found.length === 1 && !ctx.configPath) {
    return found[0];
  }
  const items = found.map((uri) => {
    const rel = vscode.workspace.asRelativePath(uri);
    const dir = path.dirname(rel);
    return {
      label: rel,
      description: ctx.configPath === uri.fsPath ? '$(check) current' : undefined,
      detail: dir === '.' ? 'workspace root' : dir,
      uri,
    };
  });
  const picked = await vscode.window.showQuickPick(items, { placeHolder, ignoreFocusOut: true });
  return picked?.uri;
}
