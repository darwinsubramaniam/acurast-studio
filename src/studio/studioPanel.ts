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
import { SYMBOL, MATCHER_ENDPOINTS, type AcurastNetwork } from '../sdk/constants';
import { networkLabel } from '../lib/network';
import { setTargetNetwork, getProjectNetwork } from '../wallet/networkSetting';
import { Exchanger } from '../sdk/exchanger/exchanger';
import { CoinGecko, type CoinGeckoPlan } from '../sdk/exchanger/coingecko';
import { DeploymentStore } from '../deployments/deploymentStore';
import { LogViewerManager } from '../loki/logViewerPanel';
import { resolveLokiConfig, jobSelector, escapeLabelValue } from '../loki/lokiConfig';
import type { Route, InMsg, WalletActionMsg, DeployState, DeployStage, DeployStageId, StageStatus, DeployJobId, ProcessorPubKey, ProcessorInfo, ChainEvent, PricingFiatInfo, FiatListItem, StoredDeploymentWithMeta, HistoryStateMsg, OnlineJobRegistration, LocalJobStatus, ProcessorsStateMsg, DiagnosisStateMsg, MonitoringStateMsg, MonitoringOpenMsg } from './types';

const BALANCE_POLL_MS = 30_000;
const FIAT_PRICE_TTL_MS = 60_000;
const HISTORY_PAGE_SIZE = 15;
const FIAT_API_KEY_SECRET = (exchangerId: number) => `acurast.fiat.apiKey.${exchangerId}`;

function defaultStages(): DeployStage[] {
  return [
    { id: 'bundle', label: 'Package bundle', status: 'pending' },
    { id: 'upload', label: 'Upload to IPFS', status: 'pending' },
    { id: 'prepare', label: 'Prepare job', status: 'pending' },
    { id: 'submit', label: 'Submit transaction', status: 'pending' },
    { id: 'match', label: 'Match processor', status: 'pending' },
    { id: 'acknowledge', label: 'Acknowledge', status: 'pending' },
    { id: 'envvars', label: 'Set env vars', status: 'pending' },
  ];
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
  private _deploy: DeployState | null = null;
  private _chainEventUnsub: UnsubEvent | undefined;
  private _chainWatchToken = 0;
  private _exchanger = new Exchanger();
  private _fiatPriceCache: { key: string; value: number; fetchedAt: number } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ctx: AcurastContext,
    private readonly wallet: WalletService,
    private readonly secrets: vscode.SecretStorage,
    private readonly deploymentStore: DeploymentStore,
    private readonly logViewer: LogViewerManager
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
      if (route === 'wallets') {
        await this.pushWallets();
        this.startBalancePoll();
      } else {
        this.stopBalancePoll();
      }
      if (route === 'settings') await this.pushConfig();
      if (route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
      if (route === 'history') await this.pushHistory();
      if (route === 'monitoring') await this.pushMonitoring();
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
      if (view.visible && this._route === 'wallets') this.startBalancePoll();
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
        if (msg.route === 'wallets') {
          await this.pushWallets();
          this.startBalancePoll();
        } else {
          this.stopBalancePoll();
        }
        if (msg.route === 'settings') await this.pushConfig();
        if (msg.route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
        if (msg.route === 'history') await this.pushHistory();
        if (msg.route === 'monitoring') await this.pushMonitoring();
        break;
      case 'wallet':
        await this.runWalletAction(msg);
        break;
      case 'refreshBalance':
        await this.pushBalance();
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
        void this.pushPricing();
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
      case 'processors.query':
        await this.fetchProcessors(msg.address, msg.network);
        break;
      case 'processors.advertise':
        await vscode.commands.executeCommand('acurast.processor.advertiseModules', {
          walletId: msg.walletId,
          processor: msg.processor,
          modules: msg.modules,
          network: msg.network,
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
      case 'history.removePathInfo':
        await this.deploymentStore.removePathInfo(msg.id);
        await this.pushHistory();
        break;
      case 'history.remove':
        await this.deploymentStore.remove(msg.id);
        await this.pushHistory();
        break;
      case 'history.openFolder':
        if (msg.path) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(msg.path));
        break;
      case 'network.setTarget':
        await setTargetNetwork(msg.network);
        vscode.window.setStatusBarMessage(`Acurast network: ${networkLabel(msg.network)}`, 2000);
        break;
      case 'monitoring.open':
        await this.openLogViewer(msg);
        break;
      case 'monitoring.refresh':
        await this.pushMonitoring();
        break;
      case 'monitoring.configure':
        await vscode.commands.executeCommand('acurast.loki.configure');
        await this.pushMonitoring();
        break;
    }
  }

  /** Push Loki readiness + the deployments the user can monitor to the
   * Live Monitoring side panel. */
  private async pushMonitoring(): Promise<void> {
    const cfg = await resolveLokiConfig(this.network, this.secrets);
    const deployments = this.deploymentStore.getAll()
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt);
    this.post({
      type: 'monitoring.state',
      configured: cfg.configured,
      endpointUrl: cfg.baseUrl,
      jobLabel: cfg.jobLabel,
      targetNetwork: this.network,
      deployments,
    } satisfies MonitoringStateMsg);
  }

  /** Resolve the LogQL from the job scope + line filter and open the viewer tab. */
  private async openLogViewer(msg: MonitoringOpenMsg): Promise<void> {
    const cfg = await resolveLokiConfig(msg.network, this.secrets);
    if (!cfg.configured) {
      const choice = await vscode.window.showWarningMessage(
        'No Loki endpoint is configured for this network.',
        'Configure'
      );
      if (choice === 'Configure') {
        await vscode.commands.executeCommand('acurast.loki.configure');
        await this.pushMonitoring();
      }
      return;
    }
    let query = msg.localId !== undefined ? jobSelector(cfg.jobLabel, msg.localId) : '{}';
    const filter = msg.search?.trim();
    if (filter) query += ` |= "${escapeLabelValue(filter)}"`;
    const endMs = Date.now();
    const startMs = endMs - Math.max(1, msg.rangeMs);
    await this.logViewer.open({
      network: msg.network,
      origin: msg.origin,
      localId: msg.localId,
      title: msg.title,
      query,
      startMs,
      endMs,
      limit: msg.limit,
      direction: 'backward',
    });
  }

  private async runWalletAction(msg: WalletActionMsg) {
    const cmdMap: Record<WalletActionMsg['action'], string> = {
      create: 'acurast.wallet.create',
      import: 'acurast.wallet.import',
      reveal: 'acurast.wallet.reveal',
      delete: 'acurast.wallet.delete',
      copyAddress: 'acurast.wallet.copyAddress',
      rename: 'acurast.wallet.rename',
      editDescription: 'acurast.wallet.editDescription',
      setActive: 'acurast.wallet.setActive',
    };
    if (msg.action === 'setActive' && msg.id) {
      await this.wallet.setActive(msg.id);
      return;
    }
    await vscode.commands.executeCommand(cmdMap[msg.action], msg.id);
  }

  private post(msg: unknown) {
    this._view?.webview.postMessage(msg);
  }

  private async pushAll() {
    this.post({ type: 'route', route: this._route });
    await this.pushContext();
    await this.pushWallets();
    if (this._route === 'wallets') this.startBalancePoll();
    await this.pushConfig();
    await this.pushNetworkMismatch();
    await this.pushFiatSelection();
    if (this._route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
    if (this._route === 'history') await this.pushHistory();
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
    if (activeId && this._route === 'wallets') await this.pushBalance();
  }

  private startBalancePoll() {
    this.stopBalancePoll();
    this._balanceTimer = setInterval(() => this.pushBalance(), BALANCE_POLL_MS);
  }

  private stopBalancePoll() {
    if (this._balanceTimer) {
      clearInterval(this._balanceTimer);
      this._balanceTimer = undefined;
    }
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

  async pushPricing() {
    this.post({ type: 'pricing.state', status: 'loading' });

    if (!this.ctx.configPath) {
      this.post({ type: 'pricing.state', status: 'error', error: 'No active acurast.json' });
      return;
    }

    let config;
    try {
      config = loadAcurastConfig({ filePath: this.ctx.configPath });
    } catch (err: unknown) {
      this.post({ type: 'pricing.state', status: 'error', error: (err as Error).message });
      return;
    }
    if (!config) {
      this.post({ type: 'pricing.state', status: 'error', error: 'No project found in acurast.json' });
      return;
    }

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

    const cacheKey = `${exchangerId}:${fiatSymbolForPrice}`;
    let acuPriceFiat: number;
    try {
      if (this._fiatPriceCache && this._fiatPriceCache.key === cacheKey &&
        Date.now() - this._fiatPriceCache.fetchedAt < FIAT_PRICE_TTL_MS) {
        acuPriceFiat = this._fiatPriceCache.value;
      } else {
        acuPriceFiat = await exchanger.getACULatestPrice(fiatSymbolForPrice);
        this._fiatPriceCache = { key: cacheKey, value: acuPriceFiat, fetchedAt: Date.now() };
      }
    } catch (err: unknown) {
      return {
        exchangerId,
        exchangerName: details.name,
        currencyId,
        currencyName: meta?.name ?? currencyId,
        currencySign: meta?.sign ?? '',
        currencySymbol: meta?.symbol ?? currencyId.toUpperCase(),
        acuPriceFiat: 0,
        fetchedAt: Date.now(),
        error: (err as Error).message,
      };
    }

    return {
      exchangerId,
      exchangerName: details.name,
      currencyId,
      currencyName: meta?.name ?? currencyId,
      currencySign: meta?.sign ?? '',
      currencySymbol: meta?.symbol ?? currencyId.toUpperCase(),
      acuPriceFiat,
      fetchedAt: Date.now(),
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
    this._fiatPriceCache = undefined;
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

  beginDeploy(opts: { project: string; network: string; enableDevtools?: boolean }) {
    const stages = defaultStages();
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
    this.post({ type: 'deploy.state', state: this._deploy });
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
        for (const info of infos) {
          all.push({
            address: info.processor,
            slot: info.assignment.slot,
            startDelay: info.assignment.startDelay,
            feePerExecution: info.assignment.feePerExecution?.toString(),
            acknowledged: info.assignment.acknowledged,
            slaTotal: info.assignment.sla?.total?.toString(),
            slaMet: info.assignment.sla?.met?.toString(),
            pubKeys: flattenPubKeys(info.assignment.pubKeys),
          });
        }
      }
      d.processors = { status: 'ok', list: all, fetchedAt: Date.now() };
    } catch (err: unknown) {
      d.processors = { status: 'error', message: (err as Error).message, fetchedAt: Date.now() };
    }
    this.pushDeploy();
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

  private async deregisterDeployment(origin: string, localId: number) {
    const d = this._deploy;
    if (!d) return;
    const target = d.jobIds.find((j) => j.origin === origin && j.localId === localId);
    if (!target) return;
    if (target.deregistering || target.deregistered) return;

    const confirm = await vscode.window.showWarningMessage(
      `Deregister deployment ${localId}?`,
      { modal: true, detail: `This cancels the job on-chain. It cannot be undone.\n\nOrigin: ${origin}\nNetwork: ${d.network ?? 'mainnet'}` },
      'Deregister'
    );
    if (confirm !== 'Deregister') return;

    const activeWallet = await this.wallet.getActive();
    if (!activeWallet) {
      vscode.window.showErrorMessage('No active wallet. Set one as active to sign the deregister tx.');
      return;
    }
    if (activeWallet.address !== origin) {
      const proceed = await vscode.window.showWarningMessage(
        'Active wallet does not match the deployment origin. The chain will reject the tx.',
        { modal: true, detail: `Origin: ${origin}\nActive wallet: ${activeWallet.address}` },
        'Try anyway'
      );
      if (proceed !== 'Try anyway') return;
    }

    const password = await vscode.window.showInputBox({
      prompt: `Enter password for "${activeWallet.name}" to sign deregister`,
      password: true,
      ignoreFocusOut: true,
    });
    if (!password) return;

    let mnemonic: string;
    try {
      mnemonic = await this.wallet.reveal(activeWallet.id, password);
    } catch (err: unknown) {
      vscode.window.showErrorMessage((err as Error).message);
      return;
    }

    target.deregistering = true;
    target.deregisterError = undefined;
    this.pushDeploy();

    try {
      const network = (d.network ?? 'mainnet') as AcurastNetwork;
      const svc = await acurastClient.service(network);
      const keypair = await walletFromMnemonic(mnemonic);
      const hash = await svc.deregisterJob(keypair, localId);
      const txHash = hash.toHex();
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
