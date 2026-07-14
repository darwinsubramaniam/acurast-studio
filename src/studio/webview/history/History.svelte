<script lang="ts">
  import type {
    HistoryStateMsg,
    StoredDeploymentWithMeta,
    OnlineJobRegistration,
    LocalJobStatus,
    DiagnosisStateMsg,
    DeregisterStateMsg,
    AssignmentsStateMsg,
  } from "../../types";
  import { untrack } from "svelte";
  import { send } from "../lib/vscode";
  import { ICONS } from "../lib/icons";
  import { planckToAcu, fmtTimestamp, fmtClock, fmtDuration, fmtCountdown, truncate } from "../lib/format";
  import DiagnosisPanel from "../shared/DiagnosisPanel.svelte";
  import DiagnoseButton from "../shared/DiagnoseButton.svelte";
  import Spinner from "../shared/Spinner.svelte";

  interface Props {
    historyState: HistoryStateMsg | null;
    activeWalletAddress: string | null;
    activeNetwork: string;
    diagnoses: Record<string, DiagnosisStateMsg>;
    deregisters: Record<string, DeregisterStateMsg>;
    assignments: Record<string, AssignmentsStateMsg>;
  }
  let {
    historyState,
    activeWalletAddress,
    activeNetwork,
    diagnoses,
    deregisters,
    assignments,
  }: Props = $props();

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

  // Consolidated delete — the one trash button on every card. The host
  // confirms, removes the local record (when `isLocal`) and signs
  // `acurast.deregister` when the job is still registered on-chain; progress
  // comes back via the `deregisters` map keyed the same as diagnoses.
  function deleteRecord(rec: StoredDeploymentWithMeta, isLocal: boolean) {
    const job = rec.jobIds[0];
    send("history.delete", {
      ...(isLocal ? { id: rec.id } : {}),
      ...(job ? { origin: job.origin, localId: job.localId, network: rec.network } : {}),
    });
  }

  // Fetch the per-processor assignments (slot + startDelay) for a record's first
  // job; the host replies via the `assignments` map keyed like diagnoses.
  function fetchAssignments(rec: StoredDeploymentWithMeta) {
    const job = rec.jobIds[0];
    if (!job) return;
    send("history.fetchAssignments", {
      origin: job.origin,
      localId: job.localId,
      network: rec.network,
    });
  }

  // Live clock for the per-processor start countdowns. Ticks once a second only
  // while at least one job's assignments have been fetched.
  let now = $state(Date.now());
  $effect(() => {
    const live = Object.values(assignments).some((a) => a?.status === "ok");
    if (!live) return;
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });

  // ── Local section ────────────────────────────────────────────────────────────
  let accumulated = $state<StoredDeploymentWithMeta[]>([]);
  let hasMore = $state(false);
  let total = $state(0);
  let nextOffset = $state(0);
  let initialLoading = $state(true);
  let loadingMore = $state(false);
  // Per-record on-chain status: 'loading' until the host's background chain
  // query resolves it. 'none' = no on-chain registration → no badge shown.
  let localStatus = $state<Record<string, LocalJobStatus | "loading">>({});

  // ── Online section ───────────────────────────────────────────────────────────
  const ONLINE_PAGE = 15;
  let onlineOpen = $state(false);
  let onlineRecords = $state<StoredDeploymentWithMeta[]>([]);
  let onlinePage = $state(0);
  let fetchingOnline = $state(false);
  let onlineError = $state<string | null>(null);
  let onlineFetched = $state(false);
  // Network the on-chain results were fetched under, to detect a target switch.
  let fetchedNetwork = $state<string | null>(null);

  let onlineTotalPages = $derived(
    Math.ceil(onlineRecords.length / ONLINE_PAGE),
  );
  let onlinePageRecords = $derived(
    onlineRecords.slice(
      onlinePage * ONLINE_PAGE,
      (onlinePage + 1) * ONLINE_PAGE,
    ),
  );

  // React only to a new historyState message; all accumulator reads/writes are
  // untracked so mutating them here can never re-trigger this effect (which
  // would otherwise loop forever — effect_update_depth_exceeded).
  $effect(() => {
    const state = historyState;
    if (!state) return;
    untrack(() => applyHistoryState(state));
  });

  function applyHistoryState(state: HistoryStateMsg) {
    if (state.records !== undefined) {
      const offset = state.offset ?? 0;
      accumulated =
        offset === 0 ? state.records : [...accumulated, ...state.records];
      hasMore = state.hasMore ?? false;
      total = state.total ?? accumulated.length;
      nextOffset = offset + state.records.length;
      initialLoading = false;
      loadingMore = false;
      // Mark these records' statuses as loading until enrichment lands.
      const pending: Record<string, LocalJobStatus | "loading"> =
        offset === 0 ? {} : { ...localStatus };
      for (const r of state.records) {
        if (r.jobIds.length) pending[r.id] = "loading";
      }
      localStatus = pending;
    }

    if (state.statuses !== undefined) {
      localStatus = { ...localStatus, ...state.statuses };
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
  }

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
    fetchedNetwork = activeNetwork;
    send("history.fetchOnline", {
      address: activeWalletAddress,
      network: activeNetwork,
    });
  }

  // Re-fetch on-chain jobs when the target network changes, so an open section
  // never keeps showing the previously-targeted network's jobs.
  $effect(() => {
    const net = activeNetwork;
    if (onlineOpen && onlineFetched && fetchedNetwork !== null && net !== fetchedNetwork) {
      if (activeWalletAddress) {
        fetchOnline();
      } else {
        // No wallet to query under the new network — fetchOnline would bail
        // before clearing, so drop the stale results here.
        onlineRecords = [];
        onlineFetched = false;
        fetchedNetwork = net;
      }
    }
  });

  // Once an on-chain job is deregistered it no longer exists on-chain, so drop
  // its card from the fetched list. The local list is refreshed by the host.
  // untrack the onlineRecords read/write so this only re-runs on `deregisters`.
  $effect(() => {
    const map = deregisters;
    untrack(() => {
      const okKeys = new Set(
        Object.values(map)
          .filter((d) => d.status === "ok")
          .map((d) => d.key),
      );
      if (okKeys.size === 0) return;
      const next = onlineRecords.filter((r) => {
        const j = r.jobIds[0];
        return !(j && okKeys.has(`${j.origin}:${j.localId}`));
      });
      if (next.length !== onlineRecords.length) {
        onlineRecords = next;
        const pages = Math.max(1, Math.ceil(next.length / ONLINE_PAGE));
        if (onlinePage >= pages) onlinePage = pages - 1;
      }
    });
  });

  // ── Multi-select bulk delete ─────────────────────────────────────────────────
  // Selection is kept per section, keyed by record id. Stale ids (records that
  // refreshed away) are harmless: everything downstream derives from the
  // intersection with the current lists.
  let selectedLocal = $state<Set<string>>(new Set());
  let selectedOnline = $state<Set<string>>(new Set());
  let selectedLocalRecs = $derived(accumulated.filter((r) => selectedLocal.has(r.id)));
  let selectedOnlineRecs = $derived(onlineRecords.filter((r) => selectedOnline.has(r.id)));

  // "Select all" covers only what's rendered: every loaded local record / the
  // visible on-chain page.
  let allLocalSelected = $derived(
    accumulated.length > 0 && accumulated.every((r) => selectedLocal.has(r.id)),
  );
  let allOnlineSelected = $derived(
    onlinePageRecords.length > 0 && onlinePageRecords.every((r) => selectedOnline.has(r.id)),
  );

  function toggleSelected(section: "local" | "online", id: string) {
    const next = new Set(section === "local" ? selectedLocal : selectedOnline);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    if (section === "local") selectedLocal = next;
    else selectedOnline = next;
  }
  function toggleAllLocal() {
    selectedLocal = allLocalSelected ? new Set() : new Set(accumulated.map((r) => r.id));
  }
  function toggleAllOnline() {
    const next = new Set(selectedOnline);
    for (const r of onlinePageRecords) {
      if (allOnlineSelected) next.delete(r.id);
      else next.add(r.id);
    }
    selectedOnline = next;
  }

  // A bulk delete is in flight while any selected card's job is loading.
  let bulkLocalBusy = $derived(
    selectedLocalRecs.some((r) => deregisters[diagKey(r)]?.status === "loading"),
  );
  let bulkOnlineBusy = $derived(
    selectedOnlineRecs.some((r) => deregisters[diagKey(r)]?.status === "loading"),
  );

  // One message for the whole selection: the host confirms once, prompts for
  // the wallet password once, and submits one utility.forceBatch per network.
  // Per-card progress arrives via the same `deregisters` map as single deletes.
  function bulkDelete(recs: StoredDeploymentWithMeta[], isLocal: boolean) {
    if (!recs.length) return;
    send("history.bulkDelete", {
      items: recs.map((rec) => {
        const job = rec.jobIds[0];
        return {
          ...(isLocal ? { id: rec.id } : {}),
          ...(job ? { origin: job.origin, localId: job.localId, network: rec.network } : {}),
        };
      }),
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
      {#if accumulated.length > 0}
        <span class="section-actions">
          {#if selectedLocalRecs.length > 0}
            <button
              class="bulk-del"
              onclick={() => bulkDelete(selectedLocalRecs, true)}
              disabled={bulkLocalBusy}
            >
              Delete {selectedLocalRecs.length}
            </button>
          {/if}
          <label class="sel-all">
            <input
              type="checkbox"
              checked={allLocalSelected}
              onchange={toggleAllLocal}
              aria-label="Select all local deployments"
            />
            All
          </label>
        </span>
      {/if}
    </div>

    {#if accumulated.length === 0}
      <div class="section-empty">
        <p class="muted">No deployments recorded on this machine.</p>
      </div>
    {:else}
      <div class="cards">
        {#each accumulated as rec (rec.id)}
          {@const dreg = deregisters[diagKey(rec)]}
          <div class="h-card">
            <div class="h-card-header">
              <input
                type="checkbox"
                class="sel-box"
                checked={selectedLocal.has(rec.id)}
                onchange={() => toggleSelected("local", rec.id)}
                aria-label="Select deployment"
              />
              <span class="h-project">{rec.project}</span>
              <span class="badge net-{rec.network.toLowerCase()}"
                >{rec.network}</span
              >
              {#if rec.jobIds.length}
                {@const st = localStatus[rec.id]}
                {#if st === "loading"}
                  <span class="badge status-loading" title="Checking chain…">
                    <Spinner size={9} />
                  </span>
                {:else if st && st !== "none"}
                  <span class="badge status-{st}">{st}</span>
                {/if}
              {/if}
              <button
                class="icon-btn danger"
                title="Delete"
                aria-label="Delete"
                onclick={() => deleteRecord(rec, true)}
                disabled={dreg?.status === "loading"}
              >
                {#if dreg?.status === "loading"}
                  <Spinner size={12} />
                {:else}
                  {@html ICONS.trash}
                {/if}
              </button>
            </div>
            <div class="h-card-meta">
              {fmt(rec.startedAt)} &middot; {rec.jobIds.length} job{rec.jobIds
                .length === 1
                ? ""
                : "s"}
            </div>
            {#if rec.jobIds.length}
              <div class="h-card-row">
                <span class="h-label">Job{rec.jobIds.length === 1 ? "" : "s"}</span>
                <span class="copy-vals">
                  {#each rec.jobIds as j}
                    <button
                      class="copy-chip mono"
                      title="Copy job id {j.localId}"
                      onclick={() =>
                        send("deploy.copy", { text: String(j.localId) })}
                    >
                      #{j.localId}
                      {@html ICONS.copy}
                    </button>
                  {/each}
                </span>
              </div>
            {/if}
            {#if rec.txHash}
              <div class="h-card-row">
                <span class="h-label">Tx</span>
                <span class="mono">{truncate(rec.txHash)}</span>
                <button
                  class="copy-btn"
                  title="Copy transaction hash"
                  onclick={() => send("deploy.copy", { text: rec.txHash! })}
                >
                  {@html ICONS.copy}
                </button>
              </div>
            {/if}
            {#if rec.ipfsHash}
              <div class="h-card-row">
                <span class="h-label">IPFS</span>
                <span class="mono">{truncate(rec.ipfsHash)}</span>
                <button
                  class="copy-btn"
                  title="Copy IPFS hash"
                  onclick={() => send("deploy.copy", { text: rec.ipfsHash! })}
                >
                  {@html ICONS.copy}
                </button>
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
                <DiagnoseButton state={dstate} onclick={() => diagnose(rec)} />
              </div>
              {#if dreg?.status === "error"}
                <div class="dereg-error">{dreg.error}</div>
              {/if}
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
            {#if loadingMore}
              <Spinner size={10} label="Loading…" />
            {:else}
              Load more ({total - nextOffset} remaining)
            {/if}
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
          {#if onlineRecords.length > 0 && !fetchingOnline}
            <span class="section-actions">
              {#if selectedOnlineRecs.length > 0}
                <button
                  class="bulk-del"
                  onclick={() => bulkDelete(selectedOnlineRecs, false)}
                  disabled={bulkOnlineBusy}
                >
                  Delete {selectedOnlineRecs.length}
                </button>
              {/if}
              <label class="sel-all">
                <input
                  type="checkbox"
                  checked={allOnlineSelected}
                  onchange={toggleAllOnline}
                  aria-label="Select all visible on-chain deployments"
                />
                All
              </label>
            </span>
          {/if}
        </div>

        {#if fetchingOnline}
          <div class="section-empty">
            <p class="muted"><Spinner size={11} label="Querying chain…" /></p>
          </div>
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
              {@const dreg = deregisters[diagKey(rec)]}
              <div class="h-card online">
                <div class="h-card-header">
                  <input
                    type="checkbox"
                    class="sel-box"
                    checked={selectedOnline.has(rec.id)}
                    onchange={() => toggleSelected("online", rec.id)}
                    aria-label="Select deployment"
                  />
                  <span class="h-project">Job #{rec.jobIds[0]?.localId}</span>
                  <span class="badge net-{rec.network.toLowerCase()}"
                    >{rec.network}</span
                  >
                  {#if rec.registration?.strategy}
                    <span class="badge strategy"
                      >{rec.registration.strategy}</span
                    >
                  {/if}
                  <span class="badge status-{status}">{status}</span>
                  <button
                    class="icon-btn danger"
                    title="Delete"
                    aria-label="Delete"
                    onclick={() => deleteRecord(rec, false)}
                    disabled={dreg?.status === "loading"}
                  >
                    {#if dreg?.status === "loading"}
                      <Spinner size={12} />
                    {:else}
                      {@html ICONS.trash}
                    {/if}
                  </button>
                </div>
                {#if rec.registration}
                  {@const r = rec.registration}
                  <div class="h-card-meta">
                    {fmt(r.startTime)} → {fmt(r.endTime)}
                  </div>
                  <div class="h-card-row">
                    <span class="h-label">Slots</span><span>{r.slots}</span>
                    <span class="h-label" style="margin-left:8px">Every</span
                    ><span>{fmtDuration(r.intervalMs)}</span>
                    <span class="h-label" style="margin-left:8px">Run</span
                    ><span>{fmtDuration(r.durationMs)}</span>
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
                  {@const astate = assignments[diagKey(rec)]}
                  <div class="h-card-actions">
                    <DiagnoseButton state={dstate} onclick={() => diagnose(rec)} />
                    {#if rec.registration}
                      <button
                        class="diag-btn"
                        onclick={() => fetchAssignments(rec)}
                        disabled={astate?.status === "loading"}
                      >
                        {astate?.status === "loading"
                          ? "Loading…"
                          : astate
                            ? "Refresh start times"
                            : "Start times"}
                      </button>
                    {/if}
                  </div>
                  {#if dreg?.status === "error"}
                    <div class="dereg-error">{dreg.error}</div>
                  {/if}
                  {#if astate}
                    <div class="h-assignments">
                      {#if astate.status === "loading"}
                        <Spinner size={10} label="Fetching processors…" />
                      {:else if astate.status === "error"}
                        <div class="dereg-error">{astate.error}</div>
                      {:else if astate.status === "ok"}
                        {#if !astate.processors?.length}
                          <div class="proc-empty">No processors assigned yet.</div>
                        {:else if rec.registration}
                          {@const start = rec.registration.startTime}
                          {@const end = rec.registration.endTime}
                          {#each astate.processors as p (p.address)}
                            {@const actualStart = start + (p.startDelay ?? 0)}
                            <div class="proc-card">
                              <div class="proc-addr" title={p.address}>{p.address}</div>
                              <div class="proc-meta">
                                {#if p.slot != null}<span>slot <b>{p.slot}</b></span>{/if}
                                {#if p.startDelay != null}<span
                                    >delay <b title={`${p.startDelay}ms`}
                                      >{fmtDuration(p.startDelay)}</b
                                    ></span
                                  >{/if}
                              </div>
                              <div class="proc-start">
                                starts <b title={fmt(actualStart)}>{fmtClock(actualStart)}</b>
                                · <span class="proc-start-rel"
                                  >{now >= end
                                    ? "ended"
                                    : fmtCountdown(actualStart - now)}</span
                                >
                              </div>
                            </div>
                          {/each}
                        {/if}
                      {/if}
                    </div>
                  {/if}
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
    /* reset global.css .section-title border/spacing so the count badge
       stays inline-centered inside the flex header */
    border-bottom: none;
    padding-bottom: 0;
    margin-bottom: 0;
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
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .sel-all {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    user-select: none;
  }
  .sel-all input,
  .sel-box {
    margin: 0;
    cursor: pointer;
    accent-color: var(--vscode-button-background);
    flex-shrink: 0;
  }
  .bulk-del {
    font-size: 11px;
    padding: 2px 10px;
    background: transparent;
    color: var(--vscode-errorForeground);
    border: 1px solid var(--vscode-errorForeground);
    border-radius: 4px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
  }
  .bulk-del:hover:not(:disabled) {
    background: var(--vscode-inputValidation-errorBackground);
  }
  .bulk-del:disabled {
    opacity: 0.6;
    cursor: default;
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
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .dereg-error {
    margin-top: 6px;
    font-size: 10.5px;
    color: var(--vscode-errorForeground);
    word-break: break-word;
  }
  .h-assignments {
    margin-top: 6px;
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

  .copy-btn {
    background: none;
    border: none;
    cursor: pointer;
    padding: 2px;
    display: inline-flex;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    opacity: 0.55;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .copy-btn:hover {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }
  .copy-btn :global(svg) {
    width: 12px;
    height: 12px;
  }

  .copy-vals {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    min-width: 0;
  }
  .copy-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    padding: 1px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border: none;
    border-radius: 10px;
    cursor: pointer;
  }
  .copy-chip:hover {
    background: var(--vscode-toolbar-hoverBackground);
    color: var(--vscode-foreground);
  }
  .copy-chip :global(svg) {
    width: 11px;
    height: 11px;
    opacity: 0.7;
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
  .icon-btn:hover:not(:disabled) {
    opacity: 1;
    background: var(--vscode-toolbar-hoverBackground);
  }
  .icon-btn:disabled {
    cursor: default;
  }
  .icon-btn.danger:hover:not(:disabled) {
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
  /* Network identity: Acurast green for mainnet, yellow for canary */
  .badge.net-mainnet {
    background: #65ff8f;
    color: #062b13;
  }
  .badge.net-canary {
    background: #f5c518;
    color: #2b2400;
  }
  .badge.status-active {
    background: #2e7d46;
    color: #eafaef;
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
  .badge.status-loading {
    background: transparent;
    padding: 1px 3px;
    display: inline-flex;
    align-items: center;
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
