<script lang="ts">
  import type { Route } from '../types';
  import { send } from './lib/vscode';

  interface Props {
    ctx: { configPath: string | null; configRel: string | null };
    config: { data: unknown; projectKey: string | null };
    navigate: (r: Route) => void;
  }
  let { ctx, config }: Props = $props();

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

  function buildPatch(): Record<string, unknown> {
    const p = currentProject() ?? {};
    const patch: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(draft)) {
      if (k === 'includeEnvironmentVariables' && typeof v === 'string') {
        patch[k] = v.split(',').map(s => s.trim()).filter(Boolean);
        continue;
      }
      if (k.includes('.')) {
        const [head, tail] = k.split('.');
        if (!patch[head]) patch[head] = {};
        (patch[head] as Record<string, unknown>)[tail] = v;
      } else {
        patch[k] = v;
      }
    }
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      const orig = p[k];
      if (pv && typeof pv === 'object' && !Array.isArray(pv) && orig && typeof orig === 'object' && !Array.isArray(orig)) {
        patch[k] = Object.assign({}, orig as Record<string, unknown>, pv as Record<string, unknown>);
      }
    }
    return patch;
  }

  function onSave() {
    const key = activeKey();
    if (!key || !dirty) return;
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
    const exec = p.execution as Record<string, unknown> | undefined;
    return exec?.[subKey];
  }
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

    <div class="section">
      <div class="section-title" class:dirty>Identity</div>
      <div class="field">
        <label for="f_projectName">Project Name</label>
        <input id="f_projectName" type="text" value={rd('projectName', p.projectName) ?? ''} oninput={(e) => patchField('projectName', (e.target as HTMLInputElement).value)} />
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
        <input id="f_fileUrl" type="text" value={rd('fileUrl', p.fileUrl) ?? ''} oninput={(e) => patchField('fileUrl', (e.target as HTMLInputElement).value)} />
        <div class="hint">Path to the bundled file (e.g. dist/bundle.js)</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title" class:dirty>Runtime</div>
      <div class="field">
        <label for="f_runtime">Runtime</label>
        <select id="f_runtime" onchange={(e) => patchField('runtime', (e.target as HTMLSelectElement).value)}>
          {#each ['NodeJSWithBundle', 'NodeJS', 'Shell'] as opt}
            <option value={opt} selected={opt === (rd('runtime', p.runtime) ?? 'NodeJSWithBundle')}>{opt}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <div class="checkbox-field">
          <input id="f_onlyAttested" type="checkbox" checked={!!(rd('onlyAttestedDevices', p.onlyAttestedDevices))} onchange={(e) => patchField('onlyAttestedDevices', (e.target as HTMLInputElement).checked)} />
          <label for="f_onlyAttested" style="margin:0;text-transform:none;letter-spacing:0;">Only attested devices</label>
        </div>
      </div>
      <div class="field">
        <div class="checkbox-field">
          <input id="f_devtools" type="checkbox" checked={!!(rd('enableDevtools', p.enableDevtools))} onchange={(e) => patchField('enableDevtools', (e.target as HTMLInputElement).checked)} />
          <label for="f_devtools" style="margin:0;text-transform:none;letter-spacing:0;">Enable DevTools</label>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-title" class:dirty>Execution</div>
      <div class="field">
        <label for="f_execType">Type</label>
        <select id="f_execType" onchange={(e) => patchField('execution.type', (e.target as HTMLSelectElement).value)}>
          {#each ['onetime', 'interval'] as opt}
            <option value={opt} selected={opt === (rd('execution.type', getExec(p, 'type')) ?? 'onetime')}>{opt}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="f_execTime">Max execution time (ms)</label>
        <input id="f_execTime" type="number" value={rd('execution.maxExecutionTimeInMs', getExec(p, 'maxExecutionTimeInMs')) ?? 10000} oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('execution.maxExecutionTimeInMs', isNaN(n) ? null : n); }} />
      </div>
      <div class="field">
        <label for="f_startDelay">Max start delay (ms)</label>
        <input id="f_startDelay" type="number" value={rd('maxAllowedStartDelayInMs', p.maxAllowedStartDelayInMs) ?? 10000} oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxAllowedStartDelayInMs', isNaN(n) ? null : n); }} />
      </div>
    </div>

    <div class="section">
      <div class="section-title" class:dirty>Scaling &amp; Cost</div>
      <div class="field">
        <label for="f_replicas">Replicas</label>
        <input id="f_replicas" type="number" value={rd('numberOfReplicas', p.numberOfReplicas) ?? 1} oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('numberOfReplicas', isNaN(n) ? null : n); }} />
      </div>
      <div class="field">
        <label for="f_maxCost">Max cost per execution</label>
        <input id="f_maxCost" type="number" value={rd('maxCostPerExecution', p.maxCostPerExecution) ?? 0} oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('maxCostPerExecution', isNaN(n) ? null : n); }} />
        <div class="hint">Planck units of ACU/cACU (1 ACU = 1e12 planck)</div>
      </div>
      <div class="field">
        <label for="f_reputation">Min processor reputation</label>
        <input id="f_reputation" type="number" value={rd('minProcessorReputation', p.minProcessorReputation) ?? 0} oninput={(e) => { const n = Number((e.target as HTMLInputElement).value); patchField('minProcessorReputation', isNaN(n) ? null : n); }} />
      </div>
    </div>

    <div class="section">
      <div class="section-title" class:dirty>Advanced</div>
      <div class="field">
        <label for="f_mutability">Mutability</label>
        <select id="f_mutability" onchange={(e) => patchField('mutability', (e.target as HTMLSelectElement).value)}>
          {#each ['Immutable', 'Mutable'] as opt}
            <option value={opt} selected={opt === (rd('mutability', p.mutability) ?? 'Immutable')}>{opt}</option>
          {/each}
        </select>
      </div>
      <div class="field">
        <label for="f_envvars">Include env vars (comma-separated)</label>
        <input id="f_envvars" type="text"
          value={rd('includeEnvironmentVariables', Array.isArray(p.includeEnvironmentVariables) ? p.includeEnvironmentVariables.join(',') : '') ?? ''}
          oninput={(e) => patchField('includeEnvironmentVariables', (e.target as HTMLInputElement).value)} />
        <div class="hint">Reads from .env at deploy time</div>
      </div>
    </div>

    <div class="save-bar">
      <button disabled={!dirty} onclick={onSave}>Save Changes</button>
      <button class="secondary" disabled={!dirty} onclick={onDiscard}>Discard</button>
    </div>
  {/if}
{/if}
