<script lang="ts">
  // Fiat pricing-source settings — exchanger, optional API key, and display
  // currency. Self-contained: owns its form state, sends `fiat.*` messages, and
  // reflects the host's `fiat.listState` / `fiat.selection` via props.
  import type { CoinGeckoPlan, FiatListStateMsg, FiatSelectionStateMsg } from '../../types';
  import { send } from '../lib/vscode';
  import Spinner from '../shared/Spinner.svelte';

  interface Props {
    fiatList: FiatListStateMsg | null;
    fiatSelection: FiatSelectionStateMsg | null;
  }
  let { fiatList, fiatSelection }: Props = $props();

  const EXCHANGERS: Array<{ id: number; name: string }> = [
    { id: 1, name: 'CoinMarketCap' },
    { id: 2, name: 'CoinGecko' },
  ];
  let fiatExchangerId = $state<number>(2);
  let fiatCurrencyId = $state<string>('');
  let fiatApiKey = $state<string>('');
  let fiatApiKeyTouched = $state<boolean>(false);
  let coingeckoPlan = $state<CoinGeckoPlan>('demo');

  $effect(() => {
    if (!fiatSelection) return;
    fiatExchangerId = fiatSelection.exchangerId;
    fiatCurrencyId = fiatSelection.currencyId;
    coingeckoPlan = fiatSelection.coingeckoPlan;
    fiatApiKey = '';
    fiatApiKeyTouched = false;
  });

  function fiatRefreshList() {
    send('fiat.fetchList', {
      exchangerId: fiatExchangerId,
      apiKey: fiatApiKey.trim() || undefined,
      coingeckoPlan: fiatExchangerId === 2 ? coingeckoPlan : undefined,
    });
  }

  function fiatSave() {
    send('fiat.save', {
      exchangerId: fiatExchangerId,
      currencyId: fiatCurrencyId,
      apiKey: fiatApiKeyTouched ? fiatApiKey.trim() : undefined,
      coingeckoPlan: fiatExchangerId === 2 ? coingeckoPlan : undefined,
    });
  }

  function fiatClear() {
    fiatCurrencyId = '';
    send('fiat.save', {
      exchangerId: fiatExchangerId,
      currencyId: '',
      apiKey: fiatApiKeyTouched ? fiatApiKey.trim() : undefined,
      coingeckoPlan: fiatExchangerId === 2 ? coingeckoPlan : undefined,
    });
  }
</script>

<div class="field">
  <label for="f_fiatExchanger">Price source</label>
  <select id="f_fiatExchanger" onchange={(e) => { fiatExchangerId = Number((e.target as HTMLSelectElement).value); }}>
    {#each EXCHANGERS as ex}
      <option value={ex.id} selected={ex.id === fiatExchangerId}>{ex.name}</option>
    {/each}
  </select>
  <div class="hint">CoinMarketCap requires an API key. CoinGecko works keyless (public API) or with a Demo/Pro key.</div>
</div>
{#if fiatExchangerId === 2}
  <div class="field">
    <label for="f_fiatPlan">CoinGecko plan</label>
    <select id="f_fiatPlan" onchange={(e) => { coingeckoPlan = (e.target as HTMLSelectElement).value as CoinGeckoPlan; }}>
      <option value="demo" selected={coingeckoPlan === 'demo'}>Demo (api.coingecko.com)</option>
      <option value="pro" selected={coingeckoPlan === 'pro'}>Pro (pro-api.coingecko.com)</option>
    </select>
    <div class="hint">Both key types start with <code>CG-</code> so the tier can't be auto-detected. Leave key blank to use the public/keyless API.</div>
  </div>
{/if}
<div class="field">
  <label for="f_fiatApiKey">API key {fiatSelection?.hasApiKey && fiatExchangerId === fiatSelection.exchangerId ? '(stored)' : ''}</label>
  <input id="f_fiatApiKey" type="password" autocomplete="off"
    placeholder={fiatSelection?.hasApiKey && fiatExchangerId === fiatSelection.exchangerId ? '•••••••• (saved — type to replace)' : 'optional (blank = public/keyless)'}
    value={fiatApiKey}
    oninput={(e) => { fiatApiKey = (e.target as HTMLInputElement).value; fiatApiKeyTouched = true; }} />
  <div class="hint">Stored in the OS keychain (SecretStorage). Not written to settings.json.</div>
</div>
<div class="field">
  <label for="f_fiatCurrency">Display currency</label>
  <div style="display:flex; gap:6px;">
    <select id="f_fiatCurrency" style="flex:1;"
      onchange={(e) => { fiatCurrencyId = (e.target as HTMLSelectElement).value; }}
      disabled={!fiatList || fiatList.status !== 'ok' || fiatList.exchangerId !== fiatExchangerId}>
      <option value="" selected={fiatCurrencyId === ''}>— Disabled —</option>
      {#if fiatList && fiatList.status === 'ok' && fiatList.exchangerId === fiatExchangerId && fiatList.list}
        {#each fiatList.list as c (c.id)}
          <option value={c.id} selected={c.id === fiatCurrencyId}>{c.symbol} — {c.name}{c.sign ? ` (${c.sign})` : ''}</option>
        {/each}
      {/if}
    </select>
    <button class="secondary" style="font-size:11px;" disabled={fiatList?.status === 'loading'} onclick={fiatRefreshList}>
      {#if fiatList?.status === 'loading' && fiatList.exchangerId === fiatExchangerId}
        <Spinner size={10} label="Loading…" />
      {:else}
        Load list
      {/if}
    </button>
  </div>
  {#if fiatList?.status === 'error' && fiatList.exchangerId === fiatExchangerId}
    <div class="error-hint">{fiatList.error}</div>
  {:else if !fiatList || fiatList.exchangerId !== fiatExchangerId}
    <div class="hint">Click "Load list" to populate the currency picker for the chosen source.</div>
  {:else}
    <div class="hint">Shown alongside ACU in the deploy cost estimate.</div>
  {/if}
</div>
<div class="toolbar">
  <button onclick={fiatSave}>Save pricing source</button>
  {#if fiatCurrencyId}
    <button class="secondary" onclick={fiatClear}>Disable fiat</button>
  {/if}
</div>
