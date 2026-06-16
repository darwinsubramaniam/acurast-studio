<script lang="ts">
  import type { Route, PricingStateMsg, FiatListStateMsg, FiatSelectionStateMsg, CoinGeckoPlan, WalletInfo, ProcessorsStateMsg, ManagedProcessor } from '../../types';
  import { send } from '../lib/vscode';
  import Spinner from '../shared/Spinner.svelte';
  import FiatNote from '../shared/FiatNote.svelte';
  import { adviceVerdict, isNonPriceBlocker } from '../lib/pricing';
  import { Accordion } from 'bits-ui';
  import { planckToAcu, fmtRelative, truncate, fmtDuration } from '../lib/format';
  import { getNested, instantMatchField, buildPatch, validateConfig } from '../lib/acurastConfig';

  // Section ids match the Accordion.Item `value=` below. Open-by-default = listed here.
  let openSections = $state<string[]>(['identity', 'runtime', 'execution', 'scaling']);

  interface Props {
    ctx: { configPath: string | null; configRel: string | null };
    config: { data: unknown; projectKey: string | null };
    navigate: (r: Route) => void;
    pricing: PricingStateMsg | null;
    fiatList: FiatListStateMsg | null;
    fiatSelection: FiatSelectionStateMsg | null;
    wallets: { list: WalletInfo[]; activeId: string | null; network: string };
    processorsState: ProcessorsStateMsg | null;
  }
  let { ctx, config, pricing, fiatList, fiatSelection, wallets, processorsState }: Props = $props();

  // Pricing config form state — local edits before save.
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

  let draft = $state<Record<string, unknown>>({});
  let dirty = $derived(Object.keys(draft).length > 0);
  let projectKey = $state<string | null>(null);

  $effect(() => {
    config.data;
    draft = {};
    projectKey = null;
  });

  function projects(): Record<string, Record<string, unknown>> {
    const d = config.data as { projects?: Record<string, Record<string, unknown>> } | null;
    return d?.projects ?? {};
  }

  function currentProject(): Record<string, unknown> | null {
    const k = activeKey();
    return k ? (projects()[k] ?? null) : null;
  }

  function activeKey(): string | null {
    const keys = Object.keys(projects());
    if (!keys.length) return null;
    if (projectKey && keys.includes(projectKey)) return projectKey;
    return keys[0];
  }

  function rd(key: string, fallback: unknown): unknown {
    return key in draft ? draft[key] : fallback;
  }

  function patchField(key: string, value: unknown) {
    draft[key] = value;
  }

  // Display-only human-readable echo of a millisecond field (stored value stays ms).
  function msHuman(v: unknown): string {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? fmtDuration(n) : '';
  }

  const errors = $derived.by(() => validateConfig(draft, currentProject()));

  const hasErrors = $derived(Object.keys(errors).length > 0);

  function onSave() {
    const key = activeKey();
    if (!key || !dirty || hasErrors) return;
    send('config.save', { projectKey: key, patch: buildPatch(draft, currentProject()) });
  }

  function onDiscard() {
    draft = {};
  }

  function onProjectChange(e: Event) {
    const sel = e.target as HTMLSelectElement;
    if (dirty && !confirm('Discard unsaved changes?')) {
      sel.value = activeKey() ?? '';
      return;
    }
    projectKey = sel.value;
    draft = {};
  }

  function getExec(p: Record<string, unknown>, subKey: string): unknown {
    return (p.execution as Record<string, unknown> | undefined)?.[subKey];
  }

  function reuseKeysFromText(p: Record<string, unknown>): string {
    const v = p.reuseKeysFrom;
    if (!v) return '';
    try { return JSON.stringify(v); } catch { return ''; }
  }

  // ── Processor whitelist ────────────────────────────────────────────────────
  // The whitelist draft is kept as a newline-joined string (see buildPatch).
  let activeWallet = $derived(
    wallets.list.find((w) => w.id === wallets.activeId) ?? null,
  );

  function projectNetwork(): string {
    const p = currentProject();
    return (draft['network'] as string) ?? (p?.network as string) ?? 'mainnet';
  }

  function whitelistText(p: Record<string, unknown> | null): string {
    return Array.isArray(p?.processorWhitelist)
      ? (p!.processorWhitelist as string[]).join('\n')
      : '';
  }

  let whitelist = $derived.by<string[]>(() => {
    const raw = (rd('processorWhitelist', whitelistText(currentProject())) ?? '') as string;
    return raw.split('\n').map((s) => s.trim()).filter(Boolean);
  });

  function setWhitelist(list: string[]) {
    patchField('processorWhitelist', list.join('\n'));
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
    send('processors.query', {
      address: activeWallet.address,
      network: projectNetwork(),
    });
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

  const satoshiToACU = planckToAcu;

  function inBucket(price: string, bucket: { range_min: string; range_max: string }): boolean {
    const p = parseFloat(price), mn = parseFloat(bucket.range_min), mx = parseFloat(bucket.range_max);
    return p >= mn && p < mx;
  }

  function applySuggestedPrice(suggested: string | null) {
    if (!suggested) return;
    patchField('maxCostPerExecution', Math.ceil(parseFloat(suggested)));
  }

  const pricingDirty = $derived('maxCostPerExecution' in draft || 'numberOfReplicas' in draft);
</script>

{#if !config.data}
  <div class="empty">
    <p>No active <code>acurast.json</code>.</p>
    <button class="full" onclick={() => send('config.choose')}>Choose acurast.json…</button>
  </div>
{:else}
  {@const projs = projects()}
  {@const keys = Object.keys(projs)}
  {#if !keys.length}
    <div class="empty"><p>No projects in acurast.json.</p></div>
  {:else}
    {@const key = activeKey()!}
    {@const p = projs[key]}
    {@const sym = ((rd('network', p.network) ?? 'mainnet') === 'mainnet') ? 'ACU' : 'cACU'}
    {@const runtime = (rd('runtime', p.runtime) ?? 'NodeJSWithBundle') as string}
    {@const execType = (rd('execution.type', getExec(p, 'type')) ?? 'onetime') as string}
    {@const assignType = (rd('assignmentStrategy.type', getNested(p, 'assignmentStrategy', 'type')) ?? 'Single') as string}
    {@const mutability = (rd('mutability', p.mutability) ?? 'Immutable') as string}
    {@const modules = (rd('requiredModules', p.requiredModules) ?? []) as string[]}
    {@const imProcessor = rd('assignmentStrategy.instantMatch.processor', instantMatchField(p, 'processor')) as string | null | undefined}

    {#snippet durEcho(v: unknown)}
      {@const h = msHuman(v)}
      {#if h}<div class="hint dur-echo">≈ {h}</div>{/if}
    {/snippet}

    <div class="active-config" title={ctx.configPath ?? ''}>
      <span class="active-config-label">FILE</span>
      <code class="active-config-path">{ctx.configRel || 'acurast.json'}</code>
      <button class="active-config-switch" onclick={() => send('config.choose')} title="Switch acurast.json">Switch</button>
    </div>

    <div class="toolbar">
      <button class="secondary" onclick={() => send('config.openJson')}>Open acurast.json</button>
    </div>

    <Accordion.Root type="multiple" bind:value={openSections} class="acc">

    <!-- Fiat pricing source -->
    <Accordion.Item value="fiat" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class="section-title acc-trigger">Fiat Pricing</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
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
      </Accordion.Content>
    </Accordion.Item>

    <div class="field" style="margin: 12px 0;">
      <label for="projectPicker">Project</label>
      <select id="projectPicker" onchange={onProjectChange}>
        {#each keys as k}
          <option value={k} selected={k === key}>{k}</option>
        {/each}
      </select>
    </div>

    <!-- Identity -->
    <Accordion.Item value="identity" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Identity</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_projectName">Project Name</label>
        <input id="f_projectName" type="text"
          value={rd('projectName', p.projectName) ?? ''}
          class:field-error={'projectName' in errors}
          oninput={(e) => patchField('projectName', (e.target as HTMLInputElement).value)} />
        {#if errors.projectName}<div class="error-hint">{errors.projectName}</div>{/if}
      </div>
      <div class="field">
        <label for="f_network">Network</label>
        <select id="f_network" onchange={(e) => patchField('network', (e.target as HTMLSelectElement).value)}>
          {#each ['mainnet', 'canary'] as opt}
            <option value={opt} selected={opt === (rd('network', p.network) ?? 'mainnet')}>{opt}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="f_fileUrl">File URL</label>
        <input id="f_fileUrl" type="text"
          value={rd('fileUrl', p.fileUrl) ?? ''}
          class:field-error={'fileUrl' in errors}
          oninput={(e) => patchField('fileUrl', (e.target as HTMLInputElement).value)} />
        {#if errors.fileUrl}
          <div class="error-hint">{errors.fileUrl}</div>
        {:else}
          <div class="hint">Bundled file path, IPFS hash, or HTTPS URL</div>
        {/if}
      </div>
      </Accordion.Content>
    </Accordion.Item>

    <!-- Build -->
    <Accordion.Item value="build" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Build</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_buildCommand">Build command <span class="label-optional">(optional)</span></label>
        <input id="f_buildCommand" type="text"
          value={rd('build.command', getNested(p, 'build', 'command')) ?? ''}
          placeholder="e.g. npm run build · cargo build --release"
          oninput={(e) => patchField('build.command', (e.target as HTMLInputElement).value)} />
        <div class="hint">Runs before deploy (and via the Build action) to produce the artifact. Any toolchain — trusted workspace only.</div>
      </div>
      <div class="field">
        <label for="f_buildCwd">Working directory <span class="label-optional">(optional)</span></label>
        <input id="f_buildCwd" type="text"
          value={rd('build.cwd', getNested(p, 'build', 'cwd')) ?? ''}
          placeholder="(project root)"
          oninput={(e) => patchField('build.cwd', (e.target as HTMLInputElement).value)} />
        <div class="hint">Where the command runs, relative to the project root.</div>
      </div>
      <div class="field">
        <label for="f_buildOutput">Output artifact <span class="label-optional">(optional)</span></label>
        <input id="f_buildOutput" type="text"
          value={rd('build.output', getNested(p, 'build', 'output')) ?? ''}
          placeholder="e.g. dist/index.js"
          oninput={(e) => patchField('build.output', (e.target as HTMLInputElement).value)} />
        <div class="hint">Artifact to deploy; overrides File URL. Verified to exist after the build. Relative to the project root.</div>
      </div>
      </Accordion.Content>
    </Accordion.Item>

    <!-- Runtime -->
    <Accordion.Item value="runtime" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Runtime</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_runtime">Runtime</label>
        <select id="f_runtime" onchange={(e) => patchField('runtime', (e.target as HTMLSelectElement).value)}>
          {#each ['NodeJSWithBundle', 'NodeJS', 'Shell'] as opt}
            <option value={opt} selected={opt === runtime}>{opt}</option>
          {/each}
        </select>
      </div>
      {#if runtime === 'Shell'}
        <div class="field">
          <label for="f_entrypoint">Entrypoint</label>
          <input id="f_entrypoint" type="text"
            value={rd('entrypoint', p.entrypoint) ?? ''}
            placeholder="acurast.sh"
            oninput={(e) => patchField('entrypoint', (e.target as HTMLInputElement).value)} />
          <div class="hint">Script or binary the processor runs inside the image</div>
        </div>
        <div class="field">
          <label for="f_imageUrl">Image URL</label>
          <input id="f_imageUrl" type="text"
            value={rd('image.url', getNested(p, 'image', 'url')) ?? ''}
            class:field-error={'image.url' in errors}
            placeholder="https://github.com/termux/proot-distro/releases/..."
            oninput={(e) => patchField('image.url', (e.target as HTMLInputElement).value)} />
          {#if errors['image.url']}
            <div class="error-hint">{errors['image.url']}</div>
          {:else}
            <div class="hint">HTTPS URL to .tar.xz distro image</div>
          {/if}
        </div>
        <div class="field">
          <label for="f_imageSha">Image SHA256</label>
          <input id="f_imageSha" type="text"
            value={rd('image.sha256', getNested(p, 'image', 'sha256')) ?? ''}
            class:field-error={'image.sha256' in errors}
            placeholder="64-character hex"
            oninput={(e) => patchField('image.sha256', (e.target as HTMLInputElement).value)} />
          {#if errors['image.sha256']}
            <div class="error-hint">{errors['image.sha256']}</div>
          {:else}
            <div class="hint">SHA256 of the image for verification</div>
          {/if}
        </div>
        <div class="field">
          <label for="f_restartPolicy">Restart Policy</label>
          <select id="f_restartPolicy" onchange={(e) => patchField('restartPolicy', (e.target as HTMLSelectElement).value)}>
            {#each ['no', 'always', 'on-failure'] as opt}
              <option value={opt} selected={opt === (rd('restartPolicy', p.restartPolicy) ?? 'no')}>{opt}</option>
            {/each}
          </select>
        </div>
      {/if}
      <div class="field">
        <div class="checkbox-field">
          <input id="f_onlyAttested" type="checkbox"
            checked={!!(rd('onlyAttestedDevices', p.onlyAttestedDevices))}
            onchange={(e) => patchField('onlyAttestedDevices', (e.target as HTMLInputElement).checked)} />
          <label for="f_onlyAttested" style="margin:0;text-transform:none;letter-spacing:0;">Only attested devices</label>
        </div>
      </div>
      <div class="field">
        <div class="checkbox-field">
          <input id="f_devtools" type="checkbox"
            checked={!!(rd('enableDevtools', p.enableDevtools))}
            onchange={(e) => patchField('enableDevtools', (e.target as HTMLInputElement).checked)} />
          <label for="f_devtools" style="margin:0;text-transform:none;letter-spacing:0;">Enable DevTools</label>
        </div>
      </div>
      </Accordion.Content>
    </Accordion.Item>

    <!-- Execution -->
    <Accordion.Item value="execution" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Execution</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_assignType">Assignment Strategy</label>
        <select id="f_assignType" onchange={(e) => patchField('assignmentStrategy.type', (e.target as HTMLSelectElement).value)}>
          {#each ['Single', 'Competing'] as opt}
            <option value={opt} selected={opt === assignType}>{opt}</option>
          {/each}
        </select>
        <div class="hint">{assignType === 'Single' ? 'One set of processors for all executions' : 'New processors assigned per execution'}</div>
      </div>
      {#if assignType === 'Single'}
        <div class="field">
          <label for="f_imProcessor">Instant Match Processor <span class="label-optional">(optional)</span></label>
          <input id="f_imProcessor" type="text"
            value={imProcessor ?? ''}
            placeholder="5CiP… (leave blank for open matching)"
            oninput={(e) => patchField('assignmentStrategy.instantMatch.processor', (e.target as HTMLInputElement).value || null)} />
        </div>
        {#if imProcessor}
          <div class="field">
            <label for="f_imDelay">Instant Match Max Start Delay (ms)</label>
            <input id="f_imDelay" type="number"
              value={rd('assignmentStrategy.instantMatch.maxAllowedStartDelayInMs', instantMatchField(p, 'maxAllowedStartDelayInMs')) ?? 10000}
              oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('assignmentStrategy.instantMatch.maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
            {@render durEcho(rd('assignmentStrategy.instantMatch.maxAllowedStartDelayInMs', instantMatchField(p, 'maxAllowedStartDelayInMs')) ?? 10000)}
          </div>
        {/if}
      {/if}
      <div class="field">
        <label for="f_execType">Execution Type</label>
        <select id="f_execType" onchange={(e) => patchField('execution.type', (e.target as HTMLSelectElement).value)}>
          {#each ['onetime', 'interval'] as opt}
            <option value={opt} selected={opt === execType}>{opt}</option>
          {/each}
        </select>
      </div>
      {#if execType === 'interval'}
        <div class="field">
          <label for="f_intervalMs">Interval (ms)</label>
          <input id="f_intervalMs" type="number"
            value={rd('execution.intervalInMs', getExec(p, 'intervalInMs')) ?? ''}
            class:field-error={'execution.intervalInMs' in errors}
            oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.intervalInMs', isNaN(n) ? null : n); }} />
          {#if errors['execution.intervalInMs']}
            <div class="error-hint">{errors['execution.intervalInMs']}</div>
          {:else}
            <div class="hint">Time between each execution start</div>
          {/if}
          {@render durEcho(rd('execution.intervalInMs', getExec(p, 'intervalInMs')))}
        </div>
        <div class="field">
          <label for="f_numExec">Number of Executions</label>
          <input id="f_numExec" type="number"
            value={rd('execution.numberOfExecutions', getExec(p, 'numberOfExecutions')) ?? ''}
            class:field-error={'execution.numberOfExecutions' in errors}
            oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.numberOfExecutions', isNaN(n) ? null : n); }} />
          {#if errors['execution.numberOfExecutions']}
            <div class="error-hint">{errors['execution.numberOfExecutions']}</div>
          {/if}
        </div>
      {/if}
      <div class="field">
        <label for="f_execTime">Max execution time (ms)</label>
        <input id="f_execTime" type="number"
          value={rd('execution.maxExecutionTimeInMs', getExec(p, 'maxExecutionTimeInMs')) ?? 10000}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.maxExecutionTimeInMs', isNaN(n) ? null : n); }} />
        {#if execType === 'interval'}
          <div class="hint">Recommend at least 10 000 ms less than interval</div>
        {/if}
        {@render durEcho(rd('execution.maxExecutionTimeInMs', getExec(p, 'maxExecutionTimeInMs')) ?? 10000)}
      </div>
      <div class="field">
        <label for="f_startDelay">Max start delay (ms)</label>
        <input id="f_startDelay" type="number"
          value={rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
        {@render durEcho(rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000)}
      </div>
      </Accordion.Content>
    </Accordion.Item>

    <!-- Scaling & Cost -->
    <Accordion.Item value="scaling" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Scaling &amp; Cost</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_replicas">Replicas</label>
        <input id="f_replicas" type="number"
          value={rd('numberOfReplicas', p.numberOfReplicas) ?? 1}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('numberOfReplicas', isNaN(n) ? null : n); }} />
      </div>
      <div class="field">
        <label for="f_maxCost">Max cost per execution</label>
        <input id="f_maxCost" type="number"
          value={rd('maxCostPerExecution', p.maxCostPerExecution) ?? 0}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxCostPerExecution', isNaN(n) ? null : n); }} />
        <div class="hint">Planck units (1 {sym} = 1e12 planck)</div>
      </div>
      <div class="field">
        <label for="f_reputation">Min processor reputation</label>
        <input id="f_reputation" type="number"
          value={rd('minProcessorReputation', p.minProcessorReputation) ?? 0}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('minProcessorReputation', isNaN(n) ? null : n); }} />
      </div>

      <div class="subsection-title">Usage Limits</div>
      <div class="field">
        <label for="f_maxMem">Max memory (bytes)</label>
        <input id="f_maxMem" type="number"
          value={rd('usageLimit.maxMemory', getNested(p, 'usageLimit', 'maxMemory')) ?? 0}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxMemory', isNaN(n) ? null : n); }} />
        <div class="hint">0 = unlimited</div>
      </div>
      <div class="field">
        <label for="f_maxNet">Max network requests</label>
        <input id="f_maxNet" type="number"
          value={rd('usageLimit.maxNetworkRequests', getNested(p, 'usageLimit', 'maxNetworkRequests')) ?? 0}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxNetworkRequests', isNaN(n) ? null : n); }} />
        <div class="hint">0 = unlimited</div>
      </div>
      <div class="field">
        <label for="f_maxStorage">Max storage (bytes)</label>
        <input id="f_maxStorage" type="number"
          value={rd('usageLimit.maxStorage', getNested(p, 'usageLimit', 'maxStorage')) ?? 0}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxStorage', isNaN(n) ? null : n); }} />
        <div class="hint">0 = unlimited</div>
      </div>

      <div class="pricing-box">
        <div class="pricing-box-header">
          <span class="pricing-box-title">Market Pricing</span>
          <button class="secondary" style="font-size:10px;padding:2px 8px;" disabled={pricing?.status === 'loading'} onclick={() => send('pricing.fetch')}>
            {pricing?.status === 'loading' ? 'Checking…' : pricing?.status === 'ok' ? '⟳ Refresh' : 'Check market price'}
          </button>
        </div>

        {#if pricingDirty && pricing?.status === 'ok'}
          <div class="pricing-stale-note">Save changes first — pricing reflects the saved config.</div>
        {/if}

        {#if pricing?.status === 'loading'}
          <div class="pricing-muted"><Spinner size={11} label="Fetching live market data…" /></div>
        {:else if pricing?.status === 'error'}
          <div class="pricing-error-note">{pricing.error}</div>
        {:else if pricing?.status === 'ok' && pricing.fees}
          {@const fees = pricing.fees}
          {@const advice = pricing.advice}
          {@const fiat = pricing.fiat && !pricing.fiat.error ? pricing.fiat : null}

          {#if advice}
            {@const nonPriceBlocker = isNonPriceBlocker(advice)}
            {@const tunnelGate = advice.status === 'insufficient' && Number(getNested(p, 'minProcessorVersions', 'android') ?? 0) >= 122}
            {@const verdict = adviceVerdict(advice.status)}
            <div class="pricing-status-row pricing-{advice.status}">
              <span>{verdict.icon} {verdict.label}</span>
              <span class="pricing-match">{advice.matchedProcessors} / {advice.requiredProcessors} processors</span>
            </div>

            <div class="pricing-rows">
              <span class="pricing-label">Your price</span>
              <span class="pricing-value">
                {satoshiToACU(advice.currentPrice)} {sym}/exec
                <FiatNote value={advice.currentPrice} kind="planck" {fiat} />
              </span>
              {#if advice.averagePrice}
                <span class="pricing-label">Market avg</span>
                <span class="pricing-value">
                  {satoshiToACU(advice.averagePrice)} {sym}/exec
                  <FiatNote value={advice.averagePrice} kind="planck" {fiat} />
                </span>
              {/if}
              {#if advice.suggestedPrice}
                <span class="pricing-label">Suggested</span>
                <span class="pricing-value">
                  {satoshiToACU(advice.suggestedPrice)} {sym}/exec
                  <FiatNote value={advice.suggestedPrice} kind="planck" {fiat} />
                </span>
              {/if}
              <span class="pricing-label">Total cost</span>
              <span class="pricing-value">
                {fees.maxTotalCostCACU} {sym}
                <FiatNote value={fees.maxTotalCostCACU} kind="acu" {fiat} />
              </span>
            </div>

            {#if advice.distribution.length > 0}
              {@const maxCount = Math.max(...advice.distribution.map(b => b.count))}
              <div class="dist-chart">
                {#each advice.distribution as bucket}
                  {@const isYours = inBucket(advice.currentPrice, bucket)}
                  {@const isSuggested = advice.suggestedPrice != null && inBucket(advice.suggestedPrice, bucket)}
                  <div class="dist-row" class:dist-yours={isYours} class:dist-suggested={isSuggested}>
                    <span class="dist-range">{satoshiToACU(bucket.range_min)}</span>
                    <div class="dist-bar-wrap">
                      <div class="dist-bar" style="width:{maxCount > 0 ? (bucket.count / maxCount * 100).toFixed(0) : 0}%"></div>
                    </div>
                    <span class="dist-count">{bucket.count}</span>
                    {#if isYours}<span class="dist-marker">←you</span>
                    {:else if isSuggested}<span class="dist-marker">←ok</span>
                    {:else}<span class="dist-marker"></span>{/if}
                  </div>
                {/each}
              </div>
            {/if}

            {#if tunnelGate}
              <div class="pricing-warn-note" style="margin-top:6px;">
                No public {(rd('network', p.network) ?? 'mainnet')} processor advertises a tunnel-capable build (Android ≥ 122 / Processor 1.26.0-rc1+) right now. Tunnel jobs run on your <strong>own</strong> processor — deploy and it will pick up the job once online. Price is not the blocker.
              </div>
            {:else if nonPriceBlocker}
              <div class="pricing-warn-note" style="margin-top:6px;">
                Your price already meets the suggested rate — 0 matches is from a non-price requirement (min processor version, required modules, attestation, or reputation), not cost. Adjusting the price won't help.
              </div>
            {:else if advice.status !== 'sufficient' && advice.suggestedPrice}
              <button class="secondary" style="margin-top:6px;font-size:11px;" onclick={() => applySuggestedPrice(advice!.suggestedPrice)}>
                Apply suggested price ({satoshiToACU(advice.suggestedPrice)} {sym})
              </button>
            {/if}

          {:else}
            {#if pricing.fallbackReason}
              <div class="pricing-muted">
                {pricing.fallbackReason === 'no-wallet' ? 'Set an active wallet to get live market pricing.' :
                 pricing.fallbackReason === 'instant-match' ? 'Instant-match job — static estimate only.' :
                 pricing.fallbackReason === 'targeted' ? 'Targeting whitelisted processors — market pricing skipped (the matcher ignores your whitelist). Static estimate only.' :
                 'Live pricing unavailable — static estimate.'}
              </div>
            {/if}
            <div class="pricing-rows">
              <span class="pricing-label">Suggested</span>
              <span class="pricing-value">
                {fees.suggestedCostPerExecutionCACU} {sym}/exec
                <FiatNote value={fees.suggestedCostPerExecutionCACU} kind="acu" {fiat} />
              </span>
              <span class="pricing-label">Your max</span>
              <span class="pricing-value">
                {fees.maxCostPerExecutionCACU} {sym}/exec
                <FiatNote value={fees.maxCostPerExecutionCACU} kind="acu" {fiat} />
              </span>
              <span class="pricing-label">Total</span>
              <span class="pricing-value">
                {fees.maxTotalCostCACU} {sym}
                <FiatNote value={fees.maxTotalCostCACU} kind="acu" {fiat} />
              </span>
            </div>
            {#if parseFloat(fees.excessCostPerExecution) < 0}
              <div class="pricing-warn-note">⚠ Your max cost is below the suggested fee — may not match.</div>
            {:else if parseFloat(fees.excessCostPerExecutionPercentage) > 0.1}
              <div class="pricing-warn-note">⚠ {(parseFloat(fees.excessCostPerExecutionPercentage) * 100).toFixed(0)}% above suggested — you may be overpaying.</div>
            {/if}
          {/if}
        {:else}
          <div class="pricing-muted">Check the live market to see if your price will match processors.</div>
        {/if}
      </div>
      </Accordion.Content>
    </Accordion.Item>

    <!-- Advanced -->
    <Accordion.Item value="advanced" class="section acc-item">
      <Accordion.Header>
        <Accordion.Trigger class={`section-title acc-trigger${dirty ? ' dirty' : ''}`}>Advanced</Accordion.Trigger>
      </Accordion.Header>
      <Accordion.Content class="acc-content">
      <div class="field">
        <label for="f_mutability">Mutability</label>
        <select id="f_mutability" onchange={(e) => patchField('mutability', (e.target as HTMLSelectElement).value)}>
          {#each ['Immutable', 'Mutable'] as opt}
            <option value={opt} selected={opt === mutability}>{opt}</option>
          {/each}
        </select>
        <div class="hint">{mutability === 'Mutable' ? '⚠ Can be modified after creation — use with care' : 'Cannot be modified after creation (recommended)'}</div>
      </div>
      {#if mutability === 'Mutable'}
        <div class="field">
          <label for="f_reuseKeys">Reuse Keys From <span class="label-optional">(optional)</span></label>
          <input id="f_reuseKeys" type="text"
            value={rd('reuseKeysFrom', reuseKeysFromText(p)) ?? ''}
            class:field-error={'reuseKeysFrom' in errors}
            placeholder='["Acurast", "5CiP…", 123456]'
            oninput={(e) => patchField('reuseKeysFrom', (e.target as HTMLInputElement).value)} />
          {#if errors.reuseKeysFrom}
            <div class="error-hint">{errors.reuseKeysFrom}</div>
          {:else}
            <div class="hint">Reuse encryption keys from a previous Mutable deployment</div>
          {/if}
        </div>
      {/if}
      <div class="field" role="group" aria-labelledby="mod-group-label">
        <div id="mod-group-label" class="group-label">Required Modules</div>
        {#each ['DataEncryption', 'LLM'] as mod}
          <div class="checkbox-field" style="margin-top:4px;">
            <input type="checkbox" id="mod_{mod}"
              checked={modules.includes(mod)}
              onchange={(e) => {
                const checked = (e.target as HTMLInputElement).checked;
                const current = (rd('requiredModules', p.requiredModules) ?? []) as string[];
                patchField('requiredModules', checked ? [...current, mod] : current.filter(m => m !== mod));
              }} />
            <label for="mod_{mod}" style="margin:0;text-transform:none;letter-spacing:0;">{mod}</label>
          </div>
        {/each}
        {#if runtime === 'Shell'}
          <div class="hint" style="margin-top:4px;">Shell module auto-injected for Shell runtime</div>
        {/if}
      </div>
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
            <div class="hint">No processors are paired to this wallet on {projectNetwork()}.</div>
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
          value={rd('processorWhitelist', whitelistText(p)) ?? ''}
          placeholder="One address per line — leave blank to allow any processor"
          oninput={(e) => patchField('processorWhitelist', (e.target as HTMLTextAreaElement).value)}></textarea>
        <div class="hint">Only whitelisted processors can run this deployment. Edit directly or add yours above.</div>
      </div>
      <div class="field">
        <label for="f_minAndroid">Min processor Android version <span class="label-optional">(optional)</span></label>
        <input id="f_minAndroid" type="text"
          value={rd('minProcessorVersions.android', getNested(p, 'minProcessorVersions', 'android')) ?? ''}
          placeholder="e.g. 9"
          oninput={(e) => patchField('minProcessorVersions.android', (e.target as HTMLInputElement).value || null)} />
      </div>
      <div class="field">
        <label for="f_minIos">Min processor iOS version <span class="label-optional">(optional)</span></label>
        <input id="f_minIos" type="text"
          value={rd('minProcessorVersions.ios', getNested(p, 'minProcessorVersions', 'ios')) ?? ''}
          placeholder="e.g. 14"
          oninput={(e) => patchField('minProcessorVersions.ios', (e.target as HTMLInputElement).value || null)} />
      </div>
      <div class="field">
        <label for="f_envvars">Include env vars <span class="label-optional">(comma-separated)</span></label>
        <input id="f_envvars" type="text"
          value={rd('includeEnvironmentVariables', Array.isArray(p.includeEnvironmentVariables) ? p.includeEnvironmentVariables.join(',') : '') ?? ''}
          oninput={(e) => patchField('includeEnvironmentVariables', (e.target as HTMLInputElement).value)} />
        <div class="hint">Variable names from .env passed to the deployment</div>
      </div>
      </Accordion.Content>
    </Accordion.Item>

    </Accordion.Root>

    <div class="save-bar">
      {#if hasErrors && dirty}
        <div class="save-error">Fix errors above before saving</div>
      {/if}
      <button disabled={!dirty || hasErrors} onclick={onSave}>Save Changes</button>
      <button class="secondary" disabled={!dirty} onclick={onDiscard}>Discard</button>
    </div>
  {/if}
{/if}

<style>
  /* Human-readable echo of a millisecond field — display only, value stays ms. */
  .dur-echo {
    color: var(--vscode-textLink-foreground);
    font-variant-numeric: tabular-nums;
  }
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
