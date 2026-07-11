<script lang="ts">
  import type { WalletInfo, BalanceMsg } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import { shortAddr } from '../lib/format';
  import Spinner from '../shared/Spinner.svelte';
  import WalletAvatar from './WalletAvatar.svelte';
  import WalletMenu from './WalletMenu.svelte';
  import ToolbarMenu from './ToolbarMenu.svelte';
  import type { WalletMenuAction } from './WalletMenu.svelte';

  interface Props {
    wallets: { list: WalletInfo[]; activeId: string | null; network: string; symbol: string };
    balances: Record<string, BalanceMsg>;
    onCreate: () => void;
    onImport: () => void;
    onRefresh: () => void;
    onAction: (action: WalletMenuAction, id: string) => void;
  }
  let { wallets, balances, onCreate, onImport, onRefresh, onAction }: Props = $props();

  // Search filters only the "All wallets" rows by name (case-insensitive
  // substring) — the active wallet always stays in view.
  let query = $state('');
  let q = $derived(query.trim().toLowerCase());
  function nameMatches(w: WalletInfo): boolean {
    return !q || w.name.toLowerCase().includes(q);
  }

  let ordered = $derived.by(() => {
    const { list, activeId } = wallets;
    const active = list.find((w) => w.id === activeId);
    const others = list.filter((w) => w.id !== activeId);
    return active ? [active, ...others] : list;
  });
  let activeWallet = $derived(ordered.find((w) => w.id === wallets.activeId) ?? null);
  let allOthers = $derived(ordered.filter((w) => w.id !== wallets.activeId));
  let otherWallets = $derived(allOthers.filter(nameMatches));
  // The bar only appears once there are 2+ other wallets to search through.
  let showSearch = $derived(allOthers.length > 1);
  let noMatches = $derived(q.length > 0 && otherWallets.length === 0);

  let netLabel = $derived(wallets.network.charAt(0).toUpperCase() + wallets.network.slice(1));

  type BalKind = 'loading' | 'ok' | 'zero' | 'error';
  function balKind(id: string): BalKind {
    const b = balances[id];
    if (!b || b.status === 'idle' || b.status === 'loading') return 'loading';
    if (b.status === 'error') return 'error';
    return (b.value ?? 0) === 0 ? 'zero' : 'ok';
  }
  function balText(id: string): string {
    const v = balances[id]?.value ?? 0;
    return v.toFixed(2);
  }

  function fundingUrl(network: string): string {
    return network === 'mainnet'
      ? 'https://docs.acurast.com/token-holders/how-to-get-acu/'
      : 'https://faucet.acurast.com/';
  }
  // Open funding links via the host (vscode.env.openExternal) — the webview's
  // default-src 'none' CSP blocks <a> navigation. preventDefault stops the
  // in-frame navigation; the href stays for accessibility / hover.
  function openFunding(e: MouseEvent) {
    e.preventDefault();
    send('openExternal', { url: fundingUrl(wallets.network) });
  }
</script>

{#if wallets.list.length === 0}
  <div class="wallet-empty">
    <div class="we-icon">{@html ICONS.wallet}</div>
    <div class="we-title">No wallets yet</div>
    <div class="we-sub">Create or import a wallet — encrypted locally — to sign and deploy jobs on Acurast.</div>
    <button class="full primary-green with-icon" onclick={onCreate}>{@html ICONS.plus} Create New Wallet</button>
    <button class="full secondary with-icon" onclick={onImport}>{@html ICONS.importIcon} Import Existing</button>
    <div class="wallet-secnote">{@html ICONS.shield}<span>Encrypted at rest · AES-256-GCM + PBKDF2 (210k)</span></div>
  </div>
{:else}
  <div class="wallet-toolbar">
    <span class="wallet-net-chip"><span class="dot"></span>{netLabel}</span>
    <span class="wallet-toolbar-spacer"></span>
    <!-- Wide panel: individual buttons. Narrow panel (container ≤ 300px): the
         three collapse into the kebab below. Toggled purely by CSS @container. -->
    <button class="tb-icon tb-full" onclick={onRefresh} title="Refresh balances" aria-label="Refresh balances">{@html ICONS.refresh}</button>
    <button class="primary-green with-icon tb-full" onclick={onCreate}>{@html ICONS.plus} New</button>
    <button class="tb-btn with-icon tb-full" onclick={onImport}>{@html ICONS.importIcon} Import</button>
    <div class="tb-menu"><ToolbarMenu {onCreate} {onImport} {onRefresh} /></div>
  </div>

  {#if activeWallet}
    {@const w = activeWallet}
    {@const kind = balKind(w.id)}
    <div class="wallet-card active">
      <div class="wc-head">
        <WalletAvatar size={34} />
        <div class="wc-id">
          <div class="wc-name-row">
            <span class="wc-name">{w.name}</span>
            <span class="wallet-badge">Active</span>
          </div>
          {#if w.description}<div class="wc-desc">{w.description}</div>{/if}
        </div>
        <WalletMenu isActive={true} onAction={(a) => onAction(a, w.id)} />
      </div>

      <div class="wc-addr">
        <span class="wc-addr-text" title={w.address}>{shortAddr(w.address)}</span>
        <button class="icon-btn" onclick={() => onAction('copyAddress', w.id)} title="Copy address" aria-label="Copy address">{@html ICONS.copy}</button>
      </div>

      {#if kind === 'loading'}
        <div class="wc-balance-line loading"><Spinner size={13} /><span>Checking balance…</span></div>
      {:else if kind === 'error'}
        <div class="wc-balance-line error">
          <span class="wc-bal-err">{@html ICONS.warning}<span>Balance unavailable</span></span>
          <button class="wc-retry" onclick={onRefresh}>Couldn't reach {netLabel} · Retry</button>
        </div>
      {:else}
        <div class="wc-balance">
          <span class="wc-bal-val">{balText(w.id)}</span>
          <span class="wc-bal-sym">{wallets.symbol}</span>
        </div>
        {#if kind === 'zero'}
          <div class="wc-nofunds">
            <span class="wc-nofunds-title">No funds yet</span>
            {#if wallets.network === 'mainnet'}
              <a href={fundingUrl(wallets.network)} onclick={openFunding}>Learn how to get ACU {@html ICONS.arrowUpRight}</a>
            {:else}
              <a href={fundingUrl(wallets.network)} onclick={openFunding}>Get test cACU from the Acurast Faucet {@html ICONS.arrowUpRight}</a>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  {/if}

  {#if allOthers.length}
    <div class="wallet-section-label">All wallets · {wallets.list.length}</div>

    {#if showSearch}
      <div class="wallet-search">
        {@html ICONS.search}
        <input bind:value={query} placeholder="Search wallets by name" aria-label="Search wallets by name" />
        {#if query}
          <button class="wallet-search-clear" onclick={() => (query = '')} title="Clear search" aria-label="Clear search">{@html ICONS.close}</button>
        {/if}
      </div>
    {/if}

    {#if noMatches}
      <div class="wallet-nomatch">No wallets match "{query}".</div>
    {/if}

    {#each otherWallets as w (w.id)}
      {@const kind = balKind(w.id)}
      <div class="wallet-row">
        <WalletAvatar size={30} />
        <div class="wr-id">
          <div class="wr-name">{w.name}</div>
          {#if w.description}<div class="wr-desc">{w.description}</div>{/if}
          <div class="wr-addr" title={w.address}>{shortAddr(w.address)}</div>
        </div>
        <div class="wr-right">
          {#if kind === 'loading'}
            <Spinner size={11} />
          {:else if kind === 'error'}
            <span class="wr-bal err">Unavailable</span>
          {:else if kind === 'zero'}
            <span class="wr-bal muted">No funds yet</span>
            <a class="wr-link" href={fundingUrl(wallets.network)} onclick={openFunding}>Faucet {@html ICONS.arrowUpRight}</a>
          {:else}
            <span class="wr-bal">{balText(w.id)} {wallets.symbol}</span>
            <button class="wr-link" onclick={() => onAction('setActive', w.id)}>Set active</button>
          {/if}
        </div>
        <WalletMenu isActive={false} onAction={(a) => onAction(a, w.id)} />
      </div>
    {/each}
  {/if}

  <div class="wallet-secnote"><span>{@html ICONS.shield}</span><span>Encrypted at rest · AES-256-GCM + PBKDF2 (210k)</span></div>
{/if}
