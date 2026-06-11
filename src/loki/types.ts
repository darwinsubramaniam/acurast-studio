// Shared types for the Live Monitoring / Loki log viewer feature. Imported by
// BOTH the extension host (`src/loki/*`) and the log-viewer webview
// (`src/studio/logviewer/*`). Keep this dependency-free so both bundles can use
// it. The side-panel ↔ host messages live in `src/studio/types.ts`; this file
// only carries the log-viewer panel's own message contract plus the row shape.

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'unknown';

/** A single decoded Loki log line, enriched with a parsed level + structured
 * fields when the line is JSON or logfmt. */
export interface LogRow {
  /** Stable key for keyed `{#each}` — `${tsNs}:${seq}` (seq disambiguates lines
   * that share a nanosecond timestamp). */
  id: string;
  /** Original nanosecond-epoch timestamp string from Loki. */
  tsNs: string;
  /** Millisecond epoch, derived from tsNs for display/formatting. */
  tsMs: number;
  /** Raw log line text. */
  line: string;
  /** Severity, from a level/severity label or parsed out of the line. */
  level: LogLevel;
  /** Stream labels Loki attached to this line. */
  labels: Record<string, string>;
  /** Parsed key/value fields when the line is JSON or logfmt; undefined otherwise. */
  fields?: Record<string, string>;
}

/** Inclusive description of what the viewer should query. The LogQL is resolved
 * host-side from the job scope but remains editable in the viewer. */
export interface LokiQueryParams {
  network: string;
  /** Job origin (consumer address) — present when scoped to a deployment. */
  origin?: string;
  /** Job local id — present when scoped to a deployment. */
  localId?: number;
  /** Human label for the panel title, e.g. project name or `Job #42`. */
  title: string;
  /** Resolved LogQL selector/pipeline. */
  query: string;
  startMs: number;
  endMs: number;
  limit: number;
  direction: 'backward' | 'forward';
}

/** Summary stats returned alongside a query result. */
export interface LokiQueryStats {
  /** Total rows returned (after the limit). */
  returned: number;
  /** Wall-clock ms the host spent fetching. */
  elapsedMs: number;
  /** True when the limit was hit and older lines may be missing. */
  capped: boolean;
}

// ── Host → viewer messages ─────────────────────────────────────────────────────
export interface LVInitMsg {
  type: 'lv.init';
  params: LokiQueryParams;
  /** Loki readiness so the viewer can show a "configure endpoint" notice. */
  endpointConfigured: boolean;
  endpointUrl: string;
}
export interface LVLoadingMsg { type: 'lv.loading'; tail?: boolean; }
export interface LVResultMsg {
  type: 'lv.result';
  rows: LogRow[];
  stats: LokiQueryStats;
  /** True for incremental tail batches appended to the existing list. */
  append?: boolean;
  /** Echoes the params actually executed (query/time range may have changed). */
  params: LokiQueryParams;
}
export interface LVErrorMsg { type: 'lv.error'; message: string; }
export interface LVTailStateMsg { type: 'lv.tailState'; active: boolean; }

export type LVOutMsg = LVInitMsg | LVLoadingMsg | LVResultMsg | LVErrorMsg | LVTailStateMsg;

// ── Viewer → host messages ─────────────────────────────────────────────────────
export interface LVReadyMsg { type: 'lv.ready'; }
export interface LVQueryMsg { type: 'lv.query'; params: LokiQueryParams; }
export interface LVTailMsg { type: 'lv.tail'; active: boolean; params: LokiQueryParams; }
export interface LVCopyMsg { type: 'lv.copy'; text: string; }
export interface LVConfigureMsg { type: 'lv.configure'; }

export type LVInMsg = LVReadyMsg | LVQueryMsg | LVTailMsg | LVCopyMsg | LVConfigureMsg;
