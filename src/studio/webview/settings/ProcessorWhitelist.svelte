<script lang="ts">
  // Processor whitelist editor: a 2-column table (processor · remove) of the
  // current list, a manual address add, and the shared ProcessorPicker for
  // one-click add from the wallet's managed processors. Shares its table/add/
  // remove look with InstantMatchProcessors via the .proc-* classes in
  // global.css — the whitelist simply has no Max Delay column. The whitelist is
  // a newline-joined string; edits flow up via `onChange`.
  import type { WalletInfo, ProcessorsStateMsg } from '../../types';
  import ProcessorPicker from './ProcessorPicker.svelte';
  import { truncate } from '../lib/format';
  import { ICONS } from '../lib/icons';

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
  let newAddr = $state('');

  function setWhitelist(list: string[]) {
    onChange(list.join('\n'));
  }
  function addToWhitelist(addr: string) {
    const a = addr.trim();
    if (!a || whitelist.includes(a)) return;
    setWhitelist([...whitelist, a]);
  }
  function addAll(addrs: string[]) {
    const fresh = addrs.map((a) => a.trim()).filter((a) => a && !whitelist.includes(a));
    if (fresh.length) setWhitelist([...whitelist, ...fresh]);
  }
  function removeFromWhitelist(addr: string) {
    setWhitelist(whitelist.filter((a) => a !== addr));
  }
  function addManual() {
    addToWhitelist(newAddr);
    newAddr = '';
  }
</script>

<div class="field">
  <label for="f_whitelistAdd">Processor Whitelist <span class="label-optional">(optional)</span></label>

  {#if whitelist.length}
    <table class="proc-table">
      <thead>
        <tr>
          <th>Processor</th>
          <th class="proc-th-remove">Remove</th>
        </tr>
      </thead>
      <tbody>
        {#each whitelist as addr (addr)}
          <tr>
            <td class="proc-cell-addr" title={addr}>{truncate(addr)}</td>
            <td class="proc-remove-cell">
              <button type="button" class="proc-remove" title="Remove processor"
                aria-label="Remove {addr}" onclick={() => removeFromWhitelist(addr)}>
                {@html ICONS.trash}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}

  <div class="proc-add">
    <input id="f_whitelistAdd" type="text"
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
    selected={whitelist}
    onPick={addToWhitelist}
    allowAddAll
    onPickAll={addAll}
    noWalletHint="Set an active wallet to list processors you can whitelist."
  />

  <div class="hint">Only whitelisted processors can run this deployment. Leave empty to allow any.</div>
</div>
