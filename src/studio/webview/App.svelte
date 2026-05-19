<script lang="ts">
  import type { Route, DeployState, WalletInfo, BalanceMsg, PricingStateMsg } from '../types';
  import { send } from './lib/vscode';
  import { ICONS } from './lib/icons';
  import Home from './Home.svelte';
  import Wallets from './Wallets.svelte';
  import Settings from './Settings.svelte';
  import Deploy from './Deploy.svelte';

  interface CtxState { isAcurastProject: boolean; configPath: string | null; configRel: string | null; }
  interface WalletsState { list: WalletInfo[]; activeId: string | null; network: string; symbol: string; }
  interface ConfigState { data: unknown; projectKey: string | null; }

  let route = $state<Route>('home');
  let ctx = $state<CtxState>({ isAcurastProject: false, configPath: null, configRel: null });
  let wallets = $state<WalletsState>({ list: [], activeId: null, network: 'mainnet', symbol: 'ACU' });
  let balance = $state<BalanceMsg>({ status: 'idle' });
  let config = $state<ConfigState>({ data: null, projectKey: null });
  let deploy = $state<DeployState | null>(null);
  let pricing = $state<PricingStateMsg | null>(null);

  function navigate(newRoute: Route) {
    route = newRoute;
    send('navigate', { route: newRoute });
  }

  $effect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as Record<string, unknown> & { type: string };
      switch (msg.type) {
        case 'route':
          route = msg.route as Route;
          break;
        case 'context':
          ctx = { isAcurastProject: msg.isAcurastProject as boolean, configPath: msg.configPath as string | null, configRel: msg.configRel as string | null };
          break;
        case 'wallets.state':
          wallets = { list: msg.wallets as WalletInfo[], activeId: msg.activeId as string | null, network: msg.network as string, symbol: msg.symbol as string };
          break;
        case 'wallets.balance':
          balance = msg as unknown as BalanceMsg;
          break;
        case 'config.state':
          config = { data: msg.config, projectKey: null };
          pricing = null; // config changed — stale until refreshed
          break;
        case 'pricing.state':
          pricing = msg as unknown as PricingStateMsg;
          break;
        case 'deploy.state':
          deploy = msg.state as DeployState | null;
          break;
      }
    }
    window.addEventListener('message', onMessage);
    send('ready');
    return () => window.removeEventListener('message', onMessage);
  });

  const routeIcons: Record<string, string> = { wallets: ICONS.wallet, settings: ICONS.settings, deploy: ICONS.deployments };
  const routeTitles: Record<string, string> = { wallets: 'Wallets', settings: 'Project Settings', deploy: 'Deployment' };
</script>

{#if route !== 'home'}
  <div class="topbar">
    <span class="title-icon">{@html routeIcons[route] ?? ''}</span>
    <h2>{routeTitles[route] ?? route}</h2>
  </div>
{/if}

{#if route === 'home'}
  <Home {ctx} {wallets} {deploy} {navigate} />
{:else if route === 'wallets'}
  <Wallets {wallets} {balance} {navigate} />
{:else if route === 'settings'}
  <Settings {ctx} {config} {navigate} {pricing} />
{:else if route === 'deploy'}
  <Deploy {ctx} {deploy} {navigate} {pricing} />
{/if}
