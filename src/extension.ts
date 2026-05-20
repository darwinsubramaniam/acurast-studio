import * as vscode from 'vscode';
import { AcurastContext } from './context';
import { registerCommands } from './commands';
import { WalletService } from './wallet/walletService';
import { registerWalletCommands } from './wallet/walletCommands';
import { WalletStatusBar, SHOW_WALLETS_COMMAND_ID } from './wallet/walletStatusBar';
import { StudioPanel } from './studio/studioPanel';
import { acurastClient } from './sdk/acurastClient';
import type { AcurastNetwork } from './sdk/constants';
import { registerAcurastLanguageService } from './acurastLanguageService';

async function ensureJsonSchema(extensionContext: vscode.ExtensionContext): Promise<void> {
  const schemaUri = vscode.Uri.joinPath(extensionContext.extensionUri, 'schemas', 'acurast.schema.json').toString();
  const config = vscode.workspace.getConfiguration('json');
  const existing = (config.get<Array<{ fileMatch?: string | string[]; url?: string }>>('schemas') ?? []);
  const alreadySet = existing.some(s => {
    const ms = Array.isArray(s.fileMatch) ? s.fileMatch : [s.fileMatch ?? ''];
    return ms.some(m => m === '**/acurast.json' || m === 'acurast.json');
  });
  if (!alreadySet) {
    await config.update('schemas', [
      ...existing,
      { fileMatch: ['**/acurast.json'], url: schemaUri }
    ], vscode.ConfigurationTarget.Global);
  }
}

export async function activate(extensionContext: vscode.ExtensionContext) {
  acurastClient.configure(() =>
    vscode.workspace.getConfiguration('acurast')
      .get<Partial<Record<AcurastNetwork, string>>>('rpcOverrides') ?? {}
  );

  ensureJsonSchema(extensionContext).catch(() => {});

  const ctx = new AcurastContext(extensionContext);
  await ctx.initialize();

  const wallet = new WalletService(extensionContext.secrets);
  const studioPanel = new StudioPanel(extensionContext.extensionUri, ctx, wallet, extensionContext.secrets);
  const statusBar = new WalletStatusBar(wallet);
  const output = vscode.window.createOutputChannel('Acurast');

  vscode.commands.executeCommand('setContext', 'acurast.studio.route', 'home');

  extensionContext.subscriptions.push(
    output,
    statusBar,
    vscode.window.registerWebviewViewProvider(StudioPanel.viewId, studioPanel),
    vscode.commands.registerCommand(SHOW_WALLETS_COMMAND_ID, () => studioPanel.navigate('wallets')),
    vscode.commands.registerCommand('acurast.studio.home', () => studioPanel.navigate('home')),
    ...registerWalletCommands(wallet),
    ...registerCommands({ ctx, wallet, output, studioPanel }),
    ...registerAcurastLanguageService(extensionContext),
    { dispose: () => studioPanel.dispose() },
    { dispose: () => acurastClient.dispose() }
  );
}

export function deactivate() {}
