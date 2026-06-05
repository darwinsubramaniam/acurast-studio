import * as vscode from 'vscode';
import { AcurastContext } from '../context';

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

  const target = folder[0].fsPath;
  const terminal = vscode.window.createTerminal({
    name: `Acurast: new ${name}`,
    cwd: target,
  });
  terminal.show();
  terminal.sendText(`${ctx.cliPath} init ${name}`);

  vscode.window.showInformationMessage(
    `Follow prompts in the terminal. When done, open ${name}/ in VS Code.`,
    'Open folder when ready'
  ).then(async (action) => {
    if (action !== 'Open folder when ready') return;
    const projectUri = vscode.Uri.joinPath(folder[0], name);
    try {
      await vscode.commands.executeCommand('vscode.openFolder', projectUri, { forceNewWindow: false });
    } catch (err: unknown) {
      // Most likely the folder doesn't exist yet because `init` is still running
      // in the terminal — tell the user rather than swallowing the rejection.
      vscode.window.showErrorMessage(
        `Could not open ${name}/: ${(err as Error).message}. Open it manually once "${ctx.cliPath} init" finishes.`
      );
    }
  });
}
