<script lang="ts">
  import type { MonitoringStateMsg, StoredDeployment } from "../types";
  import { send } from "./lib/vscode";
  import { ICONS } from "./lib/icons";
  import { fmtTimestamp } from "./lib/format";

  interface Props {
    monitoringState: MonitoringStateMsg | null;
  }
  let { monitoringState }: Props = $props();

  // ── Filter controls (apply to whichever job the user opens) ──
  const RANGES: { label: string; ms: number }[] = [
    { label: "Last 5 minutes", ms: 5 * 60_000 },
    { label: "Last 15 minutes", ms: 15 * 60_000 },
    { label: "Last 1 hour", ms: 60 * 60_000 },
    { label: "Last 3 hours", ms: 3 * 60 * 60_000 },
    { label: "Last 6 hours", ms: 6 * 60 * 60_000 },
    { label: "Last 12 hours", ms: 12 * 60 * 60_000 },
    { label: "Last 24 hours", ms: 24 * 60 * 60_000 },
    { label: "Last 7 days", ms: 7 * 24 * 60 * 60_000 },
  ];
  const LIMITS = [100, 500, 1000, 5000];

  let rangeMs = $state(60 * 60_000);
  let limit = $state(1000);
  let search = $state("");

  // Manual scope for jobs not in local history.
  let manualId = $state("");
  let manualNetwork = $state<string>("");

  let configured = $derived(monitoringState?.configured ?? false);
  let jobLabel = $derived(monitoringState?.jobLabel ?? "job_id");
  let targetNetwork = $derived(monitoringState?.targetNetwork ?? "mainnet");
  let deployments = $derived<StoredDeployment[]>(monitoringState?.deployments ?? []);

  $effect(() => {
    if (!manualNetwork && targetNetwork) manualNetwork = targetNetwork;
  });

  // Live LogQL preview — mirrors what the host will run.
  let previewQuery = $derived.by(() => {
    const base = "{" + jobLabel + '="<job>"}';
    return search.trim() ? `${base} |= "${search.trim()}"` : base;
  });

  function viewJob(
    network: string,
    localId: number,
    origin: string | undefined,
    title: string,
  ) {
    send("monitoring.open", {
      network,
      localId,
      origin,
      title,
      rangeMs,
      limit,
      search: search.trim() || undefined,
    });
  }

  function viewManual() {
    const id = Number(manualId.trim());
    if (!Number.isFinite(id)) return;
    viewJob(manualNetwork || targetNetwork, id, undefined, `Job #${id}`);
  }
</script>

<div class="mon-root">
  <!-- Connection status -->
  <div class="conn" class:ok={configured}>
    <span class="conn-dot" class:off={!configured}></span>
    <div class="conn-body">
      {#if configured}
        <div class="conn-title">Loki connected</div>
        <div class="conn-url" title={monitoringState?.endpointUrl}>
          {monitoringState?.endpointUrl}
        </div>
      {:else}
        <div class="conn-title">No Loki endpoint configured</div>
        <div class="conn-url">Set a URL to stream logs.</div>
      {/if}
    </div>
    <button class="conn-btn" onclick={() => send("monitoring.configure")}>
      Configure
    </button>
  </div>

  <!-- Filter (Grafana-style) -->
  <div class="section">
    <div class="section-title">Filter</div>
    <div class="field">
      <label for="mon-range">Time range</label>
      <select id="mon-range" bind:value={rangeMs}>
        {#each RANGES as r}
          <option value={r.ms}>{r.label}</option>
        {/each}
      </select>
    </div>
    <div class="field">
      <label for="mon-search">Line contains</label>
      <input
        id="mon-search"
        type="text"
        placeholder="e.g. error, timeout, txHash…"
        bind:value={search}
      />
    </div>
    <div class="field">
      <label for="mon-limit">Max lines</label>
      <select id="mon-limit" bind:value={limit}>
        {#each LIMITS as l}
          <option value={l}>{l}</option>
        {/each}
      </select>
    </div>
    <div class="query-preview">
      <span class="query-label">LogQL</span>
      <code>{previewQuery}</code>
    </div>
  </div>

  <!-- Deployments to monitor -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">Deployments</span>
      <button
        class="refresh-btn"
        title="Refresh"
        onclick={() => send("monitoring.refresh")}
      >
        {@html ICONS.refresh}
      </button>
    </div>

    {#if deployments.length === 0}
      <div class="empty">
        <p class="muted">
          No deployments recorded yet. Deploy a job, or enter a job id below.
        </p>
      </div>
    {:else}
      <div class="cards">
        {#each deployments as dep (dep.id)}
          <div class="m-card">
            <div class="m-card-head">
              <span class="m-project">{dep.project}</span>
              <span class="badge net-{dep.network.toLowerCase()}">
                {dep.network}
              </span>
            </div>
            <div class="m-card-meta">{fmtTimestamp(dep.startedAt)}</div>
            {#if dep.jobIds.length}
              <div class="m-jobs">
                {#each dep.jobIds as j}
                  <button
                    class="job-btn"
                    title="View logs for job {j.localId}"
                    onclick={() =>
                      viewJob(
                        dep.network,
                        j.localId,
                        j.origin,
                        `${dep.project} · #${j.localId}`,
                      )}
                  >
                    <span class="mon-icon">{@html ICONS.monitoring}</span>
                    #{j.localId}
                  </button>
                {/each}
              </div>
            {:else}
              <div class="m-card-meta muted">No job ids recorded.</div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Manual job entry -->
  <div class="section">
    <div class="section-title">Open by job id</div>
    <div class="manual-row">
      <input
        type="text"
        inputmode="numeric"
        placeholder="Job id"
        bind:value={manualId}
        onkeydown={(e) => e.key === "Enter" && viewManual()}
      />
      <select bind:value={manualNetwork}>
        <option value="mainnet">mainnet</option>
        <option value="canary">canary</option>
      </select>
      <button class="small-btn" disabled={!manualId.trim()} onclick={viewManual}>
        View
      </button>
    </div>
    <p class="hint">
      Opens a Grafana-inspired log viewer in a new editor tab.
    </p>
  </div>
</div>

<style>
  .mon-root {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 2px 0 12px;
  }
  .section {
    margin: 8px 0 4px;
  }
  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .section-header .section-title {
    flex: 1;
    border-bottom: none;
    margin-bottom: 0;
    padding-bottom: 0;
  }
  .refresh-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: inline-flex;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    opacity: 0.7;
    border-radius: 3px;
  }
  .refresh-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .refresh-btn :global(svg) {
    width: 13px;
    height: 13px;
  }

  .conn {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    margin: 4px 0;
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-left: 2px solid var(--vscode-errorForeground);
    border-radius: 4px;
  }
  .conn.ok {
    border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }
  .conn-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
  }
  .conn-dot.off {
    background: var(--vscode-errorForeground);
  }
  .conn-body {
    flex: 1;
    min-width: 0;
  }
  .conn-title {
    font-size: 12px;
    font-weight: 600;
  }
  .conn-url {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .conn-btn {
    flex-shrink: 0;
    padding: 3px 8px;
    font-size: 11px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
  }
  .conn-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  .query-preview {
    margin-top: 6px;
    padding: 6px 8px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border-radius: 3px;
    overflow-x: auto;
  }
  .query-label {
    display: block;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    margin-bottom: 2px;
  }
  .query-preview code {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--vscode-charts-blue, var(--vscode-foreground));
    white-space: pre;
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .m-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    padding: 8px 10px;
  }
  .m-card-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .m-project {
    flex: 1;
    min-width: 0;
    font-size: 12px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-card-meta {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin-top: 2px;
  }
  .m-jobs {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }
  .job-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 2px 8px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }
  .job-btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .mon-icon {
    display: inline-flex;
    align-items: center;
  }
  .mon-icon :global(svg) {
    width: 11px;
    height: 11px;
  }

  .manual-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .manual-row input {
    flex: 1;
    min-width: 0;
  }
  .manual-row select {
    width: auto;
    flex-shrink: 0;
  }
  .manual-row .small-btn {
    flex-shrink: 0;
    font-size: 11px;
    padding: 4px 10px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }
  .manual-row .small-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .empty {
    padding: 10px 2px;
  }
  .muted {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin: 0;
  }
  .hint {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    margin: 6px 0 0;
  }
  .badge {
    display: inline-block;
    font-size: 9px;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .badge.net-mainnet {
    background: #65ff8f;
    color: #062b13;
  }
  .badge.net-canary {
    background: #f5c518;
    color: #2b2400;
  }
</style>
