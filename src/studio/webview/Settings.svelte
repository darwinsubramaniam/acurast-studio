<script lang="ts">
  import type { Route, PricingStateMsg, SerializedAdvice } from '../types';
  import { send } from './lib/vscode';

  interface Props {
    ctx: { configPath: string | null; configRel: string | null };
    config: { data: unknown; projectKey: string | null };
    navigate: (r: Route) => void;
    pricing: PricingStateMsg | null;
  }
  let { ctx, config, pricing }: Props = $props();

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

  function getNested(p: Record<string, unknown>, ...keys: string[]): unknown {
    let cur: unknown = p;
    for (const k of keys) {
      if (!cur || typeof cur !== 'object') return undefined;
      cur = (cur as Record<string, unknown>)[k];
    }
    return cur;
  }

  function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
    const result = { ...target };
    for (const [k, v] of Object.entries(source)) {
      if (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) &&
          result[k] !== null && result[k] !== undefined && typeof result[k] === 'object' && !Array.isArray(result[k])) {
        result[k] = deepMerge(result[k] as Record<string, unknown>, v as Record<string, unknown>);
      } else {
        result[k] = v;
      }
    }
    return result;
  }

  function buildPatch(): Record<string, unknown> {
    const p = currentProject() ?? {};
    const patch: Record<string, unknown> = {};

    for (const [k, v] of Object.entries(draft)) {
      if (k === 'includeEnvironmentVariables' && typeof v === 'string') {
        patch[k] = v.split(',').map((s: string) => s.trim()).filter(Boolean);
        continue;
      }
      if (k === 'processorWhitelist' && typeof v === 'string') {
        patch[k] = v.split('\n').map((s: string) => s.trim()).filter(Boolean);
        continue;
      }
      if (k === 'reuseKeysFrom') {
        const raw = String(v ?? '').trim();
        if (!raw || raw === 'null') { patch[k] = null; }
        else { try { patch[k] = JSON.parse(raw); } catch { /* skip invalid */ } }
        continue;
      }
      if (k.includes('.')) {
        const parts = k.split('.');
        let node = patch;
        for (let i = 0; i < parts.length - 1; i++) {
          if (!(parts[i] in node) || typeof node[parts[i]] !== 'object' || Array.isArray(node[parts[i]])) {
            node[parts[i]] = {};
          }
          node = node[parts[i]] as Record<string, unknown>;
        }
        node[parts[parts.length - 1]] = v;
      } else {
        patch[k] = v;
      }
    }

    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      const orig = p[k];
      if (pv && typeof pv === 'object' && !Array.isArray(pv) &&
          orig && typeof orig === 'object' && !Array.isArray(orig)) {
        patch[k] = deepMerge(orig as Record<string, unknown>, pv as Record<string, unknown>);
      }
    }

    // Clean up assignmentStrategy
    if (patch.assignmentStrategy && typeof patch.assignmentStrategy === 'object') {
      const as = patch.assignmentStrategy as Record<string, unknown>;
      if (as.type === 'Competing') {
        delete as.instantMatch;
      } else if (as.instantMatch && typeof as.instantMatch === 'object') {
        const im = as.instantMatch as Record<string, unknown>;
        if (!im.processor || String(im.processor).trim() === '') delete as.instantMatch;
      }
    }

    // Clean up empty minProcessorVersions
    if (patch.minProcessorVersions && typeof patch.minProcessorVersions === 'object') {
      const mv = patch.minProcessorVersions as Record<string, unknown>;
      const hasAny = Object.values(mv).some(v => v !== null && v !== undefined && String(v).trim() !== '');
      if (!hasAny) patch.minProcessorVersions = null;
    }

    return patch;
  }

  const errors = $derived.by(() => {
    const p = currentProject();
    if (!p) return {} as Record<string, string>;
    const errs: Record<string, string> = {};

    const name = rd('projectName', p.projectName);
    if (!name || String(name).trim() === '') errs.projectName = 'Required';

    const fUrl = rd('fileUrl', p.fileUrl);
    if (!fUrl || String(fUrl).trim() === '') errs.fileUrl = 'Required';

    const runtime = (rd('runtime', p.runtime) ?? 'NodeJSWithBundle') as string;
    if (runtime === 'Shell') {
      const imgUrl = rd('image.url', getNested(p, 'image', 'url'));
      if (!imgUrl || String(imgUrl).trim() === '') errs['image.url'] = 'Required for Shell runtime';
      const imgSha = rd('image.sha256', getNested(p, 'image', 'sha256'));
      if (!imgSha || String(imgSha).trim() === '') {
        errs['image.sha256'] = 'Required for Shell runtime';
      } else if (!/^[a-fA-F0-9]{64}$/.test(String(imgSha))) {
        errs['image.sha256'] = 'Must be 64-character hex string';
      }
    }

    const execType = (rd('execution.type', getNested(p, 'execution', 'type')) ?? 'onetime') as string;
    if (execType === 'interval') {
      const iv = rd('execution.intervalInMs', getNested(p, 'execution', 'intervalInMs'));
      if (!iv || Number(iv) <= 0) errs['execution.intervalInMs'] = 'Required, must be > 0';
      const ne = rd('execution.numberOfExecutions', getNested(p, 'execution', 'numberOfExecutions'));
      if (!ne || Number(ne) <= 0 || !Number.isInteger(Number(ne))) errs['execution.numberOfExecutions'] = 'Required, positive integer';
    }

    const reuseVal = draft.reuseKeysFrom;
    if (reuseVal !== undefined && reuseVal !== null) {
      const raw = String(reuseVal).trim();
      if (raw && raw !== 'null') {
        try {
          const parsed = JSON.parse(raw);
          if (!Array.isArray(parsed) || parsed.length !== 3 ||
              parsed[0] !== 'Acurast' || typeof parsed[1] !== 'string' || typeof parsed[2] !== 'number') {
            errs.reuseKeysFrom = 'Must be ["Acurast", "address", deploymentId]';
          }
        } catch {
          errs.reuseKeysFrom = 'Invalid JSON';
        }
      }
    }

    return errs;
  });

  const hasErrors = $derived(Object.keys(errors).length > 0);

  function onSave() {
    const key = activeKey();
    if (!key || !dirty || hasErrors) return;
    send('config.save', { projectKey: key, patch: buildPatch() });
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

  function satoshiToACU(satoshi: string | null | undefined): string {
    if (!satoshi) return '—';
    const n = parseFloat(satoshi) / 1e12;
    return n.toFixed(6).replace(/\.?0+$/, '') || '0';
  }

  function adviceIcon(status: SerializedAdvice['status']): string {
    return status === 'sufficient' ? '✓' : status === 'overpaying' ? '⚠' : '✗';
  }

  function adviceLabel(status: SerializedAdvice['status']): string {
    return status === 'sufficient' ? 'Sufficient' : status === 'overpaying' ? 'Overpaying' : 'Insufficient';
  }

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
    {@const imProcessor = rd('assignmentStrategy.instantMatch.processor', getNested(p, 'assignmentStrategy', 'instantMatch', 'processor')) as string | null | undefined}

    <div class="active-config" title={ctx.configPath ?? ''}>
      <span class="active-config-label">FILE</span>
      <code class="active-config-path">{ctx.configRel || 'acurast.json'}</code>
      <button class="active-config-switch" onclick={() => send('config.choose')} title="Switch acurast.json">Switch</button>
    </div>

    <div class="toolbar">
      <button class="secondary" onclick={() => send('config.openJson')}>Open acurast.json</button>
    </div>

    <div class="field">
      <label for="projectPicker">Project</label>
      <select id="projectPicker" onchange={onProjectChange}>
        {#each keys as k}
          <option value={k} selected={k === key}>{k}</option>
        {/each}
      </select>
    </div>

    <!-- Identity -->
    <div class="section">
      <div class="section-title" class:dirty>Identity</div>
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
    </div>

    <!-- Runtime -->
    <div class="section">
      <div class="section-title" class:dirty>Runtime</div>
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
    </div>

    <!-- Execution -->
    <div class="section">
      <div class="section-title" class:dirty>Execution</div>
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
              value={rd('assignmentStrategy.instantMatch.maxAllowedStartDelayInMs', getNested(p, 'assignmentStrategy', 'instantMatch', 'maxAllowedStartDelayInMs')) ?? 10000}
              oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('assignmentStrategy.instantMatch.maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
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
      </div>
      <div class="field">
        <label for="f_startDelay">Max start delay (ms)</label>
        <input id="f_startDelay" type="number"
          value={rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000}
          oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
      </div>
    </div>

    <!-- Scaling & Cost -->
    <div class="section">
      <div class="section-title" class:dirty>Scaling &amp; Cost</div>
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
          <div class="pricing-muted">Fetching live market data…</div>
        {:else if pricing?.status === 'error'}
          <div class="pricing-error-note">{pricing.error}</div>
        {:else if pricing?.status === 'ok' && pricing.fees}
          {@const fees = pricing.fees}
          {@const advice = pricing.advice}

          {#if advice}
            <div class="pricing-status-row pricing-{advice.status}">
              <span>{adviceIcon(advice.status)} {adviceLabel(advice.status)}</span>
              <span class="pricing-match">{advice.matchedProcessors} / {advice.requiredProcessors} processors</span>
            </div>

            <div class="pricing-rows">
              <span class="pricing-label">Your price</span>
              <span class="pricing-value">{satoshiToACU(advice.currentPrice)} {sym}/exec</span>
              {#if advice.averagePrice}
                <span class="pricing-label">Market avg</span>
                <span class="pricing-value">{satoshiToACU(advice.averagePrice)} {sym}/exec</span>
              {/if}
              {#if advice.suggestedPrice}
                <span class="pricing-label">Suggested</span>
                <span class="pricing-value">{satoshiToACU(advice.suggestedPrice)} {sym}/exec</span>
              {/if}
              <span class="pricing-label">Total cost</span>
              <span class="pricing-value">{fees.maxTotalCostCACU} {sym}</span>
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

            {#if advice.status !== 'sufficient' && advice.suggestedPrice}
              <button class="secondary" style="margin-top:6px;font-size:11px;" onclick={() => applySuggestedPrice(advice!.suggestedPrice)}>
                Apply suggested price ({satoshiToACU(advice.suggestedPrice)} {sym})
              </button>
            {/if}

          {:else}
            {#if pricing.fallbackReason}
              <div class="pricing-muted">
                {pricing.fallbackReason === 'no-wallet' ? 'Set an active wallet to get live market pricing.' :
                 pricing.fallbackReason === 'instant-match' ? 'Instant-match job — static estimate only.' :
                 'Live pricing unavailable — static estimate.'}
              </div>
            {/if}
            <div class="pricing-rows">
              <span class="pricing-label">Suggested</span>
              <span class="pricing-value">{fees.suggestedCostPerExecutionCACU} {sym}/exec</span>
              <span class="pricing-label">Your max</span>
              <span class="pricing-value">{fees.maxCostPerExecutionCACU} {sym}/exec</span>
              <span class="pricing-label">Total</span>
              <span class="pricing-value">{fees.maxTotalCostCACU} {sym}</span>
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

    <!-- Advanced -->
    <div class="section">
      <div class="section-title" class:dirty>Advanced</div>
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
        <textarea id="f_whitelist" rows="3"
          value={rd('processorWhitelist', Array.isArray(p.processorWhitelist) ? (p.processorWhitelist as string[]).join('\n') : '') ?? ''}
          placeholder="One address per line — leave blank to allow any processor"
          oninput={(e) => patchField('processorWhitelist', (e.target as HTMLTextAreaElement).value)}></textarea>
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
    </div>

    <div class="save-bar">
      {#if hasErrors && dirty}
        <div class="save-error">Fix errors above before saving</div>
      {/if}
      <button disabled={!dirty || hasErrors} onclick={onSave}>Save Changes</button>
      <button class="secondary" disabled={!dirty} onclick={onDiscard}>Discard</button>
    </div>
  {/if}
{/if}
