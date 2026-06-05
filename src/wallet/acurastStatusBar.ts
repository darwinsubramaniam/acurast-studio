import * as vscode from 'vscode';
import { WalletService } from './walletService';
import { AcurastContext } from '../context';
import { networkLabel as label, isNetworkMismatch } from '../lib/network';
import { setTargetNetwork, getProjectNetwork } from './networkSetting';

const COMMAND_ID = 'acurast.studio.showWallets';
/** Clicking the status bar opens this quick-pick menu. */
const MENU_COMMAND_ID = 'acurast.studio.statusBarMenu';

const NETWORKS = ['mainnet', 'canary'] as const;
type Network = (typeof NETWORKS)[number];

export class AcurastStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly wallet: WalletService,
    private readonly ctx: AcurastContext
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = MENU_COMMAND_ID;
    this.subscriptions.push(this.item);
    this.subscriptions.push(
      vscode.commands.registerCommand(MENU_COMMAND_ID, () => this.openMenu())
    );
    this.subscriptions.push(this.wallet.onDidChange(() => this.refreshSafe()));
    // The active network lives in settings; refresh so the cue stays in sync
    // the moment the user switches mainnet/canary.
    this.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('acurast.network')) this.refreshSafe();
      })
    );
    // The project's own network lives in acurast.json — re-evaluate the mismatch
    // cue when the active project changes or its file is saved.
    this.subscriptions.push(this.ctx.onDidChangeActiveConfig(() => this.refreshSafe()));
    this.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.ctx.configPath && doc.fileName === this.ctx.configPath) this.refreshSafe();
      })
    );
    this.refreshSafe();
  }

  /** Fire-and-forget refresh that logs instead of silently swallowing failures. */
  private refreshSafe() {
    this.refresh().catch((err) =>
      console.error('Acurast status bar refresh failed:', err)
    );
  }

  private get network(): string {
    return vscode.workspace.getConfiguration('acurast').get<string>('network', 'mainnet');
  }

  /** Network the active acurast.json deploys to, or undefined when no project is active. */
  private projectNetwork(): string | undefined {
    return getProjectNetwork(this.ctx.configPath);
  }

  private async refresh() {
    const active = await this.wallet.getActive();
    if (!active) {
      this.item.hide();
      return;
    }
    const target = this.network;
    const project = this.projectNetwork();
    const mismatch = isNetworkMismatch(project, target);

    // Network first, then wallet name — the address lives in the hover tooltip.
    this.item.text = `$(acurast-logo) ${mismatch ? '$(warning) ' : ''}${label(target)} · ${active.name}`;
    this.item.backgroundColor = mismatch
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;

    const tip = new vscode.MarkdownString(
      `**${active.name}**${active.description ? `\n\n_${active.description}_` : ''}\n\n\`${active.address}\`\n\nNetwork: **${label(target)}**`
    );
    if (mismatch) {
      tip.appendMarkdown(
        `\n\n⚠️ acurast.json deploys to **${label(project!)}**, but Acurast Studio is targeting **${label(target)}**. Click to align.`
      );
    }
    this.item.tooltip = tip;
    this.item.show();
  }

  /**
   * Quick-pick invoked on click: switch the target network or copy the active
   * wallet address. Switching writes back to wherever the setting already lives
   * (workspace override if present, otherwise the global user setting).
   */
  private async openMenu() {
    const active = await this.wallet.getActive();
    const current = this.network;
    const project = this.projectNetwork();
    const mismatch = isNetworkMismatch(project, current);

    type Item = vscode.QuickPickItem & { action?: 'network' | 'copy' | 'wallets'; value?: Network };
    const items: Item[] = [{ label: 'Network', kind: vscode.QuickPickItemKind.Separator }];
    for (const n of NETWORKS) {
      const isProject = n === project;
      items.push({
        label: `${current === n ? '$(check)' : '$(circle-large-outline)'} ${label(n)}`,
        description: [current === n ? 'current' : '', isProject ? 'acurast.json' : '']
          .filter(Boolean)
          .join(' · ') || undefined,
        action: 'network',
        value: n,
      });
    }
    items.push({ label: 'Wallet', kind: vscode.QuickPickItemKind.Separator });
    if (active) {
      items.push({
        label: '$(copy) Copy address',
        description: `${active.address.slice(0, 6)}…${active.address.slice(-4)}`,
        action: 'copy',
      });
    }
    items.push({ label: '$(account) Manage wallets', action: 'wallets' });

    const pick = await vscode.window.showQuickPick(items, {
      title: 'Acurast Studio',
      placeHolder: mismatch
        ? `⚠️ acurast.json targets ${label(project!)} — Studio is on ${label(current)}`
        : active
          ? `${active.name} · ${label(current)}`
          : `Network: ${label(current)}`,
    });
    if (!pick) return;

    switch (pick.action) {
      case 'network':
        if (pick.value && pick.value !== current) await this.setNetwork(pick.value);
        break;
      case 'copy':
        if (active) {
          await vscode.env.clipboard.writeText(active.address);
          vscode.window.setStatusBarMessage(`Copied ${active.address}`, 1500);
        }
        break;
      case 'wallets':
        await vscode.commands.executeCommand(COMMAND_ID);
        break;
    }
  }

  private async setNetwork(value: Network) {
    const confirm = await vscode.window.showWarningMessage(
      `Switch the active Acurast network from ${label(this.network)} to ${label(value)}?`,
      {
        modal: true,
        detail: 'Balance queries, processor lookups, and on-chain history will target this network. Deploys follow the network in acurast.json.',
      },
      'Switch'
    );
    if (confirm !== 'Switch') return;

    await setTargetNetwork(value);
    vscode.window.setStatusBarMessage(`Acurast network: ${label(value)}`, 2000);
  }

  dispose() {
    this.subscriptions.forEach((d) => d.dispose());
  }
}

export const SHOW_WALLETS_COMMAND_ID = COMMAND_ID;
