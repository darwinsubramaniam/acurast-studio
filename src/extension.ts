import * as vscode from 'vscode';
import { AcurastContext } from './context';
import { registerCommands } from './commands';
import { WalletService } from './wallet/walletService';
import { registerWalletCommands } from './wallet/walletCommands';
import { WalletStatusBar, SHOW_WALLETS_COMMAND_ID } from './wallet/walletStatusBar';
import { StudioPanel } from './studio/studioPanel';
import { acurastClient } from './sdk/acurastClient';

export async function activate(extensionContext: vscode.ExtensionContext) {
  const ctx = new AcurastContext(extensionContext);
  await ctx.initialize();

  const wallet = new WalletService(extensionContext.secrets);
  const studioPanel = new StudioPanel(extensionContext.extensionUri, ctx, wallet);
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
    { dispose: () => studioPanel.dispose() },
    { dispose: () => acurastClient.dispose() }
  );
}

export function deactivate() {}
