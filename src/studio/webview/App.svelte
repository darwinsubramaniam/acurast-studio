<script lang="ts">
  import type {
    Route,
    DeployState,
    WalletInfo,
    BalanceMsg,
    PricingStateMsg,
    FiatListStateMsg,
    FiatSelectionStateMsg,
    HistoryStateMsg,
    ProcessorsStateMsg,
    DiagnosisStateMsg,
    DeregisterStateMsg,
    AssignmentsStateMsg,
    TunnelStateMsg,
    WalletOpResultMsg,
    DistroCatalogStateMsg,
    DurationConvertedMsg,
    AppInfoMsg,
    OutMsg,
  } from "../types";
  import { send } from "./lib/vscode";
  import { ICONS } from "./lib/icons";
  import Home from "./home/Home.svelte";
  import Wallets from "./wallets/Wallets.svelte";
  import Settings from "./settings/Settings.svelte";
  import Deploy from "./deploy/Deploy.svelte";
  import History from "./history/History.svelte";
  import Processors from "./processors/Processors.svelte";
  import Tunnel from "./tunnel/Tunnel.svelte";
  import NetworkMismatchBanner from "./shared/NetworkMismatchBanner.svelte";

  interface CtxState {
    isAcurastProject: boolean;
    configPath: string | null;
    configRel: string | null;
    configExists: boolean;
    anyConfigExists: boolean;
  }
  interface WalletsState {
    list: WalletInfo[];
    activeId: string | null;
    network: string;
    symbol: string;
  }
  interface ConfigState {
    data: unknown;
    projectKey: string | null;
  }

  let route = $state<Route>("home");
  // Extension version badge for Home; null until the host posts it on `ready`.
  let appInfo = $state<AppInfoMsg | null>(null);
  let ctx = $state<CtxState>({
    isAcurastProject: false,
    configPath: null,
    configRel: null,
    configExists: false,
    anyConfigExists: false,
  });
  let wallets = $state<WalletsState>({
    list: [],
    activeId: null,
    network: "mainnet",
    symbol: "ACU",
  });
  let balance = $state<BalanceMsg>({ status: "idle" });
  // Per-wallet balances for the Wallets list (keyed by wallet id), all on the
  // Studio target network. `balance` above stays the active-only Home value.
  let walletBalances = $state<Record<string, BalanceMsg>>({});
  // Latest in-panel wallet flow result; Wallets.svelte reacts to it via $effect
  // keyed on its host-incremented `seq`.
  let walletOp = $state<WalletOpResultMsg | null>(null);
  let config = $state<ConfigState>({ data: null, projectKey: null });
  let deploy = $state<DeployState | null>(null);
  let pricing = $state<PricingStateMsg | null>(null);
  let fiatList = $state<FiatListStateMsg | null>(null);
  let fiatSelection = $state<FiatSelectionStateMsg | null>(null);
  let historyState = $state<HistoryStateMsg | null>(null);
  let processorsState = $state<ProcessorsStateMsg | null>(null);
  // Null until the host posts one; Settings falls back to the bundled catalog.
  let distroCatalog = $state<DistroCatalogStateMsg | null>(null);
  // Latest human-duration → ms converter result; Settings reacts to it via
  // $effect keyed on its host-incremented `seq`.
  let durationResult = $state<DurationConvertedMsg | null>(null);
  let tunnel = $state<TunnelStateMsg | null>(null);
  // Project (acurast.json) vs Studio target network — set from the host so the
  // Deploy/Settings views can warn when they diverge. The banner self-suppresses
  // when they match, so these are passed to it unconditionally.
  let projectNetwork = $state<string | null>(null);
  let targetNetwork = $state("");
  // Per-job diagnosis results, keyed by `${origin}:${localId}`.
  let diagnoses = $state<Record<string, DiagnosisStateMsg>>({});
  // Per-job deregister progress, keyed by `${origin}:${localId}`.
  let deregisters = $state<Record<string, DeregisterStateMsg>>({});
  // Per-job processor assignments (slot + startDelay), keyed by `${origin}:${localId}`.
  let assignments = $state<Record<string, AssignmentsStateMsg>>({});
  let activeWalletAddress = $derived(
    wallets.list.find((w) => w.id === wallets.activeId)?.address ?? null,
  );

  function navigate(newRoute: Route) {
    route = newRoute;
    send("navigate", { route: newRoute });
  }

  $effect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as OutMsg;
      switch (msg.type) {
        case "route":
          route = msg.route;
          break;
        case "appInfo":
          appInfo = msg;
          break;
        case "context":
          ctx = {
            isAcurastProject: msg.isAcurastProject,
            configPath: msg.configPath,
            configRel: msg.configRel,
            configExists: msg.configExists,
            anyConfigExists: msg.anyConfigExists,
          };
          break;
        case "wallets.state":
          wallets = {
            list: msg.wallets,
            activeId: msg.activeId,
            network: msg.network,
            symbol: msg.symbol,
          };
          break;
        case "wallets.balance":
          balance = msg;
          break;
        case "wallets.balances":
          walletBalances = msg.balances;
          break;
        case "wallet.opResult":
          walletOp = msg;
          break;
        case "config.state":
          config = { data: msg.config, projectKey: null };
          pricing = null; // config changed — stale until refreshed
          break;
        case "pricing.state":
          pricing = msg;
          break;
        case "fiat.listState":
          fiatList = msg;
          break;
        case "fiat.selection":
          fiatSelection = msg;
          break;
        case "deploy.state":
          deploy = msg.state;
          break;
        case "history.state":
          historyState = msg;
          break;
        case "processors.state":
          processorsState = msg;
          break;
        case "distro.catalog":
          distroCatalog = msg;
          break;
        case "duration.converted":
          durationResult = msg;
          break;
        case "tunnel.state":
          tunnel = msg;
          break;
        case "network.mismatch":
          projectNetwork = msg.projectNetwork;
          targetNetwork = msg.targetNetwork;
          break;
        case "diagnosis.state":
          diagnoses = { ...diagnoses, [msg.key]: msg };
          break;
        case "deregister.state":
          deregisters = { ...deregisters, [msg.key]: msg };
          break;
        case "assignments.state":
          assignments = { ...assignments, [msg.key]: msg };
          break;
        default:
          msg satisfies never;
      }
    }
    window.addEventListener("message", onMessage);
    send("ready");
    return () => window.removeEventListener("message", onMessage);
  });

  const routeIcons: Record<string, string> = {
    wallets: ICONS.wallet,
    settings: ICONS.braces,
    deploy: ICONS.deployments,
    history: ICONS.history,
    processors: ICONS.processor,
    tunnel: ICONS.globe,
  };
  const routeTitles: Record<string, string> = {
    wallets: "Wallets",
    settings: "Project Settings",
    deploy: "Deployment",
    history: "Deployment History",
    processors: "Processors",
    tunnel: "Tunnel DNS",
  };
</script>

{#if route !== "home"}
  <div class="topbar">
    <span class="title-icon">{@html routeIcons[route] ?? ""}</span>
    <h2>{routeTitles[route] ?? route}</h2>
  </div>
{/if}

{#if route === "home"}
  <Home {ctx} {wallets} {balance} {deploy} {navigate} {appInfo} />
{:else if route === "wallets"}
  <Wallets {wallets} {walletBalances} {walletOp} />
{:else if route === "settings"}
  <NetworkMismatchBanner
    {projectNetwork}
    {targetNetwork}
    context="settings"
    {navigate}
  />
  <Settings
    {ctx}
    {config}
    {navigate}
    {pricing}
    {fiatList}
    {fiatSelection}
    {wallets}
    {processorsState}
    {distroCatalog}
    {durationResult}
  />
{:else if route === "deploy"}
  <NetworkMismatchBanner
    {projectNetwork}
    {targetNetwork}
    context="deploy"
    {navigate}
  />
  <Deploy
    {ctx}
    {deploy}
    {navigate}
    {pricing}
    {diagnoses}
    symbol={wallets.symbol}
    {projectNetwork}
  />
{:else if route === "history"}
  <History
    {historyState}
    {activeWalletAddress}
    activeNetwork={wallets.network}
    {diagnoses}
    {deregisters}
    {assignments}
  />
{:else if route === "processors"}
  <Processors {wallets} {processorsState} />
{:else if route === "tunnel"}
  <Tunnel {tunnel} {wallets} {navigate} />
{/if}
