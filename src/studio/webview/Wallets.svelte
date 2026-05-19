<script lang="ts">
  import type { WalletInfo, BalanceMsg } from '../types';
  import { send } from './lib/vscode';
  import { ICONS } from './lib/icons';

  interface Props {
    wallets: { list: WalletInfo[]; activeId: string | null; network: string; symbol: string };
    balance: BalanceMsg;
  }
  let { wallets, balance }: Props = $props();

  let ordered = $derived.by(() => {
    const { list, activeId } = wallets;
    const active = list.find(w => w.id === activeId);
    const others = list.filter(w => w.id !== activeId);
    return active ? [active, ...others] : list;
  });

  function shortAddr(address: string) {
    return address.slice(0, 8) + '…' + address.slice(-6);
  }

  function balanceText(bal: BalanceMsg): { text: string; cls: string } {
    if (bal.status === 'idle' || bal.status === 'loading') return { text: '…', cls: 'muted' };
    if (bal.status === 'ok' && bal.value != null) return { text: `${bal.value.toFixed(4)} ${bal.symbol ?? ''}`, cls: '' };
    return { text: bal.message || 'Failed', cls: 'error' };
  }
</script>

{#if wallets.list.length === 0}
  <div class="empty" style="text-align:center;">
    <div style="margin: 12px 0; opacity:0.7;">{@html ICONS.wallet}</div>
    <p>No wallets yet. Create or import one to deploy jobs on Acurast.</p>
    <button class="full" onclick={() => send('wallet', { action: 'create' })}>Create New Wallet</button>
    <button class="full secondary with-icon" onclick={() => send('wallet', { action: 'import' })}>
      {@html ICONS.importIcon} Import Existing
    </button>
  </div>
{:else}
  <div class="toolbar">
    <button onclick={() => send('wallet', { action: 'create' })}>+ New</button>
    <button class="secondary with-icon" onclick={() => send('wallet', { action: 'import' })}>
      {@html ICONS.importIcon} Import
    </button>
  </div>

  {#each ordered as w (w.id)}
    {@const isActive = w.id === wallets.activeId}
    {@const bal = balanceText(balance)}
    <div class="wallet-card {isActive ? 'active' : ''}">
      <div class="wallet-card-head">
        <div class="name">{w.name}</div>
        {#if isActive}<span class="active-badge">Active</span>{/if}
      </div>

      {#if w.description}
        <div class="description">{w.description}</div>
      {/if}

      <div class="address" title={w.address}>{shortAddr(w.address)}</div>

      {#if isActive}
        <div class="balance-row">
          <div class="balance-value {bal.cls}">{bal.text}</div>
          <div class="balance-network">{wallets.network}</div>
          <button class="icon-btn" onclick={() => send('refreshBalance')} title="Refresh">
            {@html ICONS.refresh}
          </button>
        </div>
      {/if}

      <div class="actions">
        {#if !isActive}
          <button onclick={() => send('wallet', { action: 'setActive', id: w.id })}>Set Active</button>
        {/if}
        <button onclick={() => send('wallet', { action: 'copyAddress', id: w.id })}>Copy</button>
        <button onclick={() => send('wallet', { action: 'rename', id: w.id })}>Rename</button>
        <button onclick={() => send('wallet', { action: 'editDescription', id: w.id })}>Edit Desc</button>
        <button onclick={() => send('wallet', { action: 'reveal', id: w.id })}>Reveal</button>
        <button class="danger icon-action" onclick={() => send('wallet', { action: 'delete', id: w.id })} title="Delete wallet">
          {@html ICONS.trash}
        </button>
      </div>
    </div>
  {/each}
{/if}
