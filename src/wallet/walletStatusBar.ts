import * as vscode from 'vscode';
import { WalletService } from './walletService';

const COMMAND_ID = 'acurast.studio.showWallets';

export class WalletStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly wallet: WalletService) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = COMMAND_ID;
    this.subscriptions.push(this.item);
    this.subscriptions.push(this.wallet.onDidChange(() => this.refresh()));
    void this.refresh();
  }

  private async refresh() {
    const active = await this.wallet.getActive();
    if (!active) {
      this.item.hide();
      return;
    }
    const short = `${active.address.slice(0, 6)}…${active.address.slice(-4)}`;
    this.item.text = `$(acurast-logo) ${active.name} ${short}`;
    this.item.tooltip = new vscode.MarkdownString(
      `**${active.name}**${active.description ? `\n\n_${active.description}_` : ''}\n\n\`${active.address}\``
    );
    this.item.show();
  }

  dispose() {
    this.subscriptions.forEach((d) => d.dispose());
  }
}

export const SHOW_WALLETS_COMMAND_ID = COMMAND_ID;
