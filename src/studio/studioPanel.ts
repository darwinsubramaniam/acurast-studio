import * as fs from 'fs';
import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import { WalletService } from '../wallet/walletService';
import { AcurastContext } from '../context';
import { acurastClient } from '../sdk/acurastClient';
import { getAcknowledgedProcessors, walletFromMnemonic, jobIdFromChainJson } from '@acurast/sdk/chain';
import type { UnsubEvent } from '@acurast/sdk/chain';
import { loadAcurastConfig } from '@acurast/sdk/deploy';
import { toCacu } from '@acurast/sdk/matcher';
import { loadPricing } from '../sdk/pricing';
import { SYMBOL, MATCHER_ENDPOINTS, TUNNEL_PORT, type AcurastNetwork } from '../sdk/constants';
import { networkLabel } from '../lib/network';
import { stripAnsi } from '../lib/log';
import { setTargetNetwork, getProjectNetwork } from '../wallet/networkSetting';
import { computeTxtValue, relaysFor, wildcardName, txtName, publicUrlExample, normalizeSuffix } from '../tunnel/tunnel';
import { verifyTunnelDns } from '../tunnel/dnsVerify';
import { Exchanger } from '../sdk/exchanger/exchanger';
import { CoinGecko, type CoinGeckoPlan } from '../sdk/exchanger/coingecko';
import { DeploymentStore } from '../deployments/deploymentStore';
import { fetchDistroCatalog } from '../sdk/distroFetch';
import { BUNDLED_DISTROS } from '../sdk/distros';
import type { Route, InMsg, WalletActionMsg, WalletCreateMsg, WalletImportMsg, WalletOpResultMsg, BalanceMsg, DeployState, DeployStage, DeployStageId, StageStatus, LogLevel, DeployJobId, ProcessorPubKey, ProcessorInfo, ChainEvent, PricingFiatInfo, FiatListItem, StoredDeploymentWithMeta, HistoryStateMsg, HistoryBulkItem, OnlineJobRegistration, LocalJobStatus, ProcessorsStateMsg, DiagnosisStateMsg, DeregisterStateMsg, AssignmentsStateMsg, TunnelStateMsg, TunnelTxtRecord, TunnelVerifyState, WalletInfo, DistroCatalog } from './types';

const BALANCE_POLL_MS = 30_000;
const FIAT_PRICE_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_PAGE_SIZE = 15;
/** ACU→fiat rates keyed by `exchangerId:currencyId`, served from globalState
 * within FIAT_PRICE_TTL_MS so repeat pricing pushes skip the exchanger API. */
const FIAT_PRICE_CACHE_KEY = 'acurast.fiatPrices.v1';
const TUNNEL_SUFFIX_KEY = 'acurast.tunnel.suffix';
/** Last successfully refreshed proot-distro catalog; falls back to BUNDLED_DISTROS. */
const DISTRO_CACHE_KEY = 'acurast.distros.v1';
const FIAT_API_KEY_SECRET = (exchangerId: number) => `acurast.fiat.apiKey.${exchangerId}`;

/** One cached ACU→fiat rate. `meta` is the resolved currency metadata so a
 * cache hit needs no getListOfFiat() round-trip either. */
interface FiatPriceCacheEntry {
  acuPriceFiat: number;
  fetchedAt: number;
  meta?: FiatListItem;
}
type FiatPriceCache = Record<string, FiatPriceCacheEntry>;

function defaultStages(hasBuild = false): DeployStage[] {
  const stages: DeployStage[] = [
    { id: 'bundle', label: 'Package bundle', status: 'pending', logs: [] },
    { id: 'upload', label: 'Upload to IPFS', status: 'pending', logs: [] },
    { id: 'prepare', label: 'Prepare job', status: 'pending', logs: [] },
    { id: 'submit', label: 'Submit transaction', status: 'pending', logs: [] },
    { id: 'match', label: 'Match processor', status: 'pending', logs: [] },
    { id: 'acknowledge', label: 'Acknowledge', status: 'pending', logs: [] },
    { id: 'envvars', label: 'Set env vars', status: 'pending', logs: [] },
  ];
  // Only show the build stage when the project declares a build command, so
  // projects that point fileUrl at a ready artifact don't see a noise stage.
  if (hasBuild) stages.unshift({ id: 'build', label: 'Build artifact', status: 'pending', logs: [] });
  return stages;
}

export class StudioPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'acurastStudio';
  private _view: vscode.WebviewView | undefined;
  private _route: Route = 'home';
  // Monotonic token for in-flight local-status enrichment. Bumped on every
  // pushHistory; a stale token (or leaving the history route) makes a still-
  // running chain query drop its result instead of posting it.
  private _historyGen = 0;
  private _balanceTimer: NodeJS.Timeout | undefined;
  // Monotonic stamp on every wallet.opResult so the webview's $effect re-fires
  // even when two results carry identical payloads (e.g. same wrong-password error).
  private _walletOpSeq = 0;
  // Same idea for duration.converted (converting a field to its current value twice).
  private _durationSeq = 0;
  private _deploy: DeployState | null = null;
  // Coalesces frequent log-driven state pushes (see scheduleDeployPush).
  private _deployPushTimer: NodeJS.Timeout | undefined;
  private _chainEventUnsub: UnsubEvent | undefined;
  private _chainWatchToken = 0;
  private _exchanger = new Exchanger();
  // Tunnel DNS wizard state. `_tunnelSuffix === undefined` means "not loaded
  // from workspaceState yet". The last verify result is kept so a re-push (e.g.
  // navigating back, or switching the deployer wallet) doesn't discard the
  // ✓/✗ marks — the published TXT set is cached in `_tunnelVerify.txtFound`.
  private _tunnelSuffix: string | undefined;
  private _tunnelNetwork: AcurastNetwork | undefined;
  private _tunnelWalletId: string | undefined;
  private _tunnelVerify: TunnelVerifyState = { status: 'idle' };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ctx: AcurastContext,
    private readonly wallet: WalletService,
    private readonly secrets: vscode.SecretStorage,
    private readonly deploymentStore: DeploymentStore,
    private readonly workspaceState: vscode.Memento,
    // The distro catalog is not workspace-scoped — a refresh in one project
    // should serve every other one — so its cache lives in globalState.
    private readonly globalState: vscode.Memento,
    // Drives the Home version badge: package.json version, whether we're under
    // an Extension Development Host (F5), and the CI-stamped release channel/tag
    // (null for local/dev builds — the numeric version can't reveal the channel).
    private readonly versionInfo: { version: string; dev: boolean; channel: 'rc' | 'pre' | 'stable' | null; tag: string | null }
  ) {
    wallet.onDidChange(() => this.pushWallets());
    ctx.onDidChangeActiveConfig(() => {
      void this.pushContext();
      void this.pushConfig();
      void this.pushNetworkMismatch();
    });
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.ctx.configPath && doc.fileName === this.ctx.configPath) {
        void this.pushConfig();
        void this.pushNetworkMismatch();
      }
    });
    // The target network lives in settings; reflect changes immediately so the
    // panel title and the wallet view never lag behind which chain is active.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('acurast.network')) {
        this.updateViewTitle();
        // pushWallets re-pushes balance itself when on the wallets route, so the
        // processors/history views re-query webview-side off the new
        // `wallets.network` and the balance refreshes in one pass.
        void this.pushWallets();
        void this.pushNetworkMismatch();
      }
    });
  }

  private async pushContext() {
    let configExists = false;
    if (this.ctx.configPath) {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.file(this.ctx.configPath));
        configExists = true;
      } catch {
        configExists = false;
      }
    }
    const found = await this.ctx.findAllConfigs();
    const anyConfigExists = found.length > 0;

    this.post({
      type: 'context',
      isAcurastProject: this.ctx.isAcurastProject,
      configPath: this.ctx.configPath ?? null,
      configRel: this.ctx.configPath
        ? vscode.workspace.asRelativePath(this.ctx.configPath)
        : null,
      configExists,
      anyConfigExists,
    });
  }

  /**
   * Post the version badge shown on Home:
   *   - F5 dev host        → `dev · <git short hash>`
   *   - packaged build     → `v<package.json version>`
   * plus the CI-stamped `channel`/`tag` so the webview can flag a pre-release /
   * RC — the numeric version alone can't, since the Marketplace strips the
   * tag suffix.
   */
  private async pushAppInfo() {
    const { version, dev, channel, tag } = this.versionInfo;
    let label = `v${version}`;
    if (dev) {
      const hash = await this.gitShortHash();
      label = hash ? `dev · ${hash}` : 'dev';
    }
    this.post({ type: 'appInfo', label, version, tag, channel, dev });
  }

  /** `git rev-parse --short HEAD` in the extension dir, or null if unavailable
   * (git missing / not a repo). Only used for the dev version badge. */
  private gitShortHash(): Promise<string | null> {
    return new Promise((resolve) => {
      execFile(
        'git',
        ['rev-parse', '--short', 'HEAD'],
        { cwd: this.extensionUri.fsPath },
        (err, stdout) => resolve(err ? null : stdout.trim() || null),
      );
    });
  }

  private get network(): AcurastNetwork {
    return vscode.workspace.getConfiguration('acurast').get<AcurastNetwork>('network', 'mainnet');
  }

  /** Network shown to the user, e.g. "Mainnet" / "Canary". */
  private get networkLabel(): string {
    return networkLabel(this.network);
  }

  /**
   * Stamp the active network onto the view header so it reads
   * "Acurast Studio: Mainnet" — a constant cue for which chain the panel talks
   * to, independent of the route the user is on.
   */
  private updateViewTitle() {
    if (this._view) this._view.title = this.networkLabel;
  }

  async navigate(route: Route) {
    this._route = route;
    this.updateRouteContext();
    if (this._view) {
      this.post({ type: 'route', route });
      // Home also surfaces the active wallet's balance, so poll on both routes.
      if (route === 'wallets' || route === 'home') {
        await this.pushWallets();
        this.startBalancePoll();
      } else {
        this.stopBalancePoll();
      }
      if (route === 'settings') await this.pushConfig();
      if (route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
      if (route === 'history') await this.pushHistory();
      if (route === 'tunnel') await this.pushTunnel();
    }
    // Reveal the view (auto-generated focus command)
    await vscode.commands.executeCommand('acurastStudio.focus');
  }

  private updateRouteContext() {
    vscode.commands.executeCommand('setContext', 'acurast.studio.route', this._route);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
    this.updateViewTitle();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };
    view.webview.html = this.html(view.webview);

    view.onDidChangeVisibility(() => {
      if (view.visible && (this._route === 'wallets' || this._route === 'home')) this.startBalancePoll();
      else this.stopBalancePoll();
    });
    view.onDidDispose(() => { this.stopBalancePoll(); void this.stopChainWatch(); });

    view.webview.onDidReceiveMessage((msg: InMsg) => this.handle(msg));
  }

  private async handle(msg: InMsg) {
    switch (msg.type) {
      case 'ready':
        this.pushAll();
        break;
      case 'navigate':
        this._route = msg.route;
        this.updateRouteContext();
        this.post({ type: 'route', route: msg.route });
        if (msg.route === 'wallets' || msg.route === 'home') {
          await this.pushWallets();
          this.startBalancePoll();
        } else {
          this.stopBalancePoll();
        }
        if (msg.route === 'settings') await this.pushConfig();
        if (msg.route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
        if (msg.route === 'history') await this.pushHistory();
        if (msg.route === 'tunnel') await this.pushTunnel();
        break;
      case 'wallet':
        await this.runWalletAction(msg);
        break;
      case 'wallet.create':
        await this.createWalletInPanel(msg);
        break;
      case 'wallet.checkPhrase':
        await this.checkPhraseInPanel(msg.mnemonic);
        break;
      case 'wallet.import':
        await this.importWalletInPanel(msg);
        break;
      case 'wallet.reveal':
        await this.revealInPanel(msg.id, msg.password);
        break;
      case 'wallet.rename':
        await this.renameInPanel(msg.id, msg.name);
        break;
      case 'wallet.editDescription':
        await this.editDescriptionInPanel(msg.id, msg.description);
        break;
      case 'wallet.delete':
        await this.deleteInPanel(msg.id);
        break;
      case 'wallet.copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage(msg.note ?? 'Copied to clipboard', 1500);
        }
        break;
      case 'refreshBalance':
        await this.pushBalanceForRoute();
        break;
      case 'config.save':
        await this.saveConfigPatch(msg.projectKey, msg.patch);
        break;
      case 'config.openJson':
        await this.openJson();
        break;
      case 'config.choose':
        await vscode.commands.executeCommand('acurast.chooseConfig');
        break;
      case 'config.newProject':
        await vscode.commands.executeCommand('acurast.newProject');
        break;
      case 'deploy.start':
        await vscode.commands.executeCommand('acurast.deploy');
        break;
      case 'build.start':
        await vscode.commands.executeCommand('acurast.build', msg.projectKey);
        break;
      case 'deploy.openOutput':
        await vscode.commands.executeCommand('workbench.action.output.toggleOutput');
        break;
      case 'deploy.queryProcessors':
        await this.queryProcessors();
        break;
      case 'deploy.copy':
        if (msg.text) {
          await vscode.env.clipboard.writeText(String(msg.text));
          vscode.window.setStatusBarMessage(`Copied "${msg.text}"`, 1500);
        }
        break;
      case 'deploy.deregister':
        await this.deregisterDeployment(msg.origin, msg.localId);
        break;
      case 'pricing.fetch':
        void this.pushPricing(msg.projectKey, msg.patch);
        break;
      case 'fiat.fetchList':
        void this.pushFiatList(msg.exchangerId, msg.apiKey, msg.coingeckoPlan);
        break;
      case 'fiat.save':
        await this.saveFiatSelection(msg.exchangerId, msg.currencyId, msg.apiKey, msg.coingeckoPlan);
        break;
      case 'devtools.refreshKey':
        await this.fetchDevtoolsUrl();
        break;
      case 'devtools.openUrl':
        if (msg.url) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        break;
      case 'openExternal':
        // Defense-in-depth: only ever hand https URLs to the OS. The webview is
        // trusted (bundled, CSP-locked) and today sends only the donation page,
        // but validating the scheme stops any future message from opening
        // file:/command:/vscode: URIs via this channel.
        if (msg.url) {
          let target: vscode.Uri | undefined;
          try {
            target = vscode.Uri.parse(msg.url, true);
          } catch {
            target = undefined;
          }
          if (target?.scheme === 'https') await vscode.env.openExternal(target);
        }
        break;
      case 'processors.query':
        await this.fetchProcessors(msg.address, msg.network);
        break;
      case 'processors.advertise':
        await vscode.commands.executeCommand('acurast.processor.advertiseModules', {
          walletId: msg.walletId,
          processor: msg.processor,
          modules: msg.modules,
          network: msg.network,
          newAd: msg.newAd,
        });
        break;
      case 'history.load':
        await this.pushHistory(msg.offset ?? 0);
        break;
      case 'history.fetchOnline':
        await this.fetchOnlineHistory(msg.address, msg.network);
        break;
      case 'history.diagnose':
        await this.diagnoseJob(msg.origin, msg.localId, msg.network);
        break;
      case 'history.delete':
        await this.deleteHistoryRecord(msg.id, msg.origin, msg.localId, msg.network);
        break;
      case 'history.bulkDelete':
        await this.bulkDeleteHistory(msg.items ?? []);
        break;
      case 'history.fetchAssignments':
        await this.fetchJobAssignments(msg.origin, msg.localId, msg.network);
        break;
      case 'history.removePathInfo':
        await this.deploymentStore.removePathInfo(msg.id);
        await this.pushHistory();
        break;
      case 'history.openFolder':
        if (msg.path) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        break;
      case 'network.setTarget':
        await setTargetNetwork(msg.network);
        vscode.window.setStatusBarMessage(`Acurast network: ${networkLabel(msg.network)}`, 2000);
        break;
      case 'network.openPicker':
        // Reuse the status bar's confirmed network quick-pick (registered by
        // AcurastStatusBar) so the Home pill and status bar share one flow.
        await vscode.commands.executeCommand('acurast.studio.statusBarMenu');
        break;
      case 'tunnel.compute':
        await this.pushTunnel(msg.suffix, msg.network, msg.walletId);
        break;
      case 'tunnel.verify':
        await this.verifyTunnel(msg.suffix, msg.network, msg.walletId);
        break;
      case 'tunnel.openRelaySetting':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'acurast.tunnelRelays');
        break;
      case 'distro.refresh':
        await this.refreshDistros();
        break;
      case 'duration.convert': {
        const ms = await vscode.commands.executeCommand<number | undefined>('acurast.convertDuration', {
          title: msg.label,
          currentMs: msg.currentMs,
          quiet: true,
        });
        if (typeof ms === 'number') {
          this.post({ type: 'duration.converted', field: msg.field, ms, seq: ++this._durationSeq });
        }
        break;
      }
    }
  }

  private async runWalletAction(msg: WalletActionMsg) {
    // The remaining `wallet` action is `setActive`; the create/import/reveal/
    // rename/editDescription/delete flows are in-panel wizards (the wallet.*
    // request messages) and the native palette commands still exist separately.
    if (msg.action === 'setActive' && msg.id) await this.wallet.setActive(msg.id);
  }

  /** Post a wallet flow result to the webview, stamped with a fresh sequence. */
  private postWalletOp(payload: Omit<WalletOpResultMsg, 'type' | 'seq'>) {
    this.post({ type: 'wallet.opResult', seq: ++this._walletOpSeq, ...payload });
  }

  private async createWalletInPanel(msg: WalletCreateMsg) {
    try {
      const { mnemonic, info } = await this.wallet.create(
        { name: msg.name.trim(), description: msg.description.trim() },
        msg.password,
      );
      this.postWalletOp({ op: 'create', ok: true, id: info.id, address: info.address, name: info.name, mnemonic });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'create', ok: false, message: (err as Error).message });
    }
  }

  private async checkPhraseInPanel(mnemonic: string) {
    try {
      const { valid, existing } = await this.wallet.checkMnemonic(mnemonic);
      this.postWalletOp({
        op: 'checkPhrase', ok: true, valid,
        duplicate: !!existing,
        existingName: existing?.name,
        existingAddress: existing?.address,
      });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'checkPhrase', ok: false, message: (err as Error).message });
    }
  }

  private async importWalletInPanel(msg: WalletImportMsg) {
    try {
      const info = await this.wallet.import(
        msg.mnemonic,
        { name: msg.name.trim(), description: msg.description.trim() },
        msg.password,
      );
      this.postWalletOp({ op: 'import', ok: true, id: info.id, address: info.address, name: info.name });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'import', ok: false, message: (err as Error).message });
    }
  }

  private async revealInPanel(id: string, password: string) {
    try {
      const mnemonic = await this.wallet.reveal(id, password);
      this.postWalletOp({ op: 'reveal', ok: true, id, mnemonic });
    } catch {
      // decrypt throws on a wrong password (and a missing wallet); surface the
      // friendly message the mock shows rather than the raw crypto error.
      this.postWalletOp({ op: 'reveal', ok: false, id, message: 'Incorrect password — try again' });
    }
  }

  private async renameInPanel(id: string, name: string) {
    try {
      await this.wallet.updateMetadata(id, { name: name.trim() });
      this.postWalletOp({ op: 'rename', ok: true, id });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'rename', ok: false, id, message: (err as Error).message });
    }
  }

  private async editDescriptionInPanel(id: string, description: string) {
    try {
      await this.wallet.updateMetadata(id, { description: description.trim() });
      this.postWalletOp({ op: 'editDescription', ok: true, id });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'editDescription', ok: false, id, message: (err as Error).message });
    }
  }

  private async deleteInPanel(id: string) {
    try {
      await this.wallet.delete(id);
      this.postWalletOp({ op: 'delete', ok: true, id });
    } catch (err: unknown) {
      this.postWalletOp({ op: 'delete', ok: false, id, message: (err as Error).message });
    }
  }

  private post(msg: unknown) {
    this._view?.webview.postMessage(msg);
  }

  private async pushAll() {
    this.post({ type: 'route', route: this._route });
    void this.pushAppInfo();
    await this.pushContext();
    await this.pushWallets();
    if (this._route === 'wallets' || this._route === 'home') this.startBalancePoll();
    await this.pushConfig();
    await this.pushNetworkMismatch();
    await this.pushFiatSelection();
    this.pushDistros();
    if (this._route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
    if (this._route === 'history') await this.pushHistory();
    if (this._route === 'tunnel') await this.pushTunnel();
  }

  // ── proot-distro image catalog ──────────────────────────────────────────────
  // Backs the Shell runtime's image dropdown in Settings. The bundled catalog
  // (src/sdk/distros.ts, regenerated by `npm run build:distros`) is what ships,
  // so the dropdown works offline and the deploy path never touches the network;
  // a user-triggered refresh re-reads it from GitHub and caches the result.

  /** The refreshed catalog if one was ever fetched, else the one we shipped with. */
  private get distros(): DistroCatalog {
    return this.globalState.get<DistroCatalog>(DISTRO_CACHE_KEY) ?? BUNDLED_DISTROS;
  }

  private pushDistros(status: 'idle' | 'loading' | 'error' = 'idle', error?: string) {
    this.post({ type: 'distro.catalog', catalog: this.distros, status, ...(error ? { error } : {}) });
  }

  /**
   * Re-read the catalog from termux/proot-distro. On failure the cached/bundled
   * catalog stays in place and the error is shown inline — a rate-limited or
   * offline refresh must never empty the dropdown out from under the user.
   */
  private async refreshDistros() {
    this.pushDistros('loading');
    try {
      const catalog = await fetchDistroCatalog();
      await this.globalState.update(DISTRO_CACHE_KEY, catalog);
      this.pushDistros();
    } catch (e) {
      this.pushDistros('error', e instanceof Error ? e.message : String(e));
    }
  }

  /**
   * Compares the project's deploy network (acurast.json) against the Studio
   * target (the `acurast.network` setting that drives balance/processors/history)
   * and posts both so the webview can warn when they diverge.
   */
  private async pushNetworkMismatch() {
    const projectNetwork = getProjectNetwork(this.ctx.configPath) ?? null;
    this.post({ type: 'network.mismatch', projectNetwork, targetNetwork: this.network });
  }

  // ── Tunnel DNS wizard ───────────────────────────────────────────────────────
  /**
   * Default network for the tunnel records. Relays/wildcard records belong to
   * the *deploy* target, so prefer the project's acurast.json network, falling
   * back to the Studio target setting.
   */
  private get tunnelNetwork(): AcurastNetwork {
    const proj = getProjectNetwork(this.ctx.configPath);
    return proj === 'mainnet' || proj === 'canary' ? proj : this.network;
  }

  private tunnelRelayOverride(): Partial<Record<AcurastNetwork, string[]>> | undefined {
    return vscode.workspace
      .getConfiguration('acurast')
      .get<Partial<Record<AcurastNetwork, string[]>>>('tunnelRelays');
  }

  /** The deployer wallet the TXT record is shown/verified for: the explicit
   * selection if it still exists, else the active wallet, else the first. */
  private async resolveTunnelWallet(): Promise<WalletInfo | undefined> {
    const wallets = await this.wallet.list();
    const activeId = await this.wallet.getActiveId();
    return (
      wallets.find((w) => w.id === this._tunnelWalletId) ??
      wallets.find((w) => w.id === activeId) ??
      wallets[0]
    );
  }

  private async buildTunnelState(suffix: string, network: AcurastNetwork): Promise<TunnelStateMsg> {
    const relays = relaysFor(network, this.tunnelRelayOverride());
    const selected = await this.resolveTunnelWallet();
    const done = this._tunnelVerify.status === 'done';
    const txtFound = this._tunnelVerify.txtFound ?? [];

    let record: TunnelTxtRecord | null = null;
    if (suffix && selected) {
      const txtValue = computeTxtValue(selected.publicKey, suffix);
      record = {
        walletId: selected.id,
        name: selected.name,
        address: selected.address,
        txtValue,
        // The relay accepts any matching record, so membership in the published
        // TXT set is enough to verify whichever wallet is currently selected.
        verified: done ? txtFound.includes(txtValue) : null,
      };
    }

    return {
      type: 'tunnel.state',
      network,
      suffix,
      relays,
      wildcardName: suffix ? wildcardName(suffix) : '',
      txtName: suffix ? txtName(suffix) : '',
      publicUrlExample: suffix ? publicUrlExample(suffix) : '',
      port: TUNNEL_PORT,
      selectedWalletId: selected?.id ?? null,
      record,
      verify: this._tunnelVerify,
    };
  }

  private async pushTunnel(suffix?: string, network?: AcurastNetwork, walletId?: string) {
    if (this._tunnelSuffix === undefined) {
      this._tunnelSuffix = normalizeSuffix(this.workspaceState.get<string>(TUNNEL_SUFFIX_KEY, ''));
    }
    const nextSuffix = suffix !== undefined ? normalizeSuffix(suffix) : this._tunnelSuffix;
    const nextNetwork = network ?? this._tunnelNetwork ?? this.tunnelNetwork;

    // Suffix/network change invalidates the cached DNS check; switching the
    // deployer wallet does not — only which TXT value we look for changes.
    if (nextSuffix !== this._tunnelSuffix || nextNetwork !== this._tunnelNetwork) {
      this._tunnelVerify = { status: 'idle' };
    }
    this._tunnelSuffix = nextSuffix;
    this._tunnelNetwork = nextNetwork;
    if (walletId !== undefined) this._tunnelWalletId = walletId;
    if (suffix !== undefined) await this.workspaceState.update(TUNNEL_SUFFIX_KEY, nextSuffix);

    this.post(await this.buildTunnelState(nextSuffix, nextNetwork));
  }

  private async verifyTunnel(suffix: string, network: AcurastNetwork, walletId?: string) {
    const norm = normalizeSuffix(suffix);
    this._tunnelSuffix = norm;
    this._tunnelNetwork = network;
    if (walletId !== undefined) this._tunnelWalletId = walletId;
    await this.workspaceState.update(TUNNEL_SUFFIX_KEY, norm);

    const selected = await this.resolveTunnelWallet();
    if (!norm) {
      this._tunnelVerify = { status: 'error', error: 'Enter a domain suffix first.' };
      this.post(await this.buildTunnelState(norm, network));
      return;
    }
    if (!selected) {
      this._tunnelVerify = { status: 'error', error: 'No wallet selected.' };
      this.post(await this.buildTunnelState(norm, network));
      return;
    }

    this._tunnelVerify = { status: 'checking' };
    this.post(await this.buildTunnelState(norm, network));

    const relays = relaysFor(network, this.tunnelRelayOverride());
    const expectedIps = relays.map((r) => r.ip);
    const expectedTxt = [{ walletId: selected.id, value: computeTxtValue(selected.publicKey, norm) }];

    const result = await verifyTunnelDns(norm, expectedIps, expectedTxt);
    this._tunnelVerify = {
      status: result.error ? 'error' : 'done',
      error: result.error,
      wildcard: result.wildcard,
      txtFound: result.txtFound,
    };
    this.post(await this.buildTunnelState(norm, network));
  }

  private async pushWallets() {
    const wallets = await this.wallet.list();
    const activeId = await this.wallet.getActiveId();
    this.post({
      type: 'wallets.state',
      wallets,
      activeId,
      network: this.network,
      symbol: SYMBOL[this.network],
    });
    if (activeId) await this.pushBalanceForRoute();
  }

  private startBalancePoll() {
    this.stopBalancePoll();
    this._balanceTimer = setInterval(() => void this.pushBalanceForRoute(), BALANCE_POLL_MS);
  }

  private stopBalancePoll() {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer);
      this._balanceTimer = undefined;
    }
  }

  /**
   * The Wallets list shows a balance per wallet; Home shows only the active one.
   * Branch by route so we don't fan out N balance RPCs while sitting on Home.
   */
  private async pushBalanceForRoute() {
    if (this._route === 'wallets') await this.pushAllBalances();
    else if (this._route === 'home') await this.pushBalance();
  }

  private async pushBalance() {
    const active = await this.wallet.getActive();
    if (!active) return;
    this.post({ type: 'wallets.balance', status: 'loading' });
    try {
      const balance = await acurastClient.getBalance(this.network, active.address);
      this.post({
        type: 'wallets.balance',
        status: 'ok',
        value: balance,
        symbol: SYMBOL[this.network],
        network: this.network,
      });
    } catch (err: unknown) {
      this.post({ type: 'wallets.balance', status: 'error', message: (err as Error).message });
    }
  }

  /**
   * Fetch every wallet's balance on the Studio target network for the Wallets
   * list. Posts a `loading` map first so all rows show a spinner, then the
   * resolved map. Each row resolves independently so one bad RPC doesn't sink
   * the rest. Guards against the network changing mid-fetch via a captured `gen`.
   */
  private async pushAllBalances() {
    const network = this.network;
    const symbol = SYMBOL[network];
    const wallets = await this.wallet.list();
    if (!wallets.length) {
      this.post({ type: 'wallets.balances', balances: {} });
      return;
    }
    const loading: Record<string, BalanceMsg> = {};
    for (const w of wallets) loading[w.id] = { status: 'loading' };
    this.post({ type: 'wallets.balances', balances: loading });

    const entries = await Promise.all(
      wallets.map(async (w): Promise<[string, BalanceMsg]> => {
        try {
          const value = await acurastClient.getBalance(network, w.address);
          return [w.id, { status: 'ok', value, symbol, network }];
        } catch (err: unknown) {
          return [w.id, { status: 'error', message: (err as Error).message, network }];
        }
      }),
    );
    // Drop the result if the target network changed while we were fetching.
    if (network !== this.network) return;
    this.post({ type: 'wallets.balances', balances: Object.fromEntries(entries) });
  }

  private async pushConfig() {
    const raw = await this.readConfig();
    this.post({ type: 'config.state', config: raw });
  }

  private async readConfig(): Promise<unknown | undefined> {
    if (!this.ctx.configPath) return undefined;
    try {
      const data = await vscode.workspace.fs.readFile(vscode.Uri.file(this.ctx.configPath));
      return JSON.parse(new TextDecoder('utf-8').decode(data));
    } catch {
      return undefined;
    }
  }

  /**
   * `projectKey`/`patch` come from Settings' `pricing.fetch`: the estimate must
   * reflect the unsaved draft the user is editing, so the draft patch is
   * overlaid on the loaded config the same way `saveConfigPatch` would merge it
   * into acurast.json on Save. Callers that omit them price the file on disk.
   */
  async pushPricing(projectKey?: string, patch?: Record<string, unknown>) {
    this.post({ type: 'pricing.state', status: 'loading' });

    if (!this.ctx.configPath) {
      this.post({ type: 'pricing.state', status: 'error', error: 'No active acurast.json' });
      return;
    }

    let config;
    try {
      config = loadAcurastConfig({ filePath: this.ctx.configPath, project: projectKey });
    } catch (err: unknown) {
      this.post({ type: 'pricing.state', status: 'error', error: (err as Error).message });
      return;
    }
    if (!config) {
      this.post({ type: 'pricing.state', status: 'error', error: 'No project found in acurast.json' });
      return;
    }
    if (patch) config = { ...config, ...patch } as typeof config;

    const network = (config.network ?? 'mainnet') as AcurastNetwork;
    const matcherOverrides = vscode.workspace.getConfiguration('acurast').get<Record<string, string>>('matcherUrls', {});
    const matcherUrl = matcherOverrides[network] ?? MATCHER_ENDPOINTS[network];
    const activeWallet = await this.wallet.getActive();

    let result;
    try {
      result = await loadPricing({ config, walletAddress: activeWallet?.address, matcherUrl });
    } catch (err: unknown) {
      this.post({ type: 'pricing.state', status: 'error', error: (err as Error).message });
      return;
    }
    const { fees, advice, fallbackReason, error } = result;

    const fiat = await this.loadFiatConversion();

    this.post({
      type: 'pricing.state',
      status: 'ok',
      symbol: SYMBOL[network],
      fees: {
        numberOfExecutions: fees.numberOfExecutions.toFixed(),
        numberOfReplicas: fees.numberOfReplicas.toFixed(),
        totalRuns: fees.totalRuns.toFixed(),
        maxCostPerExecution: fees.maxCostPerExecution.toFixed(),
        maxCostPerExecutionCACU: fees.maxCostPerExecutionCACU.toFixed(),
        maxCostPerExecutionPerReplicaCACU: fees.maxCostPerExecutionPerReplicaCACU.toFixed(),
        suggestedCostPerExecution: fees.suggestedCostPerExecution.toFixed(),
        suggestedCostPerExecutionCACU: toCacu(fees.suggestedCostPerExecution).toFixed(),
        maxTotalCostCACU: fees.maxTotalCostCACU.toFixed(),
        excessCostPerExecution: fees.excessCostPerExecution.toFixed(),
        excessCostPerExecutionPercentage: fees.excessCostPerExecutionPercentage.toFixed(),
      },
      advice: advice ? {
        status: advice.status,
        matchedProcessors: advice.matchedProcessors,
        requiredProcessors: advice.requiredProcessors,
        currentPrice: advice.currentPrice.toFixed(),
        suggestedPrice: advice.suggestedPrice?.toFixed() ?? null,
        averagePrice: advice.averagePrice?.toFixed() ?? null,
        distribution: advice.distribution,
      } : undefined,
      fiat,
      fallbackReason,
      error,
    });
  }

  private async loadFiatConversion(): Promise<PricingFiatInfo | undefined> {
    const cfg = vscode.workspace.getConfiguration('acurast');
    const exchangerId = cfg.get<number>('fiat.exchangerId', 2);
    const currencyId = (cfg.get<string>('fiat.currencyId', '') ?? '').trim();
    if (!currencyId) return undefined;

    const exchanger = this._exchanger.byId(exchangerId);
    if (!exchanger) return undefined;

    const details = exchanger.exchangerDetails();

    // Base is always ACU, so exchanger + quote currency identify the rate.
    const cacheKey = `${exchangerId}:${currencyId.toLowerCase()}`;
    const cache = this.globalState.get<FiatPriceCache>(FIAT_PRICE_CACHE_KEY, {});
    const cached = cache[cacheKey];
    if (cached && Date.now() - cached.fetchedAt < FIAT_PRICE_TTL_MS) {
      return {
        exchangerId,
        exchangerName: details.name,
        currencyId,
        currencyName: cached.meta?.name ?? currencyId,
        currencySign: cached.meta?.sign ?? '',
        currencySymbol: cached.meta?.symbol ?? currencyId.toUpperCase(),
        acuPriceFiat: cached.acuPriceFiat,
        fetchedAt: cached.fetchedAt,
      };
    }

    this.applyCoinGeckoPlan(exchanger);
    const apiKey = await this.secrets.get(FIAT_API_KEY_SECRET(exchangerId));
    if (apiKey) exchanger.setApiKey(apiKey);

    // Resolve currency metadata from the exchanger's fiat list (best-effort).
    let meta: FiatListItem | undefined;
    try {
      const list = await exchanger.getListOfFiat();
      meta = list.data.find(c => c.id === currencyId || c.symbol === currencyId.toUpperCase());
    } catch {
      // Metadata is best-effort; we still try the price.
    }
    const fiatSymbolForPrice = meta?.symbol ?? currencyId;

    let acuPriceFiat: number;
    const fetchedAt = Date.now();
    try {
      acuPriceFiat = await exchanger.getACULatestPrice(fiatSymbolForPrice);
    } catch (err: unknown) {
      return {
        exchangerId,
        exchangerName: details.name,
        currencyId,
        currencyName: meta?.name ?? currencyId,
        currencySign: meta?.sign ?? '',
        currencySymbol: meta?.symbol ?? currencyId.toUpperCase(),
        acuPriceFiat: 0,
        fetchedAt,
        error: (err as Error).message,
      };
    }

    // Persist the fresh rate, dropping entries already past the TTL.
    const pruned: FiatPriceCache = Object.fromEntries(
      Object.entries(cache).filter(([, e]) => Date.now() - e.fetchedAt < FIAT_PRICE_TTL_MS));
    pruned[cacheKey] = { acuPriceFiat, fetchedAt, meta };
    await this.globalState.update(FIAT_PRICE_CACHE_KEY, pruned);

    return {
      exchangerId,
      exchangerName: details.name,
      currencyId,
      currencyName: meta?.name ?? currencyId,
      currencySign: meta?.sign ?? '',
      currencySymbol: meta?.symbol ?? currencyId.toUpperCase(),
      acuPriceFiat,
      fetchedAt,
    };
  }

  private async pushFiatList(exchangerId: number, apiKey?: string, coingeckoPlan?: CoinGeckoPlan) {
    this.post({ type: 'fiat.listState', status: 'loading', exchangerId });
    const exchanger = this._exchanger.byId(exchangerId);
    if (!exchanger) {
      this.post({ type: 'fiat.listState', status: 'error', exchangerId, error: `Unknown exchanger id ${exchangerId}` });
      return;
    }
    this.applyCoinGeckoPlan(exchanger, coingeckoPlan);
    // Prefer the just-typed key, fall back to the saved one.
    const key = (apiKey && apiKey.trim()) || await this.secrets.get(FIAT_API_KEY_SECRET(exchangerId));
    if (key) exchanger.setApiKey(key);
    try {
      const list = await exchanger.getListOfFiat();
      this.post({ type: 'fiat.listState', status: 'ok', exchangerId, list: list.data });
    } catch (err: unknown) {
      this.post({ type: 'fiat.listState', status: 'error', exchangerId, error: (err as Error).message });
    }
  }

  private async saveFiatSelection(exchangerId: number, currencyId: string, apiKey?: string, coingeckoPlan?: CoinGeckoPlan) {
    const cfg = vscode.workspace.getConfiguration('acurast');
    await cfg.update('fiat.exchangerId', exchangerId, vscode.ConfigurationTarget.Global);
    await cfg.update('fiat.currencyId', currencyId, vscode.ConfigurationTarget.Global);
    if (coingeckoPlan !== undefined) {
      await cfg.update('fiat.coingecko.plan', coingeckoPlan, vscode.ConfigurationTarget.Global);
    }
    if (apiKey !== undefined) {
      const trimmed = apiKey.trim();
      if (trimmed) await this.secrets.store(FIAT_API_KEY_SECRET(exchangerId), trimmed);
      else await this.secrets.delete(FIAT_API_KEY_SECRET(exchangerId));
    }
    // Fiat settings changed (currency, exchanger, key, or plan) — drop cached
    // rates so the next pricing push fetches fresh.
    await this.globalState.update(FIAT_PRICE_CACHE_KEY, undefined);
    await this.pushFiatSelection();
    void this.pushPricing();
  }

  private async pushFiatSelection() {
    const cfg = vscode.workspace.getConfiguration('acurast');
    const exchangerId = cfg.get<number>('fiat.exchangerId', 2);
    const currencyId = cfg.get<string>('fiat.currencyId', '') ?? '';
    const coingeckoPlan = (cfg.get<string>('fiat.coingecko.plan', 'demo') as CoinGeckoPlan);
    const hasApiKey = Boolean(await this.secrets.get(FIAT_API_KEY_SECRET(exchangerId)));
    this.post({ type: 'fiat.selection', exchangerId, currencyId, hasApiKey, coingeckoPlan });
  }

  /** Applies the configured CoinGecko plan to the instance (no-op for other exchangers). */
  private applyCoinGeckoPlan(exchanger: { exchangerDetails: () => { id: number } }, override?: CoinGeckoPlan) {
    if (exchanger.exchangerDetails().id !== 2) return;
    const plan = override ?? (vscode.workspace.getConfiguration('acurast').get<string>('fiat.coingecko.plan', 'demo') as CoinGeckoPlan);
    (exchanger as CoinGecko).setPlan(plan);
  }

  private async openJson() {
    if (!this.ctx.configPath) return;
    await vscode.window.showTextDocument(vscode.Uri.file(this.ctx.configPath));
  }

  /* ---------------- Deploy state ---------------- */

  beginDeploy(opts: { project: string; network: string; enableDevtools?: boolean; hasBuild?: boolean }) {
    const stages = defaultStages(opts.hasBuild);
    stages[0].status = 'active';
    this._deploy = {
      active: true,
      startedAt: Date.now(),
      project: opts.project,
      network: opts.network,
      jobIds: [],
      stages,
      chainEvents: [],
      watching: false,
      devtoolsEnabled: !!opts.enableDevtools,
    };
    void this.stopChainWatch();
    void this.navigate('deploy');
  }

  /**
   * Append captured output to the currently active deploy stage, so the webview
   * can show per-stage, color-coded logs. Lines are ANSI-stripped (the channel
   * keeps the raw text). No-ops when no deploy is in progress.
   */
  appendDeployLog(level: LogLevel, text: string) {
    if (!this._deploy || text == null) return;
    const d = this._deploy;

    // Attribute to the active stage; fall back to the latest non-pending stage.
    let stage = d.stages.find((s) => s.status === 'active');
    if (!stage) {
      for (let i = d.stages.length - 1; i >= 0; i--) {
        if (d.stages[i].status !== 'pending') { stage = d.stages[i]; break; }
      }
    }
    if (!stage) stage = d.stages[0];
    if (!stage.logs) stage.logs = [];

    const ts = Date.now();
    const lines = stripAnsi(String(text)).split('\n');
    // Drop one trailing empty line (from a trailing newline) so logs don't gap.
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    for (const line of lines) stage.logs.push({ level, text: line, ts });

    // Bound per-stage history; the full log always remains in the output channel.
    const CAP = 1000;
    if (stage.logs.length > CAP) stage.logs.splice(0, stage.logs.length - CAP);

    this.scheduleDeployPush();
  }

  recordDeployStatus(status: string, data: unknown) {
    if (!this._deploy) return;
    const d = this._deploy;

    const idxOf = (id: DeployStageId) => d.stages.findIndex((s) => s.id === id);
    const setStatus = (id: DeployStageId, status: StageStatus, detail?: string) => {
      const stage = d.stages.find((s) => s.id === id);
      if (!stage) return;
      stage.status = status;
      if (detail !== undefined) stage.detail = detail;
    };
    const advanceTo = (id: DeployStageId) => {
      const idx = idxOf(id);
      if (idx < 0) return;
      for (let i = 0; i < idx; i++) {
        if (d.stages[i].status === 'pending' || d.stages[i].status === 'active') {
          d.stages[i].status = 'done';
        }
      }
      if (d.stages[idx].status === 'pending') d.stages[idx].status = 'active';
    };

    const obj = (data ?? {}) as Record<string, unknown>;

    // jobIds arrive on WaitingForMatch and Matched as [[{acurast: addr}, localId]]
    const incomingJobIds = parseJobIds(obj.jobIds);
    if (incomingJobIds.length) d.jobIds = mergeJobIds(d.jobIds, incomingJobIds);

    switch (status) {
      // Build is driven by the extension (deploy.ts), not the SDK. setStatus/advanceTo
      // no-op when the build stage is absent, so emitting these is harmless then.
      case 'Building': {
        setStatus('build', 'active');
        break;
      }
      case 'Built': {
        setStatus('build', 'done');
        advanceTo('bundle');
        break;
      }
      case 'Uploaded': {
        const hash = typeof obj.ipfsHash === 'string' ? obj.ipfsHash : undefined;
        if (hash) d.ipfsHash = hash;
        setStatus('bundle', 'done');
        setStatus('upload', 'done', hash);
        advanceTo('prepare');
        break;
      }
      case 'Prepared': {
        setStatus('prepare', 'done');
        advanceTo('submit');
        break;
      }
      case 'Submit': {
        const tx = typeof obj.txHash === 'string' ? obj.txHash : undefined;
        if (tx) d.txHash = tx;
        setStatus('submit', 'done', tx);
        advanceTo('match');
        break;
      }
      case 'WaitingForMatch': {
        // SDK can emit WaitingForMatch before Submit's txHash arrives.
        setStatus('submit', d.txHash ? 'done' : 'active');
        advanceTo('match');
        break;
      }
      case 'Matched': {
        setStatus('match', 'done');
        advanceTo('acknowledge');
        break;
      }
      case 'Acknowledged': {
        const n = typeof obj.acknowledged === 'number' ? obj.acknowledged : 1;
        d.ackCount = n;
        setStatus('acknowledge', 'done', `${n} processor${n === 1 ? '' : 's'}`);
        advanceTo('envvars');
        void this.queryProcessors();
        void this.startChainWatch();
        break;
      }
      case 'EnvironmentVariablesSet': {
        setStatus('envvars', 'done');
        break;
      }
    }
    this.pushDeploy();
  }

  endDeploy(result: 'ok' | 'error', message?: string) {
    if (!this._deploy) return;
    this._deploy.active = false;
    this._deploy.finishedAt = Date.now();
    this._deploy.result = result;
    this._deploy.errorMessage = message;
    if (result === 'error') {
      const active = this._deploy.stages.find((s) => s.status === 'active');
      if (active) active.status = 'error';
      void this.stopChainWatch();
    }
    if (result === 'ok') void this.saveDeploymentRecord(this._deploy);
    this.pushDeploy();
  }

  private async saveDeploymentRecord(d: DeployState): Promise<void> {
    await this.deploymentStore.save({
      id: randomUUID(),
      project: d.project ?? 'unknown',
      network: d.network ?? 'mainnet',
      startedAt: d.startedAt,
      finishedAt: d.finishedAt ?? Date.now(),
      jobIds: d.jobIds,
      ipfsHash: d.ipfsHash,
      txHash: d.txHash,
      projectPath: this.ctx.projectRoot ?? undefined,
    });
  }

  private async pushHistory(offset = 0): Promise<void> {
    const all = this.localHistoryWithMeta();
    const records = all.slice(offset, offset + HISTORY_PAGE_SIZE);
    this.post({
      type: 'history.state',
      status: 'ok',
      records,
      offset,
      hasMore: offset + HISTORY_PAGE_SIZE < all.length,
      total: all.length,
    } satisfies HistoryStateMsg);
    // Resolve each record's on-chain lifecycle status in the background so the
    // local list renders instantly; the webview shows a spinner until this lands.
    void this.enrichLocalStatuses(records, ++this._historyGen);
  }

  /** True while the given enrichment token is still the latest and the user is
   * still viewing history. Clicking Home (route change) effectively cancels the
   * pending result — we can't abort the RPC, but we won't act on it. */
  private historyEnrichmentCurrent(gen: number): boolean {
    return gen === this._historyGen && this._route === 'history';
  }

  /** Query the chain for the lifecycle status of each local record's job and
   * post them back keyed by record id. Best-effort: a network/decoding failure
   * resolves the affected records to `none` rather than spinning forever. */
  private async enrichLocalStatuses(records: StoredDeploymentWithMeta[], gen: number): Promise<void> {
    const withJobs = records.filter((r) => r.jobIds[0]);
    if (!withJobs.length) return;

    // Group by network so we connect to each chain at most once.
    const byNetwork = new Map<string, StoredDeploymentWithMeta[]>();
    for (const r of withJobs) {
      (byNetwork.get(r.network) ?? byNetwork.set(r.network, []).get(r.network)!).push(r);
    }

    const statuses: Record<string, LocalJobStatus> = {};
    for (const [network, recs] of byNetwork) {
      const regByKey = new Map<string, OnlineJobRegistration>();
      const origins = [...new Set(recs.flatMap((r) => r.jobIds.map((j) => j.origin)))];
      for (const origin of origins) {
        // Abandon if a newer load started or the user left history mid-query.
        if (!this.historyEnrichmentCurrent(gen)) return;
        try {
          const m = await this.registrationsByLocalId(network, origin);
          for (const [localId, reg] of m) regByKey.set(`${origin}:${localId}`, reg);
        } catch { /* origin/network unreachable — its records resolve to `none` below */ }
      }
      for (const r of recs) {
        const j = r.jobIds[0];
        const reg = regByKey.get(`${j.origin}:${j.localId}`);
        statuses[r.id] = reg ? this.jobLifecycle(reg) : 'none';
      }
    }
    // Don't post a stale result onto a list the user already navigated away from.
    if (!this.historyEnrichmentCurrent(gen)) return;
    this.post({ type: 'history.state', status: 'ok', statuses } satisfies HistoryStateMsg);
  }

  private jobLifecycle(reg: OnlineJobRegistration): LocalJobStatus {
    const now = Date.now();
    if (reg.startTime > now) return 'scheduled';
    if (reg.endTime < now) return 'expired';
    return 'active';
  }

  /** Partial-key query of a single address's on-chain job registrations,
   * decoded and keyed by localId. Shared by online history + local enrichment. */
  private async registrationsByLocalId(network: string, address: string): Promise<Map<number, OnlineJobRegistration>> {
    const svc = await acurastClient.service(network as AcurastNetwork);
    const api = await svc.connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const multiOrigin = (api as any).createType('AcurastCommonMultiOrigin', { acurast: address });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const jobEntries: [any, any][] = await (api.query['acurast']['storedJobRegistration'] as any).entries(multiOrigin);
    const map = new Map<number, OnlineJobRegistration>();
    for (const [key, value] of jobEntries) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const localId: number = (api as any).createType('u128', key.args.at(1)).toNumber();
      const reg = this.decodeRegistration(api, value);
      if (reg) map.set(localId, reg);
    }
    return map;
  }

  /** Decode a `storedJobRegistration` value into our flat shape, or undefined
   * if the value is None / codec-mismatched. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private decodeRegistration(api: any, value: any): OnlineJobRegistration | undefined {
    try {
      const job = api.createType('Option<AcurastCommonJobRegistration>', value).unwrap();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = job.toJSON() as any;
      const sched = j.schedule ?? {};
      const req = j.extra?.requirements ?? {};
      const strat = req.assignmentStrategy ?? {};

      let scriptUrl: string | undefined;
      try {
        const decoded = Buffer.from(String(j.script ?? '').replace(/^0x/, ''), 'hex').toString('utf8');
        if (/^(https?|ipfs):\/\//i.test(decoded)) scriptUrl = decoded.trim();
      } catch { /* not a URL — skip */ }

      return {
        startTime: Number(sched.startTime ?? 0),
        endTime: Number(sched.endTime ?? 0),
        intervalMs: String(sched.interval ?? 0),
        durationMs: Number(sched.duration ?? 0),
        maxStartDelay: Number(sched.maxStartDelay ?? 0),
        slots: Number(req.slots ?? 1),
        rewardPlanck: String(req.reward ?? 0),
        strategy: strat.competing !== undefined ? 'Competing' : 'Single',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        modules: (j.requiredModules ?? []).map((m: any) => String(m)),
        scriptUrl,
      };
    } catch { return undefined; }
  }

  private localHistoryWithMeta(): StoredDeploymentWithMeta[] {
    return this.deploymentStore.getAll()
      .map((r): StoredDeploymentWithMeta => ({
        ...r,
        pathExists: r.projectPath ? fs.existsSync(r.projectPath) : false,
      }))
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  private async fetchOnlineHistory(address: string, network: string): Promise<void> {
    // Loading: don't include records — client keeps its accumulated list intact
    this.post({ type: 'history.state', status: 'loading' } satisfies HistoryStateMsg);
    try {
      const svc = await acurastClient.service(network as AcurastNetwork);
      const api = await svc.connect();
      // Partial-key query: only fetch jobs for this address (avoids full-chain scan)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const multiOrigin = (api as any).createType('AcurastCommonMultiOrigin', { acurast: address });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jobEntries: [any, any][] = await (api.query['acurast']['storedJobRegistration'] as any).entries(multiOrigin);
      // Build a set of job keys already saved locally so we skip duplicates
      const savedKeys = new Set(
        this.deploymentStore.getAll()
          .flatMap(r => r.jobIds.map(j => `${j.origin}:${j.localId}`))
      );
      const onlineRecords: StoredDeploymentWithMeta[] = jobEntries
        .map(([key, value]) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const localId: number = (api as any).createType('u128', key.args.at(1)).toNumber();
          const registration = this.decodeRegistration(api, value);

          return {
            id: `online:${address}:${localId}`,
            project: 'on-chain',
            network,
            startedAt: registration?.startTime ?? 0,
            finishedAt: registration?.endTime ?? 0,
            jobIds: [{ origin: address, localId }],
            pathExists: false,
            registration,
          };
        })
        .filter(r => !savedKeys.has(`${r.jobIds[0].origin}:${r.jobIds[0].localId}`));
      this.post({ type: 'history.state', status: 'ok', onlineRecords } satisfies HistoryStateMsg);
    } catch (err) {
      this.post({ type: 'history.state', status: 'error', error: (err as Error).message } satisfies HistoryStateMsg);
    }
  }

  private async diagnoseJob(origin: string, localId: number, network: string): Promise<void> {
    const key = `${origin}:${localId}`;
    this.post({ type: 'diagnosis.state', key, status: 'loading' } satisfies DiagnosisStateMsg);
    try {
      const result = await acurastClient.diagnoseJob(network as AcurastNetwork, origin, localId);
      this.post({ type: 'diagnosis.state', key, status: 'ok', result } satisfies DiagnosisStateMsg);
    } catch (err) {
      this.post({ type: 'diagnosis.state', key, status: 'error', error: (err as Error).message } satisfies DiagnosisStateMsg);
    }
  }

  private pushDeploy() {
    if (this._deployPushTimer) { clearTimeout(this._deployPushTimer); this._deployPushTimer = undefined; }
    this.post({ type: 'deploy.state', state: this._deploy });
  }

  // Coalesce rapid log appends into ~one post per frame so a verbose build doesn't
  // flood the webview with full-state messages. A status change / endDeploy flushes
  // immediately via pushDeploy (which clears this timer).
  private scheduleDeployPush() {
    if (this._deployPushTimer) return;
    this._deployPushTimer = setTimeout(() => {
      this._deployPushTimer = undefined;
      this.post({ type: 'deploy.state', state: this._deploy });
    }, 80);
  }

  async fetchDevtoolsUrl(): Promise<void> {
    const d = this._deploy;
    if (!d || !d.jobIds.length) return;
    const localId = d.jobIds[0].localId;
    d.devtoolsLoading = true;
    this.pushDeploy();
    try {
      const url = await this.runDevtoolsCommand(localId);
      if (this._deploy) this._deploy.devtoolsUrl = url;
    } catch {
      // URL can be retried with the Refresh key button
    } finally {
      if (this._deploy) this._deploy.devtoolsLoading = false;
      this.pushDeploy();
    }
  }

  private runDevtoolsCommand(localId: number): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.ctx.cliPath, ['devtools', String(localId)], (err, stdout, stderr) => {
        if (err) { reject(err); return; }
        const combined = stdout + stderr;
        const match = combined.match(/https?:\/\/\S+/);
        if (match) resolve(match[0].replace(/[,;)\]'"]+$/, ''));
        else reject(new Error('No URL in devtools output'));
      });
    });
  }

  private async queryProcessors() {
    const d = this._deploy;
    if (!d || !d.jobIds.length) return;
    const network = (d.network ?? 'mainnet') as AcurastNetwork;
    d.processors = { status: 'loading', list: d.processors?.list };
    this.pushDeploy();
    try {
      const svc = await acurastClient.service(network);
      if (!svc.api) throw new Error('SDK service has no api after connect');
      const all: ProcessorInfo[] = [];
      for (const j of d.jobIds) {
        const chainJobId: [{ acurast: string }, number] = [{ acurast: j.origin }, j.localId];
        const infos = await getAcknowledgedProcessors(svc.api, chainJobId);
        for (const info of infos) all.push(this.toProcessorInfo(info));
      }
      d.processors = { status: 'ok', list: all, fetchedAt: Date.now() };
      // Pull the job's on-chain schedule so the webview can render each
      // processor's real first-run time (startTime + per-processor startDelay).
      const j0 = d.jobIds[0];
      try {
        const reg = (await this.registrationsByLocalId(network, j0.origin)).get(j0.localId);
        if (reg) d.schedule = { startTime: reg.startTime, endTime: reg.endTime, maxStartDelay: reg.maxStartDelay };
      } catch { /* schedule is best-effort; processors still render without it */ }
    } catch (err: unknown) {
      d.processors = { status: 'error', message: (err as Error).message, fetchedAt: Date.now() };
    }
    this.pushDeploy();
  }

  /** Map one `getAcknowledgedProcessors` entry to the webview `ProcessorInfo` shape. */
  private toProcessorInfo(info: Awaited<ReturnType<typeof getAcknowledgedProcessors>>[number]): ProcessorInfo {
    return {
      address: info.processor,
      slot: info.assignment.slot,
      startDelay: info.assignment.startDelay,
      feePerExecution: info.assignment.feePerExecution?.toString(),
      acknowledged: info.assignment.acknowledged,
      slaTotal: info.assignment.sla?.total?.toString(),
      slaMet: info.assignment.sla?.met?.toString(),
      pubKeys: flattenPubKeys(info.assignment.pubKeys),
    };
  }

  /** On-demand fetch of one job's per-processor assignments for the History view,
   * posted keyed by `${origin}:${localId}` (mirrors diagnosis/deregister). */
  private async fetchJobAssignments(origin: string, localId: number, network: string): Promise<void> {
    const key = `${origin}:${localId}`;
    this.post({ type: 'assignments.state', key, status: 'loading' } satisfies AssignmentsStateMsg);
    try {
      const svc = await acurastClient.service(network as AcurastNetwork);
      if (!svc.api) throw new Error('SDK service has no api after connect');
      const chainJobId: [{ acurast: string }, number] = [{ acurast: origin }, localId];
      const infos = await getAcknowledgedProcessors(svc.api, chainJobId);
      const processors = infos.map((info) => this.toProcessorInfo(info));
      this.post({ type: 'assignments.state', key, status: 'ok', processors } satisfies AssignmentsStateMsg);
    } catch (err: unknown) {
      this.post({ type: 'assignments.state', key, status: 'error', error: (err as Error).message } satisfies AssignmentsStateMsg);
    }
  }

  /** Public entrypoint used by commands (e.g. advertiseModules) to refresh the Processors view. */
  async refreshProcessors(address: string, network: string) {
    await this.fetchProcessors(address, network);
  }

  private async fetchProcessors(address: string, network: string) {
    this.post({ type: 'processors.state', status: 'loading', address, network } satisfies ProcessorsStateMsg);
    try {
      const result = await acurastClient.getManagedProcessors(network as AcurastNetwork, address);
      this.post({ type: 'processors.state', status: 'ok', address, network, result } satisfies ProcessorsStateMsg);
    } catch (err) {
      this.post({ type: 'processors.state', status: 'error', address, network, error: (err as Error).message } satisfies ProcessorsStateMsg);
    }
  }

  private async startChainWatch() {
    const d = this._deploy;
    if (!d || !d.jobIds.length) return;
    await this.stopChainWatch();
    const token = ++this._chainWatchToken;
    const network = (d.network ?? 'mainnet') as AcurastNetwork;

    const targets = new Map<number, string>(d.jobIds.map((j) => [j.localId, j.origin]));
    const seen = new Set<string>();

    try {
      const svc = await acurastClient.service(network);
      if (token !== this._chainWatchToken) return;

      const onEvent = (entry: ChainEvent) => {
        if (token !== this._chainWatchToken) return;
        if (!this._deploy) return;
        // De-dupe by (label, jobId, summary): label is shared between V1/V2
        // event variants so we collapse those to a single row.
        const dedupeKey = `${entry.label}.${entry.jobLocalId ?? ''}.${entry.summary}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        this._deploy.chainEvents.push(entry);
        this.pushDeploy();
      };

      this._chainEventUnsub = await svc.subscribeToEvent({
        filter: (event) => event.section === 'acurast' || event.section === 'acurastMarketplace',
        map: (event) => {
          const dataJson = event.data?.toJSON?.() as unknown;
          const { kind, label } = lookupEvent(event.section, event.method);
          return {
            ts: Date.now(),
            section: event.section,
            method: event.method,
            jobLocalId: findJobLocalIdInData(dataJson, targets),
            summary: safeStringifyShort(dataJson),
            kind,
            label,
          } satisfies ChainEvent;
        },
        sub: (entry) => {
          if (entry.jobLocalId === undefined) return; // not one of ours
          onEvent(entry);
        },
      });

      if (this._deploy) {
        this._deploy.watching = true;
        this.pushDeploy();
      }
    } catch (err: unknown) {
      // Best-effort; don't crash the panel if the subscription can't start.
      if (this._deploy) {
        this._deploy.watching = false;
        this.pushDeploy();
      }
      console.warn('Acurast chain watch failed to start:', (err as Error).message);
    }
  }

  dispose() {
    void this.stopChainWatch();
    this.stopBalancePoll();
  }

  private async stopChainWatch() {
    this._chainWatchToken++;
    if (this._chainEventUnsub) {
      try { this._chainEventUnsub(); } catch { /* ignore */ }
      this._chainEventUnsub = undefined;
    }
    if (this._deploy) {
      this._deploy.watching = false;
    }
  }

  /**
   * Deregister flow for the Deploy view: confirm, then unlock + submit via
   * `unlockAndDeregister`. Resolves with the tx hash, `null` if the user
   * cancelled any prompt, and rejects if the submit fails.
   */
  private async confirmAndDeregister(
    origin: string,
    localId: number,
    network: AcurastNetwork,
    onSubmitting?: () => void,
  ): Promise<string | null> {
    const confirm = await vscode.window.showWarningMessage(
      `Deregister deployment ${localId}?`,
      { modal: true, detail: `This cancels the job on-chain. It cannot be undone.\n\nOrigin: ${origin}\nNetwork: ${network}` },
      'Deregister'
    );
    if (confirm !== 'Deregister') return null;
    return this.unlockAndDeregister(origin, localId, network, onSubmitting);
  }

  /**
   * Resolve + unlock the active (signing) wallet, then sign and submit
   * `acurast.deregister(localId)`. `onSubmitting` fires exactly once — right
   * before the extrinsic is sent — so callers can flip into a "submitting" UI
   * only when prompts are cleared and a tx is actually going out. Resolves
   * with the tx hash, `null` if the user cancelled any prompt (no
   * `onSubmitting` was fired), and rejects if the submit fails.
   */
  private async unlockAndDeregister(
    origin: string,
    localId: number,
    network: AcurastNetwork,
    onSubmitting?: () => void,
  ): Promise<string | null> {
    const activeWallet = await this.wallet.getActive();
    if (!activeWallet) {
      vscode.window.showErrorMessage('No active wallet. Set one as active to sign the deregister tx.');
      return null;
    }
    if (activeWallet.address !== origin) {
      const proceed = await vscode.window.showWarningMessage(
        'Active wallet does not match the deployment origin. The chain will reject the tx.',
        { modal: true, detail: `Origin: ${origin}\nActive wallet: ${activeWallet.address}` },
        'Try anyway'
      );
      if (proceed !== 'Try anyway') return null;
    }

    const keypair = await this.promptKeypair(activeWallet, 'sign deregister');
    if (!keypair) return null;

    onSubmitting?.();
    const svc = await acurastClient.service(network);
    const hash = await svc.deregisterJob(keypair, localId);
    return hash.toHex();
  }

  /**
   * Password-prompt for `wallet` and derive its signing keypair. Returns null
   * if the user cancels the prompt; shows the error and returns null when the
   * password is wrong.
   */
  private async promptKeypair(wallet: WalletInfo, reason: string): Promise<Awaited<ReturnType<typeof walletFromMnemonic>> | null> {
    const password = await vscode.window.showInputBox({
      prompt: `Enter password for "${wallet.name}" to ${reason}`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return null;

    let mnemonic: string;
    try {
      mnemonic = await this.wallet.reveal(wallet.id, password);
    } catch (err: unknown) {
      vscode.window.showErrorMessage((err as Error).message);
      return null;
    }
    return walletFromMnemonic(mnemonic);
  }

  private async deregisterDeployment(origin: string, localId: number) {
    const d = this._deploy;
    if (!d) return;
    const target = d.jobIds.find((j) => j.origin === origin && j.localId === localId);
    if (!target) return;
    if (target.deregistering || target.deregistered) return;

    const network = (d.network ?? 'mainnet') as AcurastNetwork;
    try {
      const txHash = await this.confirmAndDeregister(origin, localId, network, () => {
        target.deregistering = true;
        target.deregisterError = undefined;
        this.pushDeploy();
      });
      if (txHash === null) return; // cancelled before submit — nothing was changed
      target.deregistering = false;
      target.deregistered = true;
      target.deregisterTxHash = txHash;
      vscode.window.showInformationMessage(`Deregistered deployment ${localId}`);
      this.pushDeploy();
      void this.queryProcessors();
      if (d.jobIds.every((j) => j.deregistered)) {
        await this.stopChainWatch();
        this.pushDeploy();
      }
    } catch (err: unknown) {
      const msg = (err as Error).message;
      target.deregistering = false;
      target.deregisterError = msg;
      vscode.window.showErrorMessage(`Deregister failed: ${msg}`);
      this.pushDeploy();
    }
  }

  /**
   * Consolidated History delete — the one trash button on both sections. For
   * a local record (`id` set) this removes the stored entry AND cancels the
   * job on-chain first when its registration still exists; for an
   * on-chain-only card (no `id`) it just deregisters. Progress is posted per
   * job via `deregister.state` (keyed `${origin}:${localId}`) so the webview
   * can spin the right card and drop it on success.
   */
  private async deleteHistoryRecord(id?: string, origin?: string, localId?: number, network?: string): Promise<void> {
    // No on-chain job recorded → plain local removal.
    if (origin === undefined || localId === undefined) {
      if (id) {
        await this.deploymentStore.remove(id);
        await this.pushHistory();
      }
      return;
    }

    const key = `${origin}:${localId}`;
    const net = (network || 'mainnet') as AcurastNetwork;

    const confirm = await vscode.window.showWarningMessage(
      `Delete deployment ${localId}?`,
      {
        modal: true,
        detail:
          (id
            ? 'This removes the record from local history and cancels the job on-chain if it is still registered.'
            : 'This cancels (deregisters) the job on-chain.') +
          ` It cannot be undone.\n\nOrigin: ${origin}\nNetwork: ${net}`,
      },
      'Delete'
    );
    if (confirm !== 'Delete') return;

    // Spin the card while we look up whether the registration still exists —
    // a job already gone from chain storage has nothing left to deregister.
    this.post({ type: 'deregister.state', key, status: 'loading' } satisfies DeregisterStateMsg);
    let registered: boolean;
    try {
      registered = (await this.registrationsByLocalId(net, origin)).has(localId);
    } catch (err: unknown) {
      const msg = (err as Error).message;
      if (!id) {
        // On-chain-only card: deregistering is all delete can do here.
        this.post({ type: 'deregister.state', key, status: 'error', error: msg } satisfies DeregisterStateMsg);
        return;
      }
      // Local record on an unreachable chain — offer the local-only removal.
      const anyway = await vscode.window.showWarningMessage(
        'Could not check the job on-chain. Delete the local record anyway?',
        { modal: true, detail: msg },
        'Delete locally'
      );
      if (anyway !== 'Delete locally') {
        this.post({ type: 'deregister.state', key, status: 'idle' } satisfies DeregisterStateMsg);
        return;
      }
      registered = false;
    }

    if (registered) {
      try {
        const txHash = await this.unlockAndDeregister(origin, localId, net);
        if (txHash === null) {
          // A wallet/password prompt was cancelled — abort the whole delete.
          this.post({ type: 'deregister.state', key, status: 'idle' } satisfies DeregisterStateMsg);
          return;
        }
        this.post({ type: 'deregister.state', key, status: 'ok', txHash } satisfies DeregisterStateMsg);
      } catch (err: unknown) {
        const msg = (err as Error).message;
        // Keep the local record so the delete can be retried.
        this.post({ type: 'deregister.state', key, status: 'error', error: msg } satisfies DeregisterStateMsg);
        vscode.window.showErrorMessage(`Deregister failed: ${msg}`);
        return;
      }
    } else {
      // Nothing left on-chain; the card can go regardless.
      this.post({ type: 'deregister.state', key, status: 'ok' } satisfies DeregisterStateMsg);
    }

    if (id) await this.deploymentStore.remove(id);
    vscode.window.showInformationMessage(
      registered ? `Deregistered deployment ${localId}` : `Deleted deployment ${localId}`
    );
    // Re-query the local list so the removed record drops out immediately.
    if (this._route === 'history') await this.pushHistory();
  }

  /**
   * Bulk delete for the History multi-select. One confirm and one password
   * prompt for the whole selection, then one `utility.forceBatch` of
   * `acurast.deregister` calls per network — forceBatch keeps going past
   * failing items, which is what a bulk cleanup wants. Items whose
   * registration is already gone from chain storage skip the batch and are
   * treated as successes. Per-item outcomes go out via `deregister.state`
   * (keyed `${origin}:${localId}`) so the existing card plumbing spins, drops
   * and errors each card; local records are removed only for items that
   * succeeded, so failures stay visible and retryable.
   */
  private async bulkDeleteHistory(items: HistoryBulkItem[]): Promise<void> {
    if (!items.length) return;
    const withJobs = items.filter((i) => i.origin !== undefined && i.localId !== undefined);
    const localOnly = items.filter((i) => (i.origin === undefined || i.localId === undefined) && i.id);
    const keyOf = (i: HistoryBulkItem) => `${i.origin}:${i.localId}`;
    const plural = (n: number) => (n === 1 ? '' : 's');

    const localCount = items.filter((i) => i.id).length;
    const parts: string[] = [];
    if (localCount) parts.push(`${localCount} local record${plural(localCount)} will be removed`);
    if (withJobs.length) parts.push(`up to ${withJobs.length} job${plural(withJobs.length)} will be deregistered on-chain`);
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${items.length} deployment${plural(items.length)}?`,
      { modal: true, detail: `${parts.join(' and ')}. This cannot be undone.` },
      'Delete'
    );
    if (confirm !== 'Delete') return;

    let keypair: Awaited<ReturnType<typeof walletFromMnemonic>> | null = null;
    if (withJobs.length) {
      const activeWallet = await this.wallet.getActive();
      if (!activeWallet) {
        vscode.window.showErrorMessage('No active wallet. Set one as active to sign the deregister batch.');
        return;
      }
      const foreign = withJobs.filter((i) => i.origin !== activeWallet.address).length;
      if (foreign) {
        const proceed = await vscode.window.showWarningMessage(
          `${foreign} of the selected job${plural(foreign)} were not deployed by the active wallet — the chain will reject those deregistrations.`,
          { modal: true, detail: `Active wallet: ${activeWallet.address}` },
          'Continue'
        );
        if (proceed !== 'Continue') return;
      }
      keypair = await this.promptKeypair(activeWallet, 'sign the deregister batch');
      if (!keypair) return;
    }

    // All prompts cleared — spin every selected card while the batches run.
    for (const i of withJobs) {
      this.post({ type: 'deregister.state', key: keyOf(i), status: 'loading' } satisfies DeregisterStateMsg);
    }

    const byNetwork = new Map<string, HistoryBulkItem[]>();
    for (const i of withJobs) {
      const net = i.network || 'mainnet';
      (byNetwork.get(net) ?? byNetwork.set(net, []).get(net)!).push(i);
    }

    const removableIds: string[] = localOnly.map((i) => i.id!);
    let failed = 0;
    for (const [network, jobs] of byNetwork) {
      const net = network as AcurastNetwork;

      // Which registrations still exist on-chain? Gone ones are successes
      // with nothing to sign.
      const regKeys = new Set<string>();
      try {
        for (const origin of [...new Set(jobs.map((i) => i.origin!))]) {
          const m = await this.registrationsByLocalId(net, origin);
          for (const localId of m.keys()) regKeys.add(`${origin}:${localId}`);
        }
      } catch (err: unknown) {
        // Chain unreachable — fail this network's items, keep their records.
        const msg = (err as Error).message;
        for (const i of jobs) {
          this.post({ type: 'deregister.state', key: keyOf(i), status: 'error', error: msg } satisfies DeregisterStateMsg);
        }
        failed += jobs.length;
        continue;
      }

      const registered = jobs.filter((i) => regKeys.has(keyOf(i)));
      for (const i of jobs.filter((j) => !regKeys.has(keyOf(j)))) {
        this.post({ type: 'deregister.state', key: keyOf(i), status: 'ok' } satisfies DeregisterStateMsg);
        if (i.id) removableIds.push(i.id);
      }
      if (!registered.length) continue;

      try {
        const { txHash, itemErrors } = await this.submitDeregisterBatch(net, keypair!, registered.map((i) => i.localId!));
        registered.forEach((i, idx) => {
          const itemError = itemErrors[idx];
          if (itemError) {
            failed++;
            this.post({ type: 'deregister.state', key: keyOf(i), status: 'error', error: itemError } satisfies DeregisterStateMsg);
          } else {
            this.post({ type: 'deregister.state', key: keyOf(i), status: 'ok', txHash } satisfies DeregisterStateMsg);
            if (i.id) removableIds.push(i.id);
          }
        });
      } catch (err: unknown) {
        const msg = (err as Error).message;
        failed += registered.length;
        for (const i of registered) {
          this.post({ type: 'deregister.state', key: keyOf(i), status: 'error', error: msg } satisfies DeregisterStateMsg);
        }
      }
    }

    for (const id of removableIds) await this.deploymentStore.remove(id);
    const ok = items.length - failed;
    if (failed) {
      vscode.window.showWarningMessage(`Bulk delete finished: ${ok} of ${items.length} deployment${plural(items.length)} deleted, ${failed} failed — see the History cards for details.`);
    } else {
      vscode.window.showInformationMessage(`Deleted ${items.length} deployment${plural(items.length)}`);
    }
    if (this._route === 'history') await this.pushHistory();
  }

  /**
   * Submit one `utility.forceBatch` of `acurast.deregister(localId)` calls and
   * resolve with the tx hash plus per-item errors parsed from the batch's
   * ItemCompleted/ItemFailed events (emitted in call order). Rejects only when
   * the batch extrinsic itself fails to execute.
   */
  private async submitDeregisterBatch(
    network: AcurastNetwork,
    keypair: Awaited<ReturnType<typeof walletFromMnemonic>>,
    localIds: number[],
  ): Promise<{ txHash: string; itemErrors: (string | undefined)[] }> {
    const svc = await acurastClient.service(network);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const api = (await svc.connect()) as any;
    const calls = localIds.map((id) => api.tx['acurast']['deregister'](id));
    const call = api.tx['utility']['forceBatch'](calls);
    return new Promise((resolve, reject) => {
      let unsub: (() => void) | undefined;
      call
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .signAndSend(keypair, (result: any) => {
          const { status, events, dispatchError } = result;
          if (dispatchError) {
            unsub?.();
            reject(new Error(this.decodeDispatchError(api, dispatchError)));
            return;
          }
          if (status.isInBlock) {
            unsub?.();
            const itemErrors: (string | undefined)[] = [];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            for (const { event } of events as any[]) {
              if (event.section !== 'utility') continue;
              if (event.method === 'ItemCompleted') itemErrors.push(undefined);
              else if (event.method === 'ItemFailed') itemErrors.push(this.decodeDispatchError(api, event.data[0]));
            }
            resolve({ txHash: result.txHash.toHex(), itemErrors });
          }
        })
        .then((u: () => void) => { unsub = u; })
        .catch(reject);
    });
  }

  /** Decode a DispatchError into `section.name` (falls back to toString). */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private decodeDispatchError(api: any, err: any): string {
    try {
      if (err.isModule) {
        const meta = api.registry.findMetaError(err.asModule);
        return `${meta.section}.${meta.name}`;
      }
      return err.toString();
    } catch {
      return String(err);
    }
  }

  private async saveConfigPatch(projectKey: string, patch: Record<string, unknown>): Promise<void> {
    if (!this.ctx.configPath) return;
    const uri = vscode.Uri.file(this.ctx.configPath);
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const json = JSON.parse(new TextDecoder('utf-8').decode(data)) as {
        projects?: Record<string, Record<string, unknown>>;
      };
      if (!json.projects || !json.projects[projectKey]) {
        vscode.window.showErrorMessage(`Project "${projectKey}" not found in acurast.json`);
        return;
      }
      json.projects[projectKey] = { ...json.projects[projectKey], ...patch };
      await vscode.workspace.fs.writeFile(
        uri,
        new TextEncoder().encode(JSON.stringify(json, null, 2) + '\n')
      );
      vscode.window.showInformationMessage('Updated acurast.json');
    } catch (err: unknown) {
      vscode.window.showErrorMessage(`Save failed: ${(err as Error).message}`);
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'studio', 'global.css')
    );
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'dist', 'studio', 'webview.js')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
      `connect-src ${webview.cspSource}`,
    ].join('; ');
    const raw = fs.readFileSync(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'studio', 'webview.html').fsPath,
      'utf8'
    );
    return raw
      .replace('{{CSP}}', csp)
      .replace('{{STYLE_URI}}', styleUri.toString())
      .replace('{{SCRIPT_URI}}', scriptUri.toString())
      .replace('{{NONCE}}', nonce);
  }

}

function safeStringifyShort(v: unknown, max = 160): string {
  let s: string;
  try { s = JSON.stringify(v); }
  catch { s = String(v); }
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function flattenPubKeys(raw: unknown): ProcessorPubKey[] {
  if (!Array.isArray(raw)) return [];
  const out: ProcessorPubKey[] = [];
  for (const pk of raw) {
    if (!pk || typeof pk !== 'object') continue;
    for (const [curve, key] of Object.entries(pk as Record<string, unknown>)) {
      if (typeof key === 'string' && key.length) out.push({ curve, key });
    }
  }
  return out;
}

// Exact event → (kind, human label) map. Enumerated against canary + mainnet
// runtime metadata (see scripts/inspect-chain.mjs). V1 and V2 variants both
// included; the chain emits whichever is current.
const EVENT_MAP: Record<string, { kind: ChainEvent['kind']; label: string }> = {
  // acurast pallet — registration lifecycle
  'acurast.JobRegistrationStored': { kind: 'started', label: 'Registration stored' },
  'acurast.JobRegistrationStoredV2': { kind: 'started', label: 'Registration stored' },
  'acurast.JobRegistrationRemoved': { kind: 'finalized', label: 'Registration removed (deregistered)' },
  'acurast.ExecutionEnvironmentsUpdated': { kind: 'other', label: 'Env vars updated' },
  'acurast.ExecutionEnvironmentsUpdatedV2': { kind: 'other', label: 'Env vars updated' },
  'acurast.AllowedSourcesUpdated': { kind: 'other', label: 'Allowed sources updated' },
  'acurast.AllowedSourcesUpdatedV2': { kind: 'other', label: 'Allowed sources updated' },

  // acurastMarketplace pallet — matching / execution / finalization
  'acurastMarketplace.JobRegistrationMatched': { kind: 'started', label: 'Matched' },
  'acurastMarketplace.JobRegistrationMatchedV2': { kind: 'started', label: 'Matched' },
  'acurastMarketplace.JobRegistrationAssigned': { kind: 'started', label: 'Acknowledged by processor' },
  'acurastMarketplace.JobRegistrationAssignedV2': { kind: 'started', label: 'Acknowledged by processor' },
  'acurastMarketplace.JobExecutionMatched': { kind: 'started', label: 'Execution match' },
  'acurastMarketplace.JobExecutionMatchedV2': { kind: 'started', label: 'Execution match' },

  'acurastMarketplace.Reported': { kind: 'reported', label: 'Execution reported' },
  'acurastMarketplace.ReportedV2': { kind: 'reported', label: 'Execution reported' },
  'acurastMarketplace.ExecutionSuccess': { kind: 'reported', label: 'Execution success' },
  'acurastMarketplace.ExecutionFailure': { kind: 'reported', label: 'Execution failure' },

  'acurastMarketplace.JobFinalized': { kind: 'finalized', label: 'Finalized' },
  'acurastMarketplace.JobAssignmentsCleanedUp': { kind: 'finalized', label: 'Assignments cleaned up' },
  'acurastMarketplace.JobMatcherEntryCleanedUp': { kind: 'finalized', label: 'Matcher cleaned up' },
  'acurastMarketplace.ProcessorAssignmentsCleanedUp': { kind: 'finalized', label: 'Processor assignments cleaned up' },

  'acurastMarketplace.JobBecameImmutable': { kind: 'other', label: 'Became immutable' },
  'acurastMarketplace.JobScriptEdited': { kind: 'other', label: 'Script edited' },
  'acurastMarketplace.EditorTransferred': { kind: 'other', label: 'Editor transferred' },
};

function lookupEvent(section: string, method: string): { kind: ChainEvent['kind']; label: string } {
  return EVENT_MAP[`${section}.${method}`] ?? { kind: 'other', label: method };
}

// V1 events shape varies (sometimes [consumer, jobId], sometimes [jobId, ...]),
// so scan every entry until one parses as a JobId belonging to us.
function findJobLocalIdInData(dataJson: unknown, targets: Map<number, string>): number | undefined {
  if (!Array.isArray(dataJson)) return undefined;
  for (const entry of dataJson) {
    try {
      const id = jobIdFromChainJson(entry);
      if (id && targets.has(id[1])) return id[1];
    } catch { /* not a JobId */ }
  }
  return undefined;
}

function parseJobIds(raw: unknown): DeployJobId[] {
  if (!Array.isArray(raw)) return [];
  const out: DeployJobId[] = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const origin = entry[0] as { acurast?: string } | string | undefined;
    const localId = entry[1];
    const originStr = typeof origin === 'string'
      ? origin
      : (origin && typeof origin === 'object' && typeof origin.acurast === 'string' ? origin.acurast : '');
    const n = typeof localId === 'number' ? localId : Number(localId);
    if (!originStr || !Number.isFinite(n)) continue;
    out.push({ origin: originStr, localId: n });
  }
  return out;
}

function mergeJobIds(existing: DeployJobId[], next: DeployJobId[]): DeployJobId[] {
  const key = (j: DeployJobId) => `${j.origin}:${j.localId}`;
  const seen = new Set(existing.map(key));
  return [...existing, ...next.filter((j) => !seen.has(key(j)))];
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}
