<script lang="ts">
  import type {
    HistoryStateMsg,
    StoredDeploymentWithMeta,
    OnlineJobRegistration,
    DiagnosisStateMsg,
  } from "../types";
  import { send } from "./lib/vscode";
  import { ICONS } from "./lib/icons";
  import { planckToAcu, fmtTimestamp, fmtMs, truncate } from "./lib/format";
  import DiagnosisPanel from "./DiagnosisPanel.svelte";

  interface Props {
    historyState: HistoryStateMsg | null;
    activeWalletAddress: string | null;
    activeNetwork: string;
    diagnoses: Record<string, DiagnosisStateMsg>;
  }
  let { historyState, activeWalletAddress, activeNetwork, diagnoses }: Props =
    $props();

  // Trigger an on-chain diagnosis for a record's first job id.
  function diagnose(rec: StoredDeploymentWithMeta) {
    const job = rec.jobIds[0];
    if (!job) return;
    send("history.diagnose", {
      origin: job.origin,
      localId: job.localId,
      network: rec.network,
    });
  }
  const diagKey = (rec: StoredDeploymentWithMeta): string =>
    rec.jobIds[0] ? `${rec.jobIds[0].origin}:${rec.jobIds[0].localId}` : "";

  // ── Local section ────────────────────────────────────────────────────────────
  let accumulated = $state<StoredDeploymentWithMeta[]>([]);
  let hasMore = $state(false);
  let total = $state(0);
  let nextOffset = $state(0);
  let initialLoading = $state(true);
  let loadingMore = $state(false);

  // ── Online section ───────────────────────────────────────────────────────────
  const ONLINE_PAGE = 15;
  let onlineOpen = $state(false);
  let onlineRecords = $state<StoredDeploymentWithMeta[]>([]);
  let onlinePage = $state(0);
  let fetchingOnline = $state(false);
  let onlineError = $state<string | null>(null);
  let onlineFetched = $state(false);

  let onlineTotalPages = $derived(
    Math.ceil(onlineRecords.length / ONLINE_PAGE),
  );
  let onlinePageRecords = $derived(
    onlineRecords.slice(
      onlinePage * ONLINE_PAGE,
      (onlinePage + 1) * ONLINE_PAGE,
    ),
  );

  $effect(() => {
    const state = historyState;
    if (!state) return;

    if (state.records !== undefined) {
      const offset = state.offset ?? 0;
      accumulated =
        offset === 0 ? state.records : [...accumulated, ...state.records];
      hasMore = state.hasMore ?? false;
      total = state.total ?? accumulated.length;
      nextOffset = offset + state.records.length;
      initialLoading = false;
      loadingMore = false;
    }

    if (state.onlineRecords !== undefined) {
      onlineRecords = state.onlineRecords;
      onlinePage = 0;
      fetchingOnline = false;
      onlineError = null;
      onlineFetched = true;
    }

    if (state.status === "error" && state.records === undefined) {
      onlineError = state.error ?? "Unknown error";
      fetchingOnline = false;
    }
  });

  function loadMore() {
    loadingMore = true;
    send("history.load", { offset: nextOffset });
  }

  function fetchOnline() {
    if (!activeWalletAddress || fetchingOnline) return;
    fetchingOnline = true;
    onlineError = null;
    onlineFetched = false;
    onlineRecords = [];
    send("history.fetchOnline", {
      address: activeWalletAddress,
      network: activeNetwork,
    });
  }

  const fmt = fmtTimestamp;

  type JobStatus = "active" | "scheduled" | "expired" | "unknown";

  function jobStatus(reg: OnlineJobRegistration | undefined): JobStatus {
    if (!reg) return "unknown";
    const now = Date.now();
    if (reg.startTime > now) return "scheduled";
    if (reg.endTime < now) return "expired";
    return "active";
  }
</script>

{#if initialLoading}
  <div class="empty"><p class="muted">Loading…</p></div>
{:else}
  <div class="history-root">
    <!-- ── Local Deployments ── -->
    <div class="section-header">
      <span class="section-title">Local</span>
      {#if total > 0}
        <span class="section-count">{total}</span>
      {/if}
    </div>

    {#if accumulated.length === 0}
      <div class="section-empty">
        <p class="muted">No deployments recorded on this machine.</p>
      </div>
    {:else}
      <div class="cards">
        {#each accumulated as rec (rec.id)}
          <div class="h-card">
            <div class="h-card-header">
              <span class="h-project">{rec.project}</span>
              <span class="badge">{rec.network}</span>
              <button
                class="icon-btn danger"
                title="Remove"
                onclick={() => send("history.remove", { id: rec.id })}
              >
                {@html ICONS.trash}
              </button>
            </div>
            <div class="h-card-meta">
              {fmt(rec.startedAt)} &middot; {rec.jobIds.length} job{rec.jobIds
                .length === 1
                ? ""
                : "s"}
            </div>
            {#if rec.txHash}
              <div class="h-card-row">
                <span class="h-label">Tx</span>
                <span class="mono">{truncate(rec.txHash)}</span>
              </div>
            {/if}
            {#if rec.ipfsHash}
              <div class="h-card-row">
                <span class="h-label">IPFS</span>
                <span class="mono">{truncate(rec.ipfsHash)}</span>
              </div>
            {/if}
            {#if rec.projectPath}
              {#if rec.pathExists}
                <div class="h-card-row source">
                  <span class="h-label">Source</span>
                  <span class="h-path" title={rec.projectPath}
                    >{rec.projectPath}</span
                  >
                  <button
                    class="small"
                    onclick={() =>
                      send("history.openFolder", { path: rec.projectPath! })}
                    >Open</button
                  >
                </div>
              {:else}
                <div class="h-card-row source warn">
                  <span class="warn-icon">{@html ICONS.trash}</span>
                  <span class="warn-text">Source path no longer exists</span>
                  <button
                    class="small secondary"
                    onclick={() =>
                      send("history.removePathInfo", { id: rec.id })}
                    >Remove path</button
                  >
                </div>
              {/if}
            {/if}
            {#if rec.jobIds[0]}
              {@const dstate = diagnoses[diagKey(rec)]}
              <div class="h-card-actions">
                <button
                  class="diag-btn"
                  onclick={() => diagnose(rec)}
                  disabled={dstate?.status === "loading"}
                >
                  {dstate?.status === "loading"
                    ? "Diagnosing…"
                    : dstate
                      ? "Re-run diagnosis"
                      : "Diagnose"}
                </button>
              </div>
              <DiagnosisPanel state={dstate} />
            {/if}
          </div>
        {/each}
      </div>

      {#if hasMore}
        <div class="load-more-row">
          <button
            class="secondary small-btn"
            onclick={loadMore}
            disabled={loadingMore}
          >
            {loadingMore
              ? "Loading…"
              : `Load more (${total - nextOffset} remaining)`}
          </button>
        </div>
      {/if}
    {/if}

    <!-- ── On-chain Deployments ── -->
    <button
      class="section-header section-toggle"
      onclick={() => (onlineOpen = !onlineOpen)}
      style="margin-top: 16px;"
    >
      <span class="section-title">On-chain</span>
      {#if onlineRecords.length > 0}
        <span class="section-count">{onlineRecords.length}</span>
      {/if}
      <span class="toggle-chev" class:open={onlineOpen}>{@html ICONS.chev}</span
      >
    </button>

    {#if onlineOpen}
      <div class="online-body">
        <div class="online-toolbar">
          {#if activeWalletAddress}
            <button
              class="small-btn secondary"
              onclick={fetchOnline}
              disabled={fetchingOnline}
            >
              {fetchingOnline
                ? "Fetching…"
                : onlineFetched
                  ? "Refresh"
                  : "Fetch from chain"}
            </button>
          {:else}
            <p class="muted">
              Set an active wallet to fetch on-chain deployments.
            </p>
          {/if}
        </div>

        {#if fetchingOnline}
          <div class="section-empty"><p class="muted">Querying chain…</p></div>
        {:else if onlineError}
          <div class="section-empty"><p class="err-msg">{onlineError}</p></div>
        {:else if !onlineFetched}
          <div class="section-empty">
            <p class="muted">
              Press "Fetch from chain" to load your on-chain deployments.
            </p>
          </div>
        {:else if onlineRecords.length === 0}
          <div class="section-empty">
            <p class="muted">No additional on-chain deployments found.</p>
          </div>
        {:else}
          <div class="cards">
            {#each onlinePageRecords as rec (rec.id)}
              {@const status = jobStatus(rec.registration)}
              <div class="h-card online">
                <div class="h-card-header">
                  <span class="h-project">Job #{rec.jobIds[0]?.localId}</span>
                  <span class="badge">{rec.network}</span>
                  {#if rec.registration?.strategy}
                    <span class="badge strategy"
                      >{rec.registration.strategy}</span
                    >
                  {/if}
                  <span class="badge status-{status}">{status}</span>
                </div>
                {#if rec.registration}
                  {@const r = rec.registration}
                  <div class="h-card-meta">
                    {fmt(r.startTime)} → {fmt(r.endTime)}
                  </div>
                  <div class="h-card-row">
                    <span class="h-label">Slots</span><span>{r.slots}</span>
                    <span class="h-label" style="margin-left:8px">Every</span
                    ><span>{fmtMs(r.intervalMs)}</span>
                    <span class="h-label" style="margin-left:8px">Run</span
                    ><span>{fmtMs(r.durationMs)}</span>
                  </div>
                  <div class="h-card-row">
                    <span class="h-label">Reward</span><span
                      >{planckToAcu(r.rewardPlanck)} ACU</span
                    >
                  </div>
                  {#if r.modules.length}
                    <div class="h-card-row">
                      <span class="h-label">Modules</span>
                      <span class="modules">{r.modules.join(", ")}</span>
                    </div>
                  {/if}
                  {#if r.scriptUrl}
                    <div class="h-card-row">
                      <span class="h-label">Script</span>
                      <span class="mono">{truncate(r.scriptUrl, 16)}</span>
                    </div>
                  {/if}
                {:else}
                  <div class="h-card-meta">
                    On-chain only &middot; not in local history
                  </div>
                {/if}
                {#if rec.jobIds[0]}
                  {@const dstate = diagnoses[diagKey(rec)]}
                  <div class="h-card-actions">
                    <button
                      class="diag-btn"
                      onclick={() => diagnose(rec)}
                      disabled={dstate?.status === "loading"}
                    >
                      {dstate?.status === "loading"
                        ? "Diagnosing…"
                        : dstate
                          ? "Re-run diagnosis"
                          : "Diagnose"}
                    </button>
                  </div>
                  <DiagnosisPanel state={dstate} />
                {/if}
              </div>
            {/each}
          </div>

          {#if onlineTotalPages > 1}
            <div class="pagination">
              <button
                class="page-btn"
                onclick={() => (onlinePage = Math.max(0, onlinePage - 1))}
                disabled={onlinePage === 0}
              >
                {@html ICONS.back}
              </button>
              <span class="page-label"
                >{onlinePage + 1} / {onlineTotalPages}</span
              >
              <button
                class="page-btn"
                onclick={() =>
                  (onlinePage = Math.min(onlineTotalPages - 1, onlinePage + 1))}
                disabled={onlinePage >= onlineTotalPages - 1}
              >
                {@html ICONS.chev}
              </button>
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .history-root {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 4px 0 12px;
  }

  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 32px 16px;
    text-align: center;
    font-size: 12px;
  }
  .section-empty {
    padding: 8px 2px 4px;
  }
  .muted {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    margin: 0;
  }
  .err-msg {
    color: var(--vscode-errorForeground);
    font-size: 11px;
    margin: 0;
  }

  .section-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 0 4px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    margin-bottom: 4px;
  }
  .section-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
  }
  .section-count {
    font-size: 10px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 8px;
    padding: 0 5px;
    min-width: 16px;
    text-align: center;
  }
  .section-actions {
    margin-left: auto;
  }

  .section-toggle {
    width: 100%;
    background: none;
    border: none;
    cursor: pointer;
    text-align: left;
    padding: 6px 0 4px;
    color: inherit;
  }
  .section-toggle:hover .section-title {
    color: var(--vscode-foreground);
  }
  .toggle-chev {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    transition: transform 0.15s ease;
  }
  .toggle-chev.open {
    transform: rotate(90deg);
  }
  .toggle-chev :global(svg) {
    width: 13px;
    height: 13px;
  }

  .online-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 4px;
  }
  .online-toolbar {
    display: flex;
    align-items: center;
    padding: 2px 0 2px;
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .h-card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 4px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .h-card.online {
    opacity: 0.85;
  }

  .h-card-header {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .h-project {
    font-size: 13px;
    font-weight: 600;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .h-card-meta {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .h-card-actions {
    margin-top: 6px;
  }
  .diag-btn {
    font-size: 11px;
    padding: 2px 10px;
    background: transparent;
    color: var(--vscode-textLink-foreground);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 4px;
    cursor: pointer;
  }
  .diag-btn:hover:not(:disabled) {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .diag-btn:disabled {
    opacity: 0.6;
    cursor: default;
  }

  .h-card-row {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .h-label {
    color: var(--vscode-descriptionForeground);
    min-width: 32px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .mono {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .source {
    flex-wrap: wrap;
  }
  .h-path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
  }

  .warn {
    color: var(--vscode-errorForeground);
  }
  .warn-icon {
    width: 12px;
    height: 12px;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .warn-icon :global(svg) {
    width: 12px;
    height: 12px;
  }
  .warn-text {
    flex: 1;
    font-size: 11px;
  }

  .icon-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    opacity: 0.6;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .icon-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .icon-btn.danger:hover {
    color: var(--vscode-errorForeground);
  }
  .icon-btn :global(svg) {
    width: 14px;
    height: 14px;
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
  .badge.strategy {
    background: var(--vscode-charts-blue, #0078d4);
    color: #fff;
  }
  .badge.status-active {
    background: var(--vscode-charts-green, #388a34);
    color: #fff;
  }
  .badge.status-scheduled {
    background: var(--vscode-charts-blue, #0078d4);
    color: #fff;
  }
  .badge.status-expired {
    background: var(--vscode-disabledForeground, #6e7681);
    color: #fff;
  }
  .badge.status-unknown {
    background: var(--vscode-disabledForeground, #6e7681);
    color: #fff;
  }
  .modules {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
  }

  .small {
    font-size: 11px;
    padding: 2px 8px;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .small:hover {
    background: var(--vscode-button-hoverBackground);
  }
  .small.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .small.secondary:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }

  .small-btn {
    font-size: 11px;
    padding: 3px 10px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }
  .small-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .small-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .load-more-row {
    display: flex;
    justify-content: center;
    padding: 6px 0 2px;
  }

  .pagination {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px 0 2px;
  }
  .page-btn {
    background: none;
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    cursor: pointer;
    padding: 3px 6px;
    display: flex;
    align-items: center;
    color: var(--vscode-foreground);
  }
  .page-btn:hover:not(:disabled) {
    background: var(--vscode-list-hoverBackground);
  }
  .page-btn:disabled {
    opacity: 0.35;
    cursor: not-allowed;
  }
  .page-btn :global(svg) {
    width: 14px;
    height: 14px;
  }
  .page-label {
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    min-width: 40px;
    text-align: center;
  }
</style>
