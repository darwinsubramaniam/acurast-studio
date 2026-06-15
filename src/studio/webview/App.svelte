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
    TunnelStateMsg,
  } from "../types";
  import { send } from "./lib/vscode";
  import { ICONS } from "./lib/icons";
  import Home from "./Home.svelte";
  import Wallets from "./Wallets.svelte";
  import Settings from "./Settings.svelte";
  import Deploy from "./Deploy.svelte";
  import History from "./History.svelte";
  import Processors from "./Processors.svelte";
  import Tunnel from "./Tunnel.svelte";
  import NetworkMismatchBanner from "./NetworkMismatchBanner.svelte";

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
  let config = $state<ConfigState>({ data: null, projectKey: null });
  let deploy = $state<DeployState | null>(null);
  let pricing = $state<PricingStateMsg | null>(null);
  let fiatList = $state<FiatListStateMsg | null>(null);
  let fiatSelection = $state<FiatSelectionStateMsg | null>(null);
  let historyState = $state<HistoryStateMsg | null>(null);
  let processorsState = $state<ProcessorsStateMsg | null>(null);
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
  let activeWalletAddress = $derived(
    wallets.list.find((w) => w.id === wallets.activeId)?.address ?? null,
  );

  function navigate(newRoute: Route) {
    route = newRoute;
    send("navigate", { route: newRoute });
  }

  $effect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as Record<string, unknown> & { type: string };
      switch (msg.type) {
        case "route":
          route = msg.route as Route;
          break;
        case "context":
          ctx = {
            isAcurastProject: msg.isAcurastProject as boolean,
            configPath: msg.configPath as string | null,
            configRel: msg.configRel as string | null,
            configExists: msg.configExists as boolean,
            anyConfigExists: msg.anyConfigExists as boolean,
          };
          break;
        case "wallets.state":
          wallets = {
            list: msg.wallets as WalletInfo[],
            activeId: msg.activeId as string | null,
            network: msg.network as string,
            symbol: msg.symbol as string,
          };
          break;
        case "wallets.balance":
          balance = msg as unknown as BalanceMsg;
          break;
        case "config.state":
          config = { data: msg.config, projectKey: null };
          pricing = null; // config changed — stale until refreshed
          break;
        case "pricing.state":
          pricing = msg as unknown as PricingStateMsg;
          break;
        case "fiat.listState":
          fiatList = msg as unknown as FiatListStateMsg;
          break;
        case "fiat.selection":
          fiatSelection = msg as unknown as FiatSelectionStateMsg;
          break;
        case "deploy.state":
          deploy = msg.state as DeployState | null;
          break;
        case "history.state":
          historyState = msg as unknown as HistoryStateMsg;
          break;
        case "processors.state":
          processorsState = msg as unknown as ProcessorsStateMsg;
          break;
        case "tunnel.state":
          tunnel = msg as unknown as TunnelStateMsg;
          break;
        case "network.mismatch":
          projectNetwork = msg.projectNetwork as string | null;
          targetNetwork = msg.targetNetwork as string;
          break;
        case "diagnosis.state": {
          const d = msg as unknown as DiagnosisStateMsg;
          diagnoses = { ...diagnoses, [d.key]: d };
          break;
        }
        case "deregister.state": {
          const d = msg as unknown as DeregisterStateMsg;
          deregisters = { ...deregisters, [d.key]: d };
          break;
        }
      }
    }
    window.addEventListener("message", onMessage);
    send("ready");
    return () => window.removeEventListener("message", onMessage);
  });

  const routeIcons: Record<string, string> = {
    wallets: ICONS.wallet,
    settings: ICONS.settings,
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
  <Home {ctx} {wallets} {deploy} {navigate} />
{:else if route === "wallets"}
  <Wallets {wallets} {balance} />
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
  />
{:else if route === "deploy"}
  <NetworkMismatchBanner
    {projectNetwork}
    {targetNetwork}
    context="deploy"
    {navigate}
  />
  <Deploy {ctx} {deploy} {navigate} {pricing} {diagnoses} symbol={wallets.symbol} />
{:else if route === "history"}
  <History
    {historyState}
    {activeWalletAddress}
    activeNetwork={wallets.network}
    {diagnoses}
    {deregisters}
  />
{:else if route === "processors"}
  <Processors {wallets} {processorsState} />
{:else if route === "tunnel"}
  <Tunnel {tunnel} {wallets} />
{/if}
