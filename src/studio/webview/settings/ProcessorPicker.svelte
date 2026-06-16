<script lang="ts">
  // Shared "my processors" loader + candidate list. Pulls the processors the
  // active wallet manages and emits `onPick(address)` when a row's action button
  // is clicked. The parent owns the selection model and how it's displayed
  // (chips + textarea for the whitelist, a single input for instant match);
  // this component only surfaces candidates and reflects what's already chosen
  // via `selected`. Used by ProcessorWhitelist and the instant-match field.
  import type { WalletInfo, ProcessorsStateMsg, ManagedProcessor } from '../../types';
  import { send } from '../lib/vscode';
  import Spinner from '../shared/Spinner.svelte';
  import { truncate, fmtRelative } from '../lib/format';

  interface Props {
    activeWallet: WalletInfo | null;
    processorsState: ProcessorsStateMsg | null;
    /** Project network to query processors under. */
    network: string;
    /** Addresses already chosen — drives the per-row "selected" state. */
    selected: string[];
    /** Called when a candidate row's action button is clicked. */
    onPick: (address: string) => void;
    /** Show a bulk-add button for every not-yet-selected candidate. */
    allowAddAll?: boolean;
    /** Bulk-add handler; required when allowAddAll is true. */
    onPickAll?: (addresses: string[]) => void;
    /** Per-row action button label (idle / already-selected). */
    addLabel?: string;
    addedLabel?: string;
    /** Hint shown when no wallet is active. */
    noWalletHint?: string;
  }
  let {
    activeWallet,
    processorsState,
    network,
    selected,
    onPick,
    allowAddAll = false,
    onPickAll,
    addLabel = 'Add',
    addedLabel = 'Added',
    noWalletHint = 'Set an active wallet to list your processors.',
  }: Props = $props();

  function loadMyProcessors() {
    if (!activeWallet) return;
    send('processors.query', { address: activeWallet.address, network });
  }

  // Only trust processor results that belong to the active wallet.
  let myProcMatches = $derived(
    !!activeWallet && processorsState?.address === activeWallet.address,
  );
  let myProcStatus = $derived(myProcMatches ? processorsState?.status : undefined);
  let myProcessors = $derived<ManagedProcessor[]>(
    myProcMatches && processorsState?.status === 'ok'
      ? processorsState?.result?.processors ?? []
      : [],
  );
  function isOnline(lastSeen: number): boolean {
    return !!lastSeen && Date.now() - lastSeen <= 60 * 60 * 1000;
  }
</script>

<div class="wl-mine">
  <div class="wl-mine-head">
    <span class="wl-mine-title">
      My processors{activeWallet ? ` · ${activeWallet.name || truncate(activeWallet.address)}` : ''}
    </span>
    <button type="button" class="secondary wl-load"
      disabled={!activeWallet || myProcStatus === 'loading'}
      onclick={loadMyProcessors}>
      {#if myProcStatus === 'loading'}
        <Spinner size={10} label="Loading…" />
      {:else}
        {myProcessors.length ? '⟳ Refresh' : 'Load'}
      {/if}
    </button>
  </div>

  {#if !activeWallet}
    <div class="hint">{noWalletHint}</div>
  {:else if myProcStatus === 'error'}
    <div class="error-hint">{processorsState?.error ?? 'Failed to load processors.'}</div>
  {:else if myProcStatus === 'ok' && myProcessors.length === 0}
    <div class="hint">No processors are paired to this wallet on {network}.</div>
  {:else if myProcessors.length}
    {@const addable = myProcessors.filter((mp) => !selected.includes(mp.address))}
    <div class="wl-list">
      {#each myProcessors as mp (mp.address)}
        {@const added = selected.includes(mp.address)}
        <div class="wl-row" class:added>
          <span class="wl-dot {isOnline(mp.lastSeen) ? 'on' : 'off'}"
            title={isOnline(mp.lastSeen) ? 'Online' : `Last seen ${fmtRelative(mp.lastSeen)}`}></span>
          <span class="wl-row-addr" title={mp.address}>{truncate(mp.address)}</span>
          {#if mp.version}<span class="wl-ver">{mp.version}</span>{/if}
          <button type="button" class="wl-add" disabled={added}
            onclick={() => onPick(mp.address)}>
            {added ? addedLabel : addLabel}
          </button>
        </div>
      {/each}
    </div>
    {#if allowAddAll && addable.length > 1}
      <button type="button" class="secondary wl-add-all"
        onclick={() => onPickAll?.(addable.map((mp) => mp.address))}>
        Add all ({addable.length})
      </button>
    {/if}
  {:else}
    <div class="hint">Click “Load” to pull the processors paired to this wallet.</div>
  {/if}
</div>

<style>
  .wl-mine {
    border: 1px solid var(--vscode-panel-border);
    border-radius: 6px;
    padding: 8px;
    margin-bottom: 6px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .wl-mine-head {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .wl-mine-title {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .wl-load {
    margin-left: auto;
    font-size: 10px;
    padding: 2px 8px;
    flex: none;
  }

  .wl-list {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .wl-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .wl-row.added {
    opacity: 0.6;
  }
  .wl-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
  }
  .wl-dot.on {
    background: var(--vscode-testing-iconPassed, #3fb950);
  }
  .wl-dot.off {
    background: var(--vscode-descriptionForeground);
  }
  .wl-row-addr {
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .wl-ver {
    color: var(--vscode-descriptionForeground);
  }
  .wl-add {
    margin-left: auto;
    font-size: 10px;
    padding: 1px 8px;
    flex: none;
  }
  .wl-add-all {
    font-size: 10px;
    padding: 2px 8px;
    align-self: flex-start;
  }
</style>
