<script lang="ts">
  import type { Route, DeployState, WalletInfo } from '../types';
  import { ICONS } from './lib/icons';

  interface Props {
    ctx: { isAcurastProject: boolean; configPath: string | null; configRel: string | null };
    wallets: { list: WalletInfo[]; activeId: string | null };
    deploy: DeployState | null;
    navigate: (r: Route) => void;
  }
  let { ctx, wallets, deploy, navigate }: Props = $props();

  let walletSub = $derived(
    wallets.list.length
      ? `${wallets.list.length} wallet${wallets.list.length === 1 ? '' : 's'}${wallets.activeId ? ' • active set' : ''}`
      : 'Create or import to begin'
  );

  let projectSub = $derived(
    !ctx.isAcurastProject ? 'No acurast.json selected' : (ctx.configRel || 'acurast.json')
  );

  let deploySub = $derived.by(() => {
    const d = deploy;
    if (!d) return 'No deployments yet';
    if (d.active) {
      const stage = d.stages?.find(s => s.status === 'active');
      return stage ? `Running · ${stage.label}` : 'Running';
    }
    if (d.result === 'ok') return 'Last deploy succeeded' + (d.project ? ` · ${d.project}` : '');
    if (d.result === 'error') return 'Last deploy failed';
    return 'Idle';
  });
</script>

<div class="hero">
  <div>{@html ICONS.home}</div>
  <h1>Acurast Studio</h1>
  <p>Wallets, project config, and deployments in one place.</p>
</div>

<div class="nav-grid">
  <button class="nav-card" onclick={() => navigate('wallets')}>
    <span class="icon">{@html ICONS.wallet}</span>
    <div class="body">
      <div class="title">Wallets</div>
      <div class="sub">{walletSub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate('settings')} disabled={!ctx.isAcurastProject}>
    <span class="icon">{@html ICONS.settings}</span>
    <div class="body">
      <div class="title">Project Settings</div>
      <div class="sub">{projectSub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" onclick={() => navigate('deploy')}>
    <span class="icon">{@html ICONS.deployments}</span>
    <div class="body">
      <div class="title">Deployments</div>
      <div class="sub">{deploySub}</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>

  <button class="nav-card" disabled>
    <span class="icon">{@html ICONS.logs}</span>
    <div class="body">
      <div class="title">Live Logs <span class="badge">Soon</span></div>
      <div class="sub">Coming soon</div>
    </div>
    <span class="chev">{@html ICONS.chev}</span>
  </button>
</div>
