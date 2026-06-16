<script lang="ts">
  // Processor whitelist editor: chips for the current list, a loader for the
  // processors the active wallet manages (one-click add), and the raw textarea.
  // The whitelist is a newline-joined string; edits flow up via `onChange`.
  import type { WalletInfo, ProcessorsStateMsg, ManagedProcessor } from '../../types';
  import { send } from '../lib/vscode';
  import Spinner from '../shared/Spinner.svelte';
  import { truncate, fmtRelative } from '../lib/format';

  interface Props {
    /** Current whitelist as a newline-joined string. */
    value: string;
    onChange: (value: string) => void;
    activeWallet: WalletInfo | null;
    processorsState: ProcessorsStateMsg | null;
    /** Project network to query processors under. */
    network: string;
  }
  let { value, onChange, activeWallet, processorsState, network }: Props = $props();

  let whitelist = $derived(value.split('\n').map((s) => s.trim()).filter(Boolean));

  function setWhitelist(list: string[]) {
    onChange(list.join('\n'));
  }
  function addToWhitelist(addr: string) {
    if (whitelist.includes(addr)) return;
    setWhitelist([...whitelist, addr]);
  }
  function removeFromWhitelist(addr: string) {
    setWhitelist(whitelist.filter((a) => a !== addr));
  }

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

<div class="field">
  <label for="f_whitelist">Processor Whitelist <span class="label-optional">(optional)</span></label>

  {#if whitelist.length}
    <div class="wl-chips">
      {#each whitelist as addr (addr)}
        <span class="wl-chip" title={addr}>
          <span class="wl-chip-addr">{truncate(addr)}</span>
          <button type="button" class="wl-chip-x" title="Remove" aria-label="Remove {addr}"
            onclick={() => removeFromWhitelist(addr)}>×</button>
        </span>
      {/each}
    </div>
  {/if}

  <!-- Add from the processors this wallet manages -->
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
      <div class="hint">Set an active wallet to list processors you can whitelist.</div>
    {:else if myProcStatus === 'error'}
      <div class="error-hint">{processorsState?.error ?? 'Failed to load processors.'}</div>
    {:else if myProcStatus === 'ok' && myProcessors.length === 0}
      <div class="hint">No processors are paired to this wallet on {network}.</div>
    {:else if myProcessors.length}
      {@const addable = myProcessors.filter((mp) => !whitelist.includes(mp.address))}
      <div class="wl-list">
        {#each myProcessors as mp (mp.address)}
          {@const added = whitelist.includes(mp.address)}
          <div class="wl-row" class:added>
            <span class="wl-dot {isOnline(mp.lastSeen) ? 'on' : 'off'}"
              title={isOnline(mp.lastSeen) ? 'Online' : `Last seen ${fmtRelative(mp.lastSeen)}`}></span>
            <span class="wl-row-addr" title={mp.address}>{truncate(mp.address)}</span>
            {#if mp.version}<span class="wl-ver">{mp.version}</span>{/if}
            <button type="button" class="wl-add" disabled={added}
              onclick={() => addToWhitelist(mp.address)}>
              {added ? 'Added' : 'Add'}
            </button>
          </div>
        {/each}
      </div>
      {#if addable.length > 1}
        <button type="button" class="secondary wl-add-all"
          onclick={() => setWhitelist([...whitelist, ...addable.map((mp) => mp.address)])}>
          Add all ({addable.length})
        </button>
      {/if}
    {:else}
      <div class="hint">Click “Load” to pull the processors paired to this wallet.</div>
    {/if}
  </div>

  <textarea id="f_whitelist" rows="3"
    {value}
    placeholder="One address per line — leave blank to allow any processor"
    oninput={(e) => onChange((e.target as HTMLTextAreaElement).value)}></textarea>
  <div class="hint">Only whitelisted processors can run this deployment. Edit directly or add yours above.</div>
</div>

<style>
  .wl-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }
  .wl-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 1px 4px 1px 8px;
    border-radius: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    font-size: 11px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .wl-chip-x {
    background: transparent;
    border: none;
    color: inherit;
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
    padding: 0 2px;
    opacity: 0.7;
  }
  .wl-chip-x:hover {
    opacity: 1;
  }

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
