<script lang="ts">
  import type { LogLevel, LogRow, LokiQueryParams } from "../../loki/types";
  import { send } from "../webview/lib/vscode";

  // ── Constants ──
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
  const ALL_LEVELS: LogLevel[] = [
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "unknown",
  ];

  // ── State ──
  let params = $state<LokiQueryParams | null>(null);
  let endpointConfigured = $state(true);
  let endpointUrl = $state("");

  let rows = $state<LogRow[]>([]);
  let loading = $state(false);
  let tailActive = $state(false);
  let error = $state<string | null>(null);
  let stats = $state<{ returned: number; elapsedMs: number; capped: boolean } | null>(
    null,
  );

  // Editable controls
  let queryText = $state("");
  let rangeMs = $state(60 * 60_000);
  let limit = $state(1000);

  // Client-side view controls
  let findText = $state("");
  let wrap = $state(false);
  let showTime = $state(true);
  let hidden = $state<Set<LogLevel>>(new Set());
  let expanded = $state<Set<string>>(new Set());

  // ── Derived ──
  let levelCounts = $derived.by(() => {
    const c: Record<LogLevel, number> = {
      error: 0,
      warn: 0,
      info: 0,
      debug: 0,
      trace: 0,
      unknown: 0,
    };
    for (const r of rows) c[r.level]++;
    return c;
  });

  let visibleRows = $derived.by(() => {
    const needle = findText.trim().toLowerCase();
    return rows.filter((r) => {
      if (hidden.has(r.level)) return false;
      if (needle && !r.line.toLowerCase().includes(needle)) return false;
      return true;
    });
  });

  // Stacked logs-volume histogram (Grafana-style), bucketed across the range.
  let volume = $derived.by(() => {
    if (!rows.length) return { buckets: [], max: 0 };
    const end = params?.endMs ?? Date.now();
    const start = params?.startMs ?? end - rangeMs;
    const span = Math.max(1, end - start);
    const N = 40;
    const buckets = Array.from({ length: N }, () => ({
      total: 0,
      by: {} as Record<LogLevel, number>,
    }));
    for (const r of rows) {
      let i = Math.floor(((r.tsMs - start) / span) * N);
      if (i < 0) i = 0;
      if (i >= N) i = N - 1;
      buckets[i].total++;
      buckets[i].by[r.level] = (buckets[i].by[r.level] ?? 0) + 1;
    }
    const max = Math.max(1, ...buckets.map((b) => b.total));
    return { buckets, max };
  });

  // ── Message bus ──
  $effect(() => {
    function onMessage(event: MessageEvent) {
      const msg = event.data as Record<string, unknown> & { type: string };
      switch (msg.type) {
        case "lv.init": {
          const p = msg.params as LokiQueryParams;
          params = p;
          queryText = p.query;
          limit = p.limit;
          endpointConfigured = msg.endpointConfigured as boolean;
          endpointUrl = msg.endpointUrl as string;
          rangeMs = closestRange(p.endMs - p.startMs);
          break;
        }
        case "lv.loading":
          loading = true;
          if (!msg.tail) error = null;
          break;
        case "lv.result": {
          const incoming = msg.rows as LogRow[];
          const append = Boolean(msg.append);
          params = msg.params as LokiQueryParams;
          rows = append ? mergeRows(rows, incoming) : incoming;
          stats = msg.stats as typeof stats;
          loading = false;
          error = null;
          break;
        }
        case "lv.error":
          error = msg.message as string;
          loading = false;
          break;
        case "lv.tailState":
          tailActive = msg.active as boolean;
          break;
      }
    }
    window.addEventListener("message", onMessage);
    send("lv.ready");
    return () => window.removeEventListener("message", onMessage);
  });

  // ── Helpers ──
  function closestRange(span: number): number {
    let best = RANGES[0].ms;
    let diff = Infinity;
    for (const r of RANGES) {
      const d = Math.abs(r.ms - span);
      if (d < diff) {
        diff = d;
        best = r.ms;
      }
    }
    return best;
  }

  function mergeRows(existing: LogRow[], incoming: LogRow[]): LogRow[] {
    const seen = new Set(existing.map((r) => r.id));
    const merged = [...existing];
    for (const r of incoming) if (!seen.has(r.id)) merged.push(r);
    // Newest first.
    merged.sort((a, b) => cmpNs(b.tsNs, a.tsNs));
    return merged;
  }

  function cmpNs(a: string, b: string): number {
    if (a.length !== b.length) return a.length - b.length;
    return a < b ? -1 : a > b ? 1 : 0;
  }

  function currentParams(): LokiQueryParams {
    const endMs = Date.now();
    return {
      ...(params as LokiQueryParams),
      query: queryText.trim() || "{}",
      limit,
      startMs: endMs - rangeMs,
      endMs,
      direction: "backward",
    };
  }

  function runQuery() {
    if (tailActive) toggleTail(); // a manual run resets the window; stop tailing
    send("lv.query", { params: currentParams() });
  }

  function toggleTail() {
    const next = !tailActive;
    send("lv.tail", { active: next, params: currentParams() });
  }

  function clearLogs() {
    rows = [];
    stats = null;
    expanded = new Set();
  }

  function toggleLevel(l: LogLevel) {
    const next = new Set(hidden);
    if (next.has(l)) next.delete(l);
    else next.add(l);
    hidden = next;
  }

  function toggleExpand(id: string) {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    expanded = next;
  }

  function copyLine(line: string) {
    send("lv.copy", { text: line });
  }

  function copyAll() {
    send("lv.copy", { text: visibleRows.map((r) => r.line).join("\n") });
  }

  // Timestamp formatting (full + clock with ms).
  const DT = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  function fmtClockMs(ms: number): string {
    const d = new Date(ms);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    const mmm = String(d.getMilliseconds()).padStart(3, "0");
    return `${hh}:${mm}:${ss}.${mmm}`;
  }

  // Highlight find matches within a line (escaped → safe HTML with <mark>).
  function escapeHtml(s: string): string {
    return s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  function highlight(line: string): string {
    const needle = findText.trim();
    if (!needle) return escapeHtml(line);
    const lower = line.toLowerCase();
    const nlower = needle.toLowerCase();
    let out = "";
    let i = 0;
    while (i < line.length) {
      const idx = lower.indexOf(nlower, i);
      if (idx === -1) {
        out += escapeHtml(line.slice(i));
        break;
      }
      out += escapeHtml(line.slice(i, idx));
      out += `<mark>${escapeHtml(line.slice(idx, idx + needle.length))}</mark>`;
      i = idx + needle.length;
    }
    return out;
  }

  let levelChips = $derived(
    ALL_LEVELS.filter((l) => levelCounts[l] > 0),
  );
</script>

<div class="lv">
  <!-- Toolbar -->
  <div class="lv-toolbar">
    <div class="lv-query">
      <span class="lv-query-label">LogQL</span>
      <input
        class="lv-query-input"
        type="text"
        spellcheck="false"
        bind:value={queryText}
        onkeydown={(e) => e.key === "Enter" && runQuery()}
      />
    </div>
    <select class="lv-range" bind:value={rangeMs} title="Time range">
      {#each RANGES as r}
        <option value={r.ms}>{r.label}</option>
      {/each}
    </select>
    <select class="lv-limit" bind:value={limit} title="Max lines">
      {#each LIMITS as l}
        <option value={l}>{l} lines</option>
      {/each}
    </select>
    <button class="lv-btn primary" onclick={runQuery} disabled={loading && !tailActive}>
      {loading && !tailActive ? "Running…" : "Run query"}
    </button>
    <button
      class="lv-btn live"
      class:on={tailActive}
      onclick={toggleTail}
      title="Stream new logs as they arrive"
    >
      <span class="live-dot" class:on={tailActive}></span>
      {tailActive ? "Live" : "Live"}
    </button>
  </div>

  <!-- Status / meta -->
  <div class="lv-meta">
    <span class="lv-title">{params?.title ?? ""}</span>
    <span class="lv-net">{params?.network ?? ""}</span>
    {#if stats}
      <span class="lv-stat">
        {stats.returned} lines{stats.capped ? " (limit reached)" : ""}
        {#if stats.elapsedMs > 0}· {stats.elapsedMs} ms{/if}
      </span>
    {/if}
    <span class="lv-spacer"></span>
    <span class="lv-endpoint" title={endpointUrl}>{endpointUrl}</span>
  </div>

  {#if !endpointConfigured}
    <div class="lv-banner error">
      <span>No Loki endpoint is configured for this network.</span>
      <button class="lv-btn" onclick={() => send("lv.configure")}>Configure</button>
    </div>
  {:else if error}
    <div class="lv-banner error">
      <span>{error}</span>
      <button class="lv-btn" onclick={runQuery}>Retry</button>
    </div>
  {/if}

  <!-- Logs volume histogram -->
  {#if rows.length}
    <div class="lv-volume" title="Log volume over the selected range">
      {#each volume.buckets as b}
        <div class="vol-col" style="height: {(b.total / volume.max) * 100}%">
          {#each ALL_LEVELS as l}
            {#if b.by[l]}
              <div
                class="vol-seg lvl-{l}"
                style="height: {(b.by[l] / b.total) * 100}%"
              ></div>
            {/if}
          {/each}
        </div>
      {/each}
    </div>
  {/if}

  <!-- Controls bar -->
  <div class="lv-controls">
    <div class="lv-chips">
      {#each levelChips as l}
        <button
          class="chip lvl-{l}"
          class:off={hidden.has(l)}
          onclick={() => toggleLevel(l)}
          title="Toggle {l}"
        >
          <span class="chip-dot"></span>{l}
          <span class="chip-count">{levelCounts[l]}</span>
        </button>
      {/each}
    </div>
    <span class="lv-spacer"></span>
    <input
      class="lv-find"
      type="text"
      placeholder="Find in results…"
      bind:value={findText}
    />
    <label class="lv-toggle" title="Wrap long lines">
      <input type="checkbox" bind:checked={wrap} /> Wrap
    </label>
    <label class="lv-toggle" title="Show timestamps">
      <input type="checkbox" bind:checked={showTime} /> Time
    </label>
    <button class="lv-icon-btn" title="Copy visible lines" onclick={copyAll}>
      Copy
    </button>
    <button class="lv-icon-btn" title="Clear" onclick={clearLogs}>Clear</button>
  </div>

  <!-- Log rows -->
  <div class="lv-rows" class:wrap>
    {#if loading && !rows.length}
      <div class="lv-empty">Loading logs…</div>
    {:else if !rows.length}
      <div class="lv-empty">
        No logs in this range. Adjust the query or time range and run again.
      </div>
    {:else if !visibleRows.length}
      <div class="lv-empty">No lines match the current filters.</div>
    {:else}
      {#each visibleRows as row (row.id)}
        <div class="lv-row lvl-{row.level}" class:expanded={expanded.has(row.id)}>
          <button
            class="row-main"
            onclick={() => toggleExpand(row.id)}
            ondblclick={() => copyLine(row.line)}
          >
            <span class="row-gutter lvl-{row.level}"></span>
            {#if showTime}
              <span class="row-ts" title={DT.format(row.tsMs)}>
                {fmtClockMs(row.tsMs)}
              </span>
            {/if}
            <span class="row-level lvl-{row.level}">{row.level}</span>
            <span class="row-line">{@html highlight(row.line)}</span>
          </button>
          {#if expanded.has(row.id)}
            <div class="row-detail">
              {#if Object.keys(row.labels).length}
                <div class="detail-section-title">Labels</div>
                <div class="detail-chips">
                  {#each Object.entries(row.labels) as [k, v]}
                    <span class="detail-chip"
                      ><b>{k}</b>=<span>{v}</span></span
                    >
                  {/each}
                </div>
              {/if}
              {#if row.fields && Object.keys(row.fields).length}
                <div class="detail-section-title">Fields</div>
                <table class="detail-fields">
                  <tbody>
                    {#each Object.entries(row.fields) as [k, v]}
                      <tr>
                        <td class="fk">{k}</td>
                        <td class="fv">{v}</td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              {/if}
              <div class="detail-section-title">Line</div>
              <pre class="detail-raw">{row.line}</pre>
              <div class="detail-actions">
                <button class="lv-icon-btn" onclick={() => copyLine(row.line)}>
                  Copy line
                </button>
                <span class="detail-full-ts">{DT.format(row.tsMs)}</span>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  :global(body.logviewer-body) {
    padding: 0;
    height: 100vh;
    overflow: hidden;
  }
  .lv {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-size: 12px;
  }

  /* Toolbar */
  .lv-toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    flex-shrink: 0;
  }
  .lv-query {
    flex: 1;
    display: flex;
    align-items: stretch;
    min-width: 0;
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border, transparent));
    border-radius: 3px;
    background: var(--vscode-input-background);
    overflow: hidden;
  }
  .lv-query-label {
    display: flex;
    align-items: center;
    padding: 0 8px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-badge-background);
    flex-shrink: 0;
  }
  .lv-query-input {
    flex: 1;
    min-width: 0;
    border: none;
    background: transparent;
    color: var(--vscode-input-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    padding: 5px 8px;
    outline: none;
  }
  .lv-range,
  .lv-limit {
    width: auto;
    flex-shrink: 0;
  }
  .lv-btn {
    flex-shrink: 0;
    padding: 5px 12px;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
  }
  .lv-btn:hover:not(:disabled) {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .lv-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .lv-btn.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
  }
  .lv-btn.primary:hover:not(:disabled) {
    background: var(--vscode-button-hoverBackground);
  }
  .lv-btn.live {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .lv-btn.live.on {
    background: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    color: var(--vscode-editor-background);
  }
  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: currentColor;
    opacity: 0.5;
  }
  .live-dot.on {
    opacity: 1;
    animation: lv-pulse 1.2s ease-in-out infinite;
  }
  @keyframes lv-pulse {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.3;
    }
  }

  /* Meta */
  .lv-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 5px 10px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    flex-shrink: 0;
  }
  .lv-title {
    font-weight: 600;
    color: var(--vscode-foreground);
  }
  .lv-net {
    text-transform: uppercase;
    font-size: 9px;
    letter-spacing: 0.05em;
    padding: 1px 5px;
    border-radius: 2px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .lv-spacer {
    flex: 1;
  }
  .lv-endpoint {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 40%;
    opacity: 0.8;
  }

  .lv-banner {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    font-size: 12px;
    flex-shrink: 0;
  }
  .lv-banner.error {
    background: var(--vscode-inputValidation-errorBackground);
    color: var(--vscode-errorForeground);
    border-bottom: 1px solid
      var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground));
  }
  .lv-banner span {
    flex: 1;
  }

  /* Volume histogram */
  .lv-volume {
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 48px;
    padding: 6px 10px 0;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    flex-shrink: 0;
  }
  .vol-col {
    flex: 1;
    min-height: 1px;
    display: flex;
    flex-direction: column-reverse;
    background: var(--vscode-input-background);
    border-radius: 1px 1px 0 0;
    overflow: hidden;
  }
  .vol-seg {
    width: 100%;
  }

  /* Controls bar */
  .lv-controls {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, transparent);
    flex-shrink: 0;
    flex-wrap: wrap;
  }
  .lv-chips {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
  }
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 8px;
    font-size: 11px;
    border-radius: 10px;
    border: 1px solid var(--vscode-panel-border, transparent);
    background: var(--vscode-editor-background);
    color: var(--vscode-foreground);
    cursor: pointer;
    text-transform: capitalize;
  }
  .chip:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }
  .chip.off {
    opacity: 0.4;
    text-decoration: line-through;
  }
  .chip-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
  }
  .chip-count {
    font-variant-numeric: tabular-nums;
    color: var(--vscode-descriptionForeground);
    font-size: 10px;
  }
  .lv-find {
    width: 180px;
    flex-shrink: 0;
    padding: 3px 8px;
  }
  .lv-toggle {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground);
    cursor: pointer;
    white-space: nowrap;
  }
  .lv-toggle input {
    width: auto;
    margin: 0;
  }
  .lv-icon-btn {
    padding: 3px 8px;
    font-size: 11px;
    background: transparent;
    color: var(--vscode-foreground);
    border: 1px solid var(--vscode-panel-border, transparent);
    border-radius: 3px;
    cursor: pointer;
  }
  .lv-icon-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
  }

  /* Rows */
  .lv-rows {
    flex: 1;
    overflow-y: auto;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
  }
  .lv-empty {
    padding: 24px 16px;
    color: var(--vscode-descriptionForeground);
    text-align: center;
    font-family: var(--vscode-font-family);
    font-size: 12px;
  }
  .lv-row {
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.12));
  }
  .lv-row:nth-child(even) {
    background: var(--vscode-list-hoverBackground, rgba(128, 128, 128, 0.04));
  }
  .lv-row:hover {
    background: var(--vscode-list-hoverBackground);
  }
  .row-main {
    display: flex;
    align-items: baseline;
    gap: 8px;
    width: 100%;
    background: none;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--vscode-foreground);
    font: inherit;
    padding: 2px 10px 2px 0;
  }
  .row-gutter {
    width: 3px;
    align-self: stretch;
    flex-shrink: 0;
    background: var(--vscode-descriptionForeground);
  }
  .row-ts {
    flex-shrink: 0;
    color: var(--vscode-descriptionForeground);
    font-variant-numeric: tabular-nums;
    font-size: 11px;
  }
  .row-level {
    flex-shrink: 0;
    width: 44px;
    text-transform: uppercase;
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.03em;
  }
  .row-line {
    flex: 1;
    min-width: 0;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .lv-rows.wrap .row-line {
    white-space: pre-wrap;
    word-break: break-word;
    overflow: visible;
  }
  .row-line :global(mark) {
    background: var(--vscode-editor-findMatchHighlightBackground, #ffd33d);
    color: inherit;
    border-radius: 2px;
  }

  /* Row detail (expanded) */
  .row-detail {
    padding: 8px 10px 10px 12px;
    background: var(--vscode-textBlockQuote-background, rgba(128, 128, 128, 0.06));
    border-top: 1px dashed var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family);
  }
  .detail-section-title {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vscode-descriptionForeground);
    margin: 8px 0 4px;
    font-weight: 600;
  }
  .detail-section-title:first-child {
    margin-top: 0;
  }
  .detail-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .detail-chip {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 3px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
  }
  .detail-chip b {
    color: var(--vscode-foreground);
    font-weight: 600;
  }
  .detail-fields {
    border-collapse: collapse;
    width: 100%;
  }
  .detail-fields td {
    padding: 2px 8px 2px 0;
    vertical-align: top;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
  }
  .detail-fields .fk {
    color: var(--vscode-symbolIcon-keyForeground, var(--vscode-descriptionForeground));
    white-space: nowrap;
    font-weight: 600;
  }
  .detail-fields .fv {
    color: var(--vscode-foreground);
    word-break: break-word;
  }
  .detail-raw {
    margin: 0;
    padding: 6px 8px;
    background: var(--vscode-textCodeBlock-background, var(--vscode-input-background));
    border-radius: 3px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 240px;
    overflow: auto;
  }
  .detail-actions {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-top: 8px;
  }
  .detail-full-ts {
    font-size: 10px;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
  }

  /* Level colors — gutters, level text, chips, volume segments */
  .lvl-error .row-gutter,
  .vol-seg.lvl-error,
  .chip.lvl-error .chip-dot,
  .row-level.lvl-error {
    background: var(--vscode-charts-red, #f14c4c);
  }
  .row-level.lvl-error {
    background: none;
    color: var(--vscode-charts-red, #f14c4c);
  }
  .chip.lvl-error {
    color: var(--vscode-charts-red, #f14c4c);
  }

  .lvl-warn .row-gutter,
  .vol-seg.lvl-warn,
  .chip.lvl-warn .chip-dot {
    background: var(--vscode-charts-yellow, #cca700);
  }
  .row-level.lvl-warn {
    color: var(--vscode-charts-yellow, #cca700);
  }
  .chip.lvl-warn {
    color: var(--vscode-charts-yellow, #cca700);
  }

  .lvl-info .row-gutter,
  .vol-seg.lvl-info,
  .chip.lvl-info .chip-dot {
    background: var(--vscode-charts-blue, #3794ff);
  }
  .row-level.lvl-info {
    color: var(--vscode-charts-blue, #3794ff);
  }
  .chip.lvl-info {
    color: var(--vscode-charts-blue, #3794ff);
  }

  .lvl-debug .row-gutter,
  .vol-seg.lvl-debug,
  .chip.lvl-debug .chip-dot {
    background: var(--vscode-charts-purple, #b180d7);
  }
  .row-level.lvl-debug {
    color: var(--vscode-charts-purple, #b180d7);
  }
  .chip.lvl-debug {
    color: var(--vscode-charts-purple, #b180d7);
  }

  .lvl-trace .row-gutter,
  .vol-seg.lvl-trace,
  .chip.lvl-trace .chip-dot,
  .lvl-unknown .row-gutter,
  .vol-seg.lvl-unknown,
  .chip.lvl-unknown .chip-dot {
    background: var(--vscode-descriptionForeground);
  }
  .row-level.lvl-trace,
  .row-level.lvl-unknown {
    color: var(--vscode-descriptionForeground);
  }
</style>
