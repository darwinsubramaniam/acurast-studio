<script lang="ts">
  import type { Route, PricingStateMsg, FiatListStateMsg, FiatSelectionStateMsg, WalletInfo, ProcessorsStateMsg, InstantMatchEntry } from '../../types';
  import { send } from '../lib/vscode';
  import { ICONS } from '../lib/icons';
  import Spinner from '../shared/Spinner.svelte';
  import FiatNote from '../shared/FiatNote.svelte';
  import FiatPricingSettings from './FiatPricingSettings.svelte';
  import ProcessorWhitelist from './ProcessorWhitelist.svelte';
  import InstantMatchProcessors from './InstantMatchProcessors.svelte';
  import { adviceVerdict, isNonPriceBlocker } from '../lib/pricing';
  import { planckToAcu, fmtDuration } from '../lib/format';
  import { getNested, instantMatchEntries, buildPatch, validateConfig } from '../lib/acurastConfig';

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

  let draft = $state<Record<string, unknown>>({});
  let dirty = $derived(Object.keys(draft).length > 0);
  let projectKey = $state<string | null>(null);

  // "Build" and "Advanced" are the only two sections that stay collapsed by
  // default — everything else in the redesign (Figma "Project Settings Panel
  // Flow" board, node 194:29) is always visible so the whole config reads at a
  // glance. Kept as plain booleans (no bits-ui Accordion) since there's only
  // ever one thing to show/hide per trigger.
  let buildOpen = $state(false);
  let advancedOpen = $state(false);

  // Transient "saved" confirmation — purely local UI state, no new host message.
  let justSaved = $state(false);
  let savedTimer: ReturnType<typeof setTimeout> | undefined;

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

  // Header status pill — one derivation drives the "Valid / Unsaved / N errors"
  // state shown across every core-state cell in the Figma board.
  let statusPill = $derived.by(() => {
    if (hasErrors && dirty) {
      const n = Object.keys(errors).length;
      return { tone: 'red', label: `${n} error${n === 1 ? '' : 's'}` };
    }
    if (dirty) return { tone: 'blue', label: `Unsaved · ${Object.keys(draft).length}` };
    return { tone: 'green', label: 'Valid' };
  });

  function onSave() {
    const key = activeKey();
    if (!key || !dirty || hasErrors) return;
    send('config.save', { projectKey: key, patch: buildPatch(draft, currentProject()) });
    // Optimistic clear — the host writes straight to disk (no onDidSaveTextDocument
    // round-trip refreshes `config.data`), so nothing else would reset the draft.
    draft = {};
    justSaved = true;
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => { justSaved = false; }, 3000);
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

  // Derive which of the three source "kinds" a fileUrl currently is — used only
  // to highlight the right segment; the raw field below stays the source of truth.
  function sourceKindOf(url: string): 'bundled' | 'ipfs' | 'https' {
    const u = (url ?? '').trim();
    if (/^ipfs:\/\//i.test(u)) return 'ipfs';
    if (/^https?:\/\//i.test(u)) return 'https';
    return 'bundled';
  }
  function pickSource(kind: 'bundled' | 'ipfs' | 'https', currentUrl: string) {
    if (kind === sourceKindOf(currentUrl)) return;
    if (kind === 'ipfs') patchField('fileUrl', 'ipfs://');
    else if (kind === 'https') patchField('fileUrl', 'https://');
    else patchField('fileUrl', '');
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
  <div class="dpl-empty">
    <div class="dpl-empty-icon">{@html ICONS.file}</div>
    <div class="dpl-empty-title">No active acurast.json</div>
    <div class="dpl-empty-sub">Choose an existing acurast.json in your workspace to edit its project settings.</div>
    <button class="primary-green dpl-cta" onclick={() => send('config.choose')}>Choose acurast.json…</button>
  </div>
{:else}
  {@const projs = projects()}
  {@const keys = Object.keys(projs)}
  {#if !keys.length}
    <div class="dpl-empty">
      <div class="dpl-empty-icon">{@html ICONS.file}</div>
      <div class="dpl-empty-title">No projects in acurast.json</div>
      <div class="dpl-empty-sub">The config file loaded, but its "projects" object is empty. Add a project entry to configure a deployment.</div>
      <button class="dpl-btn" onclick={() => send('config.openJson')}>Open acurast.json</button>
    </div>
  {:else}
    {@const key = activeKey()!}
    {@const p = projs[key]}
    {@const sym = ((rd('network', p.network) ?? 'mainnet') === 'mainnet') ? 'ACU' : 'cACU'}
    {@const runtime = (rd('runtime', p.runtime) ?? 'NodeJSWithBundle') as string}
    {@const execType = (rd('execution.type', getExec(p, 'type')) ?? 'onetime') as string}
    {@const assignType = (rd('assignmentStrategy.type', getNested(p, 'assignmentStrategy', 'type')) ?? 'Single') as string}
    {@const mutability = (rd('mutability', p.mutability) ?? 'Immutable') as string}
    {@const modules = (rd('requiredModules', p.requiredModules) ?? []) as string[]}
    {@const imEntries = (rd('assignmentStrategy.instantMatch', instantMatchEntries(p)) ?? []) as InstantMatchEntry[]}
    {@const fileUrl = String(rd('fileUrl', p.fileUrl) ?? '')}

    {#snippet durEcho(v: unknown)}
      {@const h = msHuman(v)}
      {#if h}<div class="pst-hint pst-echo">≈ {h}</div>{/if}
    {/snippet}

    {#snippet acuEcho(v: unknown)}
      {@const acu = satoshiToACU(String(v ?? ''))}
      {#if acu !== '—'}<div class="pst-hint pst-echo">≈ {acu} {sym}</div>{/if}
    {/snippet}

    {#snippet seg(options: Array<{ value: string; label: string }>, current: string, onPick: (v: string) => void)}
      <div class="pst-seg" role="radiogroup">
        {#each options as opt (opt.value)}
          <button type="button" class="pst-seg-btn" class:active={opt.value === current}
            role="radio" aria-checked={opt.value === current}
            onclick={() => onPick(opt.value)}>{opt.label}</button>
        {/each}
      </div>
    {/snippet}

    {#snippet check(id: string, label: string, checked: boolean, onToggle: (v: boolean) => void)}
      <label class="pst-check" for={id}>
        <input {id} type="checkbox" {checked} onchange={(e) => onToggle((e.target as HTMLInputElement).checked)} />
        <span>{label}</span>
      </label>
    {/snippet}

    <div class="pst">
      <div class="active-config" title={ctx.configPath ?? ''}>
        <span class="active-config-label">FILE</span>
        <code class="active-config-path">{ctx.configRel || 'acurast.json'}</code>
        <button class="icon-btn" onclick={() => send('config.openJson')} title="Open acurast.json in the editor">{@html ICONS.arrowUpRight}</button>
        <button class="active-config-switch" onclick={() => send('config.choose')} title="Switch acurast.json">Switch</button>
      </div>

      {#if keys.length > 1}
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="projectPicker">Project</label>
          <select id="projectPicker" class="pst-input" onchange={onProjectChange}>
            {#each keys as k}
              <option value={k} selected={k === key}>{k}</option>
            {/each}
          </select>
        </div>
      {/if}

      <div class="pst-head">
        <div class="pst-head-left">
          <span class="pst-head-icon">{@html ICONS.braces}</span>
          <span class="dpl-eyebrow">PROJECT SETTINGS</span>
        </div>
        <span class="dpl-pill {statusPill.tone}"><span class="dot"></span>{statusPill.label}</span>
      </div>

      {#if justSaved}
        <div class="pst-toast">{@html ICONS.check} Saved to acurast.json</div>
      {/if}

      <!-- Identity -->
      <div class="dpl-card">
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="f_projectName">Project Name</label>
          <input id="f_projectName" type="text" class="pst-input"
            value={rd('projectName', p.projectName) ?? ''}
            class:pst-input-error={'projectName' in errors}
            oninput={(e) => patchField('projectName', (e.target as HTMLInputElement).value)} />
          {#if errors.projectName}<div class="pst-err">{errors.projectName}</div>{/if}
        </div>

        <div class="pst-field">
          <span class="dpl-eyebrow pst-cap">Network</span>
          {@render seg(
            [{ value: 'mainnet', label: 'Mainnet' }, { value: 'canary', label: 'Canary' }],
            String(rd('network', p.network) ?? 'mainnet'),
            (v) => patchField('network', v),
          )}
        </div>

        <div class="pst-field">
          <span class="dpl-eyebrow pst-cap">Source</span>
          {@render seg(
            [{ value: 'bundled', label: 'Bundled file' }, { value: 'ipfs', label: 'IPFS' }, { value: 'https', label: 'HTTPS URL' }],
            sourceKindOf(fileUrl),
            (v) => pickSource(v as 'bundled' | 'ipfs' | 'https', fileUrl),
          )}
          <input id="f_fileUrl" type="text" class="pst-input pst-mono" style="margin-top:8px;"
            value={fileUrl}
            class:pst-input-error={'fileUrl' in errors}
            oninput={(e) => patchField('fileUrl', (e.target as HTMLInputElement).value)} />
          {#if errors.fileUrl}
            <div class="pst-err">{errors.fileUrl}</div>
          {:else}
            <div class="pst-hint">Bundled file path, IPFS hash, or HTTPS URL</div>
          {/if}
        </div>
      </div>

      <!-- Runtime -->
      <div class="dpl-card">
        <div class="pst-field">
          <span class="dpl-eyebrow pst-cap">Runtime</span>
          {@render seg(
            [{ value: 'NodeJSWithBundle', label: 'Node.js (bundle)' }, { value: 'NodeJS', label: 'Node.js' }, { value: 'Shell', label: 'Shell' }],
            runtime,
            (v) => patchField('runtime', v),
          )}
        </div>
        {#if runtime === 'Shell'}
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_entrypoint">Entrypoint</label>
            <input id="f_entrypoint" type="text" class="pst-input pst-mono"
              value={rd('entrypoint', p.entrypoint) ?? ''}
              placeholder="acurast.sh"
              oninput={(e) => patchField('entrypoint', (e.target as HTMLInputElement).value)} />
            <div class="pst-hint">Script or binary the processor runs inside the image</div>
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_imageUrl">Image URL</label>
            <input id="f_imageUrl" type="text" class="pst-input pst-mono"
              value={rd('image.url', getNested(p, 'image', 'url')) ?? ''}
              class:pst-input-error={'image.url' in errors}
              placeholder="https://github.com/termux/proot-distro/releases/..."
              oninput={(e) => patchField('image.url', (e.target as HTMLInputElement).value)} />
            {#if errors['image.url']}
              <div class="pst-err">{errors['image.url']}</div>
            {:else}
              <div class="pst-hint">HTTPS URL to .tar.xz distro image</div>
            {/if}
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_imageSha">Image SHA256</label>
            <input id="f_imageSha" type="text" class="pst-input pst-mono"
              value={rd('image.sha256', getNested(p, 'image', 'sha256')) ?? ''}
              class:pst-input-error={'image.sha256' in errors}
              placeholder="64-character hex"
              oninput={(e) => patchField('image.sha256', (e.target as HTMLInputElement).value)} />
            {#if errors['image.sha256']}
              <div class="pst-err">{errors['image.sha256']}</div>
            {:else}
              <div class="pst-hint">SHA256 of the image for verification</div>
            {/if}
          </div>
          <div class="pst-field">
            <span class="dpl-eyebrow pst-cap">Restart Policy</span>
            {@render seg(
              [{ value: 'no', label: 'No' }, { value: 'always', label: 'Always' }, { value: 'on-failure', label: 'On failure' }],
              String(rd('restartPolicy', p.restartPolicy) ?? 'no'),
              (v) => patchField('restartPolicy', v),
            )}
          </div>
        {/if}
        <div class="pst-checks">
          {@render check('f_onlyAttested', 'Only attested devices', !!(rd('onlyAttestedDevices', p.onlyAttestedDevices)), (v) => patchField('onlyAttestedDevices', v))}
          {@render check('f_devtools', 'Enable DevTools', !!(rd('enableDevtools', p.enableDevtools)), (v) => patchField('enableDevtools', v))}
        </div>
      </div>

      <!-- Assignment Strategy -->
      <div class="dpl-card">
        <div class="pst-field">
          <span class="dpl-eyebrow pst-cap">Assignment Strategy</span>
          {@render seg(
            [{ value: 'Single', label: 'Single' }, { value: 'Competing', label: 'Competing' }],
            assignType,
            (v) => patchField('assignmentStrategy.type', v),
          )}
          <div class="pst-hint">{assignType === 'Single' ? 'One set of processors for all executions' : 'New processors assigned per execution'}</div>
        </div>
        {#if assignType === 'Single'}
          <InstantMatchProcessors
            value={imEntries}
            onChange={(v) => patchField('assignmentStrategy.instantMatch', v)}
            {activeWallet}
            {processorsState}
            network={projectNetwork()}
          />
        {/if}
      </div>

      <!-- Execution -->
      <div class="dpl-card">
        <div class="pst-field">
          <span class="dpl-eyebrow pst-cap">Execution</span>
          {@render seg(
            [{ value: 'onetime', label: 'One-time' }, { value: 'interval', label: 'Interval' }],
            execType,
            (v) => patchField('execution.type', v),
          )}
        </div>
        {#if execType === 'interval'}
          <!-- Interval + count belong together: they only exist for the interval
               schedule and are meaningless apart, so they get their own bordered
               sub-group rather than sitting loose among the other fields. -->
          <div class="pst-group" role="group" aria-labelledby="grp-schedule">
            <div id="grp-schedule" class="pst-group-head">Interval Schedule</div>
            <div class="pst-row2">
              <div class="pst-field">
                <label class="dpl-eyebrow pst-cap" for="f_intervalMs">Interval (ms)</label>
                <input id="f_intervalMs" type="number" class="pst-input"
                  value={rd('execution.intervalInMs', getExec(p, 'intervalInMs')) ?? ''}
                  class:pst-input-error={'execution.intervalInMs' in errors}
                  oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.intervalInMs', isNaN(n) ? null : n); }} />
                {#if errors['execution.intervalInMs']}
                  <div class="pst-err">{errors['execution.intervalInMs']}</div>
                {:else}
                  <div class="pst-hint">Time between each execution start</div>
                {/if}
                {@render durEcho(rd('execution.intervalInMs', getExec(p, 'intervalInMs')))}
              </div>
              <div class="pst-field">
                <label class="dpl-eyebrow pst-cap" for="f_numExec">Number of Executions</label>
                <input id="f_numExec" type="number" class="pst-input"
                  value={rd('execution.numberOfExecutions', getExec(p, 'numberOfExecutions')) ?? ''}
                  class:pst-input-error={'execution.numberOfExecutions' in errors}
                  oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.numberOfExecutions', isNaN(n) ? null : n); }} />
                {#if errors['execution.numberOfExecutions']}
                  <div class="pst-err">{errors['execution.numberOfExecutions']}</div>
                {:else}
                  <div class="pst-hint">How many times it runs in total</div>
                {/if}
              </div>
            </div>
          </div>
        {/if}
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="f_execTime">Max execution time (ms)</label>
          <input id="f_execTime" type="number" class="pst-input"
            value={rd('execution.maxExecutionTimeInMs', getExec(p, 'maxExecutionTimeInMs')) ?? 10000}
            oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.maxExecutionTimeInMs', isNaN(n) ? null : n); }} />
          {#if execType === 'interval'}
            <div class="pst-hint">Recommend at least 10 000 ms less than interval</div>
          {/if}
          {@render durEcho(rd('execution.maxExecutionTimeInMs', getExec(p, 'maxExecutionTimeInMs')) ?? 10000)}
        </div>
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="f_startDelay">Max start delay (ms)</label>
          <input id="f_startDelay" type="number" class="pst-input"
            value={rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000}
            oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
          {@render durEcho(rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000)}
        </div>
      </div>

      <!-- Scaling & Cost -->
      <div class="dpl-card">
        <div class="pst-row2">
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_replicas">Replicas</label>
            <input id="f_replicas" type="number" class="pst-input"
              value={rd('numberOfReplicas', p.numberOfReplicas) ?? 1}
              oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('numberOfReplicas', isNaN(n) ? null : n); }} />
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_reputation">Min processor reputation</label>
            <input id="f_reputation" type="number" class="pst-input"
              value={rd('minProcessorReputation', p.minProcessorReputation) ?? 0}
              oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('minProcessorReputation', isNaN(n) ? null : n); }} />
          </div>
        </div>
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="f_maxCost">Max cost per execution</label>
          <input id="f_maxCost" type="number" class="pst-input pst-cost-input"
            value={rd('maxCostPerExecution', p.maxCostPerExecution) ?? 0}
            oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxCostPerExecution', isNaN(n) ? null : n); }} />
          <div class="pst-hint">Planck units (1 {sym} = 1e12 planck)</div>
          {@render acuEcho(rd('maxCostPerExecution', p.maxCostPerExecution) ?? 0)}
        </div>

        <!-- All three fields write to usageLimit.* — group them so the pair and
             the storage field below it stay one unit once the columns stack. -->
        <div class="pst-group" role="group" aria-labelledby="grp-usage">
          <div id="grp-usage" class="pst-group-head">Usage Limits</div>
          <div class="pst-row2">
            <div class="pst-field">
              <label class="dpl-eyebrow pst-cap" for="f_maxMem">Max memory (bytes)</label>
              <input id="f_maxMem" type="number" class="pst-input"
                value={rd('usageLimit.maxMemory', getNested(p, 'usageLimit', 'maxMemory')) ?? 0}
                oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxMemory', isNaN(n) ? null : n); }} />
              <div class="pst-hint">0 = unlimited</div>
            </div>
            <div class="pst-field">
              <label class="dpl-eyebrow pst-cap" for="f_maxNet">Max network requests</label>
              <input id="f_maxNet" type="number" class="pst-input"
                value={rd('usageLimit.maxNetworkRequests', getNested(p, 'usageLimit', 'maxNetworkRequests')) ?? 0}
                oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxNetworkRequests', isNaN(n) ? null : n); }} />
              <div class="pst-hint">0 = unlimited</div>
            </div>
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_maxStorage">Max storage (bytes)</label>
            <input id="f_maxStorage" type="number" class="pst-input"
              value={rd('usageLimit.maxStorage', getNested(p, 'usageLimit', 'maxStorage')) ?? 0}
              oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('usageLimit.maxStorage', isNaN(n) ? null : n); }} />
            <div class="pst-hint">0 = unlimited</div>
          </div>
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
      </div>

      <!-- Environment -->
      <div class="dpl-card">
        <div class="pst-field">
          <label class="dpl-eyebrow pst-cap" for="f_envvars">Include env vars <span class="label-optional">(comma-separated)</span></label>
          <input id="f_envvars" type="text" class="pst-input pst-mono"
            value={rd('includeEnvironmentVariables', Array.isArray(p.includeEnvironmentVariables) ? p.includeEnvironmentVariables.join(',') : '') ?? ''}
            oninput={(e) => patchField('includeEnvironmentVariables', (e.target as HTMLInputElement).value)} />
          <div class="pst-hint">Variable names from .env passed to the deployment</div>
        </div>
      </div>

      <!-- Build (collapsed) -->
      <button type="button" class="pst-disclosure" class:open={buildOpen} onclick={() => (buildOpen = !buildOpen)}>
        <div class="pst-disc-main">
          <span class="pst-disc-title">Build</span>
          <span class="pst-disc-sub">Optional command that runs before deploy</span>
        </div>
        <span class="pst-disc-chev">{@html ICONS.chev}</span>
      </button>
      {#if buildOpen}
        <div class="dpl-card">
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_buildCommand">Build command <span class="label-optional">(optional)</span></label>
            <input id="f_buildCommand" type="text" class="pst-input pst-mono"
              value={rd('build.command', getNested(p, 'build', 'command')) ?? ''}
              placeholder="e.g. npm run build · cargo build --release"
              oninput={(e) => patchField('build.command', (e.target as HTMLInputElement).value)} />
            <div class="pst-hint">Runs before deploy (and via the Build action) to produce the artifact. Any toolchain — trusted workspace only.</div>
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_buildCwd">Working directory <span class="label-optional">(optional)</span></label>
            <input id="f_buildCwd" type="text" class="pst-input pst-mono"
              value={rd('build.cwd', getNested(p, 'build', 'cwd')) ?? ''}
              placeholder="(project root)"
              oninput={(e) => patchField('build.cwd', (e.target as HTMLInputElement).value)} />
            <div class="pst-hint">Where the command runs, relative to the project root.</div>
          </div>
          <div class="pst-field">
            <label class="dpl-eyebrow pst-cap" for="f_buildOutput">Output artifact <span class="label-optional">(optional)</span></label>
            <input id="f_buildOutput" type="text" class="pst-input pst-mono"
              value={rd('build.output', getNested(p, 'build', 'output')) ?? ''}
              placeholder="e.g. dist/index.js"
              oninput={(e) => patchField('build.output', (e.target as HTMLInputElement).value)} />
            <div class="pst-hint">Artifact to deploy; overrides File URL. Verified to exist after the build. Relative to the project root.</div>
          </div>
        </div>
      {/if}

      <!-- Advanced (collapsed) -->
      <button type="button" class="pst-disclosure" class:open={advancedOpen} onclick={() => (advancedOpen = !advancedOpen)}>
        <div class="pst-disc-main">
          <span class="pst-disc-title">Advanced</span>
          <span class="pst-disc-sub">Mutability · key types · fiat provider</span>
        </div>
        <span class="pst-disc-chev">{@html ICONS.chev}</span>
      </button>
      {#if advancedOpen}
        <div class="dpl-card">
          <div class="pst-field">
            <span class="dpl-eyebrow pst-cap">Mutability</span>
            {@render seg(
              [{ value: 'Immutable', label: 'Immutable' }, { value: 'Mutable', label: 'Mutable' }],
              mutability,
              (v) => patchField('mutability', v),
            )}
            <div class="pst-hint" class:pst-warn-text={mutability === 'Mutable'}>
              {mutability === 'Mutable' ? '⚠ Can be modified after creation — use with care' : 'Cannot be modified after creation (recommended)'}
            </div>
          </div>
          {#if mutability === 'Mutable'}
            <div class="pst-field">
              <label class="dpl-eyebrow pst-cap" for="f_reuseKeys">Reuse Keys From <span class="label-optional">(optional)</span></label>
              <input id="f_reuseKeys" type="text" class="pst-input pst-mono"
                value={rd('reuseKeysFrom', reuseKeysFromText(p)) ?? ''}
                class:pst-input-error={'reuseKeysFrom' in errors}
                placeholder='["Acurast", "5CiP…", 123456]'
                oninput={(e) => patchField('reuseKeysFrom', (e.target as HTMLInputElement).value)} />
              {#if errors.reuseKeysFrom}
                <div class="pst-err">{errors.reuseKeysFrom}</div>
              {:else}
                <div class="pst-hint">Reuse encryption keys from a previous Mutable deployment</div>
              {/if}
            </div>
          {/if}
          <div class="pst-field" role="group" aria-labelledby="mod-group-label">
            <div id="mod-group-label" class="dpl-eyebrow pst-cap">Required Modules</div>
            <div class="pst-checks">
              {#each ['DataEncryption', 'LLM'] as mod}
                {@render check(`mod_${mod}`, mod, modules.includes(mod), (checked) => {
                  const current = (rd('requiredModules', p.requiredModules) ?? []) as string[];
                  patchField('requiredModules', checked ? [...current, mod] : current.filter(m => m !== mod));
                })}
              {/each}
            </div>
            {#if runtime === 'Shell'}
              <div class="pst-hint">Shell module auto-injected for Shell runtime</div>
            {/if}
          </div>
          <ProcessorWhitelist
            value={String(rd('processorWhitelist', whitelistText(p)) ?? '')}
            onChange={(v) => patchField('processorWhitelist', v)}
            {activeWallet}
            {processorsState}
            network={projectNetwork()}
          />
          <div class="pst-row2">
            <div class="pst-field">
              <label class="dpl-eyebrow pst-cap" for="f_minAndroid">Min Android version <span class="label-optional">(optional)</span></label>
              <input id="f_minAndroid" type="text" class="pst-input"
                value={rd('minProcessorVersions.android', getNested(p, 'minProcessorVersions', 'android')) ?? ''}
                placeholder="e.g. 9"
                oninput={(e) => patchField('minProcessorVersions.android', (e.target as HTMLInputElement).value || null)} />
            </div>
            <div class="pst-field">
              <label class="dpl-eyebrow pst-cap" for="f_minIos">Min iOS version <span class="label-optional">(optional)</span></label>
              <input id="f_minIos" type="text" class="pst-input"
                value={rd('minProcessorVersions.ios', getNested(p, 'minProcessorVersions', 'ios')) ?? ''}
                placeholder="e.g. 14"
                oninput={(e) => patchField('minProcessorVersions.ios', (e.target as HTMLInputElement).value || null)} />
            </div>
          </div>
          <div class="pst-divider"></div>
          <div class="dpl-eyebrow pst-subhead">Fiat pricing source</div>
          <FiatPricingSettings {fiatList} {fiatSelection} />
        </div>
      {/if}

      <div class="save-bar">
        {#if hasErrors && dirty}
          <div class="save-error">Fix the errors above before saving</div>
        {/if}
        <button class="primary-green" disabled={!dirty || hasErrors} onclick={onSave}>Save Changes</button>
        {#if dirty}<button class="secondary" onclick={onDiscard}>Discard</button>{/if}
      </div>
    </div>
  {/if}
{/if}

<style>
  /* Human-readable echo of a millisecond/planck field — display only, the
     stored value stays in its raw unit. */
  .pst-echo {
    color: var(--vscode-textLink-foreground);
    font-variant-numeric: tabular-nums;
  }
</style>
