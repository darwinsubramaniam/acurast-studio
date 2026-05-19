import * as fs from 'fs';
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
import { Exchanger } from '../sdk/exchanger/exchanger';
import { CoinGecko, type CoinGeckoPlan } from '../sdk/exchanger/coingecko';
import type { Route, InMsg, WalletActionMsg, DeployState, DeployStage, DeployStageId, StageStatus, DeployJobId, ProcessorPubKey, ProcessorInfo, ChainEvent, PricingFiatInfo, FiatListItem } from './types';

const BALANCE_POLL_MS = 30_000;
const FIAT_PRICE_TTL_MS = 60_000;
const FIAT_API_KEY_SECRET = (exchangerId: number) => `acurast.fiat.apiKey.${exchangerId}`;

function defaultStages(): DeployStage[] {
  return [
    { id: 'bundle',      label: 'Package bundle',      status: 'pending' },
    { id: 'upload',      label: 'Upload to IPFS',      status: 'pending' },
    { id: 'prepare',     label: 'Prepare job',         status: 'pending' },
    { id: 'submit',      label: 'Submit transaction',  status: 'pending' },
    { id: 'match',       label: 'Match processor',     status: 'pending' },
    { id: 'acknowledge', label: 'Acknowledge',         status: 'pending' },
    { id: 'envvars',     label: 'Set env vars',        status: 'pending' },
  ];
}

export class StudioPanel implements vscode.WebviewViewProvider {
  public static readonly viewId = 'acurastStudio';
  private _view: vscode.WebviewView | undefined;
  private _route: Route = 'home';
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
    private readonly secrets: vscode.SecretStorage
  ) {
    wallet.onDidChange(() => this.pushWallets());
    ctx.onDidChangeActiveConfig(() => {
      this.pushContext();
      void this.pushConfig();
    });
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (this.ctx.configPath && doc.fileName === this.ctx.configPath) this.pushConfig();
    });
  }

  private pushContext() {
    this.post({
      type: 'context',
      isAcurastProject: this.ctx.isAcurastProject,
      configPath: this.ctx.configPath ?? null,
      configRel: this.ctx.configPath
        ? vscode.workspace.asRelativePath(this.ctx.configPath)
        : null,
    });
  }

  private get network(): AcurastNetwork {
    return vscode.workspace.getConfiguration('acurast').get<AcurastNetwork>('network', 'mainnet');
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
    }
    // Reveal the view (auto-generated focus command)
    await vscode.commands.executeCommand('acurastStudio.focus');
  }

  private updateRouteContext() {
    vscode.commands.executeCommand('setContext', 'acurast.studio.route', this._route);
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this._view = view;
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
    }
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
    this.pushContext();
    await this.pushWallets();
    if (this._route === 'wallets') this.startBalancePoll();
    await this.pushConfig();
    await this.pushFiatSelection();
    if (this._route === 'deploy') { this.pushDeploy(); if (!this._deploy) void this.pushPricing(); }
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

    const result = await loadPricing({ config, walletAddress: activeWallet?.address, matcherUrl });
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

  beginDeploy(opts: { project: string; network: string }) {
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
    this.pushDeploy();
  }

  private pushDeploy() {
    this.post({ type: 'deploy.state', state: this._deploy });
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
  'acurast.JobRegistrationStored':     { kind: 'started',   label: 'Registration stored' },
  'acurast.JobRegistrationStoredV2':   { kind: 'started',   label: 'Registration stored' },
  'acurast.JobRegistrationRemoved':    { kind: 'finalized', label: 'Registration removed (deregistered)' },
  'acurast.ExecutionEnvironmentsUpdated':   { kind: 'other', label: 'Env vars updated' },
  'acurast.ExecutionEnvironmentsUpdatedV2': { kind: 'other', label: 'Env vars updated' },
  'acurast.AllowedSourcesUpdated':   { kind: 'other', label: 'Allowed sources updated' },
  'acurast.AllowedSourcesUpdatedV2': { kind: 'other', label: 'Allowed sources updated' },

  // acurastMarketplace pallet — matching / execution / finalization
  'acurastMarketplace.JobRegistrationMatched':     { kind: 'started', label: 'Matched' },
  'acurastMarketplace.JobRegistrationMatchedV2':   { kind: 'started', label: 'Matched' },
  'acurastMarketplace.JobRegistrationAssigned':    { kind: 'started', label: 'Acknowledged by processor' },
  'acurastMarketplace.JobRegistrationAssignedV2':  { kind: 'started', label: 'Acknowledged by processor' },
  'acurastMarketplace.JobExecutionMatched':        { kind: 'started', label: 'Execution match' },
  'acurastMarketplace.JobExecutionMatchedV2':      { kind: 'started', label: 'Execution match' },

  'acurastMarketplace.Reported':         { kind: 'reported', label: 'Execution reported' },
  'acurastMarketplace.ReportedV2':       { kind: 'reported', label: 'Execution reported' },
  'acurastMarketplace.ExecutionSuccess': { kind: 'reported', label: 'Execution success' },
  'acurastMarketplace.ExecutionFailure': { kind: 'reported', label: 'Execution failure' },

  'acurastMarketplace.JobFinalized':                  { kind: 'finalized', label: 'Finalized' },
  'acurastMarketplace.JobAssignmentsCleanedUp':       { kind: 'finalized', label: 'Assignments cleaned up' },
  'acurastMarketplace.JobMatcherEntryCleanedUp':      { kind: 'finalized', label: 'Matcher cleaned up' },
  'acurastMarketplace.ProcessorAssignmentsCleanedUp': { kind: 'finalized', label: 'Processor assignments cleaned up' },

  'acurastMarketplace.JobBecameImmutable': { kind: 'other', label: 'Became immutable' },
  'acurastMarketplace.JobScriptEdited':    { kind: 'other', label: 'Script edited' },
  'acurastMarketplace.EditorTransferred':  { kind: 'other', label: 'Editor transferred' },
};

function  lookupEvent(section: string, method: string): { kind: ChainEvent['kind']; label: string } {
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
