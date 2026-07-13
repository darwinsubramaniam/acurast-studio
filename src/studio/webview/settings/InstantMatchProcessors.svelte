<script lang="ts">
  // Instant-match processor editor. instantMatch is an array that can hold zero
  // (open matching), one, or many processors — each pinned with its OWN max
  // start delay. Each chosen processor renders as its own card (address + remove
  // on top, max delay underneath); below the list a manual address add and the
  // shared ProcessorPicker. Shares its card/add/remove look with
  // ProcessorWhitelist via the .proc-* classes in global.css — only the max
  // delay row is instant-match-specific.
  import type { WalletInfo, ProcessorsStateMsg, InstantMatchEntry } from '../../types';
  import ProcessorPicker from './ProcessorPicker.svelte';
  import { truncate, fmtDuration } from '../lib/format';
  import { ICONS } from '../lib/icons';

  const DEFAULT_DELAY_MS = 10_000;

  interface Props {
    /** Current instant-match entries (processor + its own start delay). */
    value: InstantMatchEntry[];
    onChange: (entries: InstantMatchEntry[]) => void;
    activeWallet: WalletInfo | null;
    processorsState: ProcessorsStateMsg | null;
    /** Project network to query processors under. */
    network: string;
  }
  let { value, onChange, activeWallet, processorsState, network }: Props = $props();

  let newAddr = $state('');

  let addresses = $derived(value.map((e) => e.processor));

  function addEntry(addr: string) {
    const proc = addr.trim();
    if (!proc || addresses.includes(proc)) return;
    onChange([...value, { processor: proc, maxAllowedStartDelayInMs: DEFAULT_DELAY_MS }]);
  }
  function addAll(addrs: string[]) {
    const fresh = addrs
      .map((a) => a.trim())
      .filter((a) => a && !addresses.includes(a))
      .map((processor) => ({ processor, maxAllowedStartDelayInMs: DEFAULT_DELAY_MS }));
    if (fresh.length) onChange([...value, ...fresh]);
  }
  function removeAt(i: number) {
    onChange(value.filter((_, idx) => idx !== i));
  }
  function setDelay(i: number, ms: number) {
    onChange(value.map((e, idx) => (idx === i ? { ...e, maxAllowedStartDelayInMs: ms } : e)));
  }
  function onDelayInput(i: number, raw: string) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) setDelay(i, n);
  }
  function addManual() {
    addEntry(newAddr);
    newAddr = '';
  }

  function humanDelay(ms: number): string {
    return Number.isFinite(ms) && ms > 0 ? fmtDuration(ms) : '';
  }
</script>

<div class="field">
  <label for="f_imAdd">Instant Match Processors <span class="label-optional">(optional)</span></label>

  {#if value.length}
    <ul class="proc-list">
      {#each value as entry, i (entry.processor)}
        <li class="proc-item">
          <div class="proc-item-head">
            <span class="proc-item-addr" title={entry.processor}>{truncate(entry.processor)}</span>
            <button type="button" class="proc-remove" title="Remove processor"
              aria-label="Remove {entry.processor}" onclick={() => removeAt(i)}>
              {@html ICONS.trash}
            </button>
          </div>
          <div class="im-delay">
            <label class="im-delay-label" for="im_delay_{i}">Max delay (ms)</label>
            <input id="im_delay_{i}" type="number" min="0" class="im-delay-input"
              title="Maximum allowed start delay for this processor (ms)"
              value={entry.maxAllowedStartDelayInMs}
              oninput={(e) => onDelayInput(i, (e.currentTarget as HTMLInputElement).value)} />
            {#if humanDelay(entry.maxAllowedStartDelayInMs)}
              <span class="im-echo">≈ {humanDelay(entry.maxAllowedStartDelayInMs)}</span>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <div class="proc-add">
    <input id="f_imAdd" type="text"
      placeholder="5CiP… add a processor address"
      value={newAddr}
      oninput={(e) => (newAddr = (e.currentTarget as HTMLInputElement).value)}
      onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addManual(); } }} />
    <button type="button" class="secondary" disabled={!newAddr.trim()} onclick={addManual}>Add</button>
  </div>

  <!-- Add from the processors this wallet manages -->
  <ProcessorPicker
    {activeWallet}
    {processorsState}
    {network}
    selected={addresses}
    onPick={addEntry}
    allowAddAll
    onPickAll={addAll}
    noWalletHint="Set an active wallet to pick from the processors you manage."
  />

  <div class="hint">Pin specific processors — each with its own max start delay. Leave empty for open matching.</div>
</div>

<style>
  /* Max delay row — the one part not shared with ProcessorWhitelist. Wraps so a
     narrow sidebar drops the value below its label instead of overflowing. */
  .im-delay {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 8px;
  }
  .im-delay-label {
    flex: none;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
  }
  .im-delay-input {
    flex: none;
    width: 90px;
  }
  .im-echo {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }
</style>
