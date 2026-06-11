import type { LogLevel, LogRow } from './types';
import type { ResolvedLokiConfig } from './lokiConfig';

interface LokiStreamResult {
  stream: Record<string, string>;
  values: [string, string][]; // [ "<ns ts>", "<line>" ]
}
interface LokiQueryResponse {
  status: string;
  data?: { resultType: string; result: LokiStreamResult[] };
}

export interface QueryRangeArgs {
  query: string;
  startMs: number;
  endMs: number;
  limit: number;
  direction: 'backward' | 'forward';
}

export interface QueryRangeResult {
  rows: LogRow[];
  /** True when the limit was reached (older lines may be missing). */
  capped: boolean;
}

/** Thin wrapper over the Loki HTTP `query_range` API. Runs on the extension
 * host (Node `fetch`), so the webview never makes cross-origin requests. */
export class LokiClient {
  constructor(private readonly cfg: ResolvedLokiConfig) {}

  get configured(): boolean {
    return this.cfg.configured;
  }

  async queryRange(args: QueryRangeArgs): Promise<QueryRangeResult> {
    if (!this.cfg.configured) throw new Error('No Loki endpoint configured.');

    const url = new URL(`${this.cfg.baseUrl}/loki/api/v1/query_range`);
    url.searchParams.set('query', args.query);
    // Loki wants nanosecond epoch for start/end.
    url.searchParams.set('start', msToNs(args.startMs));
    url.searchParams.set('end', msToNs(args.endMs));
    url.searchParams.set('limit', String(args.limit));
    url.searchParams.set('direction', args.direction);

    const res = await fetch(url, { headers: this.cfg.headers });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Loki ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
    }
    const json = (await res.json()) as LokiQueryResponse;
    if (json.status !== 'success' || !json.data) {
      throw new Error(`Loki returned status "${json.status}".`);
    }
    if (json.data.resultType !== 'streams') {
      // Metric queries (vector/matrix) aren't log lines — surface a clear message.
      throw new Error(`Expected a log query but got "${json.data.resultType}". Remove any aggregation from the query.`);
    }

    const rows = flattenStreams(json.data.result, args.direction);
    return { rows, capped: rows.length >= args.limit };
  }

  /** Test reachability + auth without pulling logs: a trivial label list call. */
  async ping(): Promise<void> {
    if (!this.cfg.configured) throw new Error('No Loki endpoint configured.');
    const url = new URL(`${this.cfg.baseUrl}/loki/api/v1/labels`);
    const res = await fetch(url, { headers: this.cfg.headers });
    if (!res.ok) {
      const body = await safeText(res);
      throw new Error(`Loki ${res.status} ${res.statusText}${body ? `: ${body}` : ''}`);
    }
  }
}

function msToNs(ms: number): string {
  return `${Math.floor(ms)}000000`;
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = (await res.text()).trim();
    return t.length > 300 ? t.slice(0, 299) + '…' : t;
  } catch {
    return '';
  }
}

/** Merge all streams into a single time-ordered list of rows. `backward`
 * (newest first) is Loki's default for log views. */
function flattenStreams(streams: LokiStreamResult[], direction: 'backward' | 'forward'): LogRow[] {
  const rows: LogRow[] = [];
  let seq = 0;
  for (const s of streams) {
    const labels = s.stream ?? {};
    for (const [tsNs, line] of s.values) {
      rows.push(buildRow(tsNs, line, labels, seq++));
    }
  }
  rows.sort((a, b) =>
    direction === 'backward' ? cmpNs(b.tsNs, a.tsNs) : cmpNs(a.tsNs, b.tsNs)
  );
  return rows;
}

/** Compare nanosecond timestamp strings without precision loss (they exceed
 * Number.MAX_SAFE_INTEGER). Equal length here because all are ns epoch. */
function cmpNs(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

function buildRow(tsNs: string, line: string, labels: Record<string, string>, seq: number): LogRow {
  const tsMs = Math.floor(Number(tsNs.slice(0, -6)) || Number(tsNs) / 1e6);
  const fields = parseFields(line);
  const level = detectLevel(labels, fields, line);
  return { id: `${tsNs}:${seq}`, tsNs, tsMs, line, level, labels, fields };
}

/** Parse a line into key/value fields when it's JSON or logfmt. Returns
 * undefined for plain text so the viewer falls back to the raw line. */
export function parseFields(line: string): Record<string, string> | undefined {
  const trimmed = line.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (obj && typeof obj === 'object') {
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(obj)) {
          out[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        return out;
      }
    } catch {
      // not valid JSON — fall through
    }
  }
  // logfmt: key=value key="quoted value" — require at least two pairs to avoid
  // misreading prose containing a single '='.
  const logfmt = matchLogfmt(trimmed);
  if (logfmt && Object.keys(logfmt).length >= 2) return logfmt;
  return undefined;
}

const LOGFMT_RE = /(\w[\w.-]*)=("(?:[^"\\]|\\.)*"|\S+)/g;
function matchLogfmt(s: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  LOGFMT_RE.lastIndex = 0;
  while ((m = LOGFMT_RE.exec(s)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    out[m[1]] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

const LEVEL_LABELS = ['detected_level', 'level', 'severity', 'lvl'];
export function detectLevel(
  labels: Record<string, string>,
  fields: Record<string, string> | undefined,
  line: string
): LogLevel {
  for (const key of LEVEL_LABELS) {
    const v = labels[key] ?? fields?.[key];
    if (v) {
      const norm = normalizeLevel(v);
      if (norm !== 'unknown') return norm;
    }
  }
  // Heuristic scan of the raw line for a level keyword.
  if (/\b(error|err|fatal|panic|exception)\b/i.test(line)) return 'error';
  if (/\b(warn|warning)\b/i.test(line)) return 'warn';
  if (/\b(debug)\b/i.test(line)) return 'debug';
  if (/\b(trace)\b/i.test(line)) return 'trace';
  if (/\b(info|notice)\b/i.test(line)) return 'info';
  return 'unknown';
}

function normalizeLevel(v: string): LogLevel {
  const s = v.toLowerCase();
  if (['error', 'err', 'fatal', 'panic', 'critical', 'crit'].includes(s)) return 'error';
  if (['warn', 'warning'].includes(s)) return 'warn';
  if (['info', 'information', 'notice'].includes(s)) return 'info';
  if (['debug'].includes(s)) return 'debug';
  if (['trace'].includes(s)) return 'trace';
  return 'unknown';
}
