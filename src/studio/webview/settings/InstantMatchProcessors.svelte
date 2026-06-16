<script lang="ts">
  // Instant-match processor editor. instantMatch is an array that can hold zero
  // (open matching), one, or many processors — each pinned with its OWN max
  // start delay. The chosen processors render as a 3-column table (processor ·
  // max delay · remove); below it a manual address add and the shared
  // ProcessorPicker. Shares its table/add/remove look with ProcessorWhitelist
  // via the .proc-* classes in global.css — only the extra Max Delay column and
  // its input are instant-match-specific.
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
    <table class="proc-table">
      <thead>
        <tr>
          <th>Processor</th>
          <th title="Maximum allowed start delay for this processor (ms)">Max Delay (ms)</th>
          <th class="proc-th-remove">Remove</th>
        </tr>
      </thead>
      <tbody>
        {#each value as entry, i (entry.processor)}
          <tr>
            <td class="proc-cell-addr" title={entry.processor}>{truncate(entry.processor)}</td>
            <td class="im-delay-cell">
              <input type="number" min="0" class="im-delay-input"
                aria-label="Max Delay for {entry.processor}"
                title="Maximum allowed start delay for this processor (ms)"
                value={entry.maxAllowedStartDelayInMs}
                oninput={(e) => onDelayInput(i, (e.currentTarget as HTMLInputElement).value)} />
              {#if humanDelay(entry.maxAllowedStartDelayInMs)}
                <span class="im-echo">≈ {humanDelay(entry.maxAllowedStartDelayInMs)}</span>
              {/if}
            </td>
            <td class="proc-remove-cell">
              <button type="button" class="proc-remove" title="Remove processor"
                aria-label="Remove {entry.processor}" onclick={() => removeAt(i)}>
                {@html ICONS.trash}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
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
  /* Max Delay column — the one part not shared with ProcessorWhitelist. */
  .im-delay-cell {
    white-space: nowrap;
  }
  .im-delay-input {
    width: 90px;
  }
  .im-echo {
    margin-left: 6px;
    color: var(--vscode-descriptionForeground);
  }
</style>
