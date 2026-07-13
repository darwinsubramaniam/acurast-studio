// Shared, pure, dependency-free time formatters used by BOTH bundles: the
// extension host (`src/lib/diagnosis.ts`) and the webview
// (`src/studio/webview/lib/format.ts` re-exports them). Built on plain
// arithmetic + the native Intl APIs only — no luxon/dayjs.

interface TimeUnit {
  /** Native Intl.RelativeTimeFormat unit name — used by fmtAgo. */
  rtf: Intl.RelativeTimeFormatUnit;
  /** Compact abbreviation for fmtDuration. `m` = minute, `mo` = month. */
  abbr: string;
  /** Size in milliseconds. Months/years use the 30-day / 365-day conventions. */
  ms: number;
  /**
   * Whether fmtDuration emits this unit. Weeks read awkwardly between months and
   * days in a `5mo 16d`-style span, so they're skipped there — but fmtAgo keeps
   * them so it can say "last week" / "2 weeks ago".
   */
  span: boolean;
}

// One canonical table, largest unit first. fmtDuration walks `span` units by
// `abbr`; fmtAgo walks all units by `rtf`.
const UNITS: TimeUnit[] = [
  { rtf: 'year',   abbr: 'y',  ms: 31_536_000_000, span: true  },
  { rtf: 'month',  abbr: 'mo', ms:  2_592_000_000, span: true  },
  { rtf: 'week',   abbr: 'w',  ms:    604_800_000, span: false },
  { rtf: 'day',    abbr: 'd',  ms:     86_400_000, span: true  },
  { rtf: 'hour',   abbr: 'h',  ms:      3_600_000, span: true  },
  { rtf: 'minute', abbr: 'm',  ms:         60_000, span: true  },
  { rtf: 'second', abbr: 's',  ms:          1_000, span: true  },
];

/**
 * Millisecond *duration* (a span, not relative to now) → compact string, largest
 * unit first, the two most-significant non-zero units: `500ms`, `30s`, `1m 30s`,
 * `2h 5m`, `1d 3h`, `5mo 16d`, `2y 3mo`. '—' for empty/invalid/non-positive
 * input. For relative "X ago" labels (localized, "ago"/"in" phrasing), use
 * {@link fmtAgo}.
 */
export function fmtDuration(ms: string | number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  // Round to whole seconds so 59 999 ms reads as '1m', not '60s', then break
  // down across the unit cascade with plain arithmetic.
  let rem = Math.round(n / 1000) * 1000;
  const parts: string[] = [];
  for (const u of UNITS) {
    if (!u.span) continue;
    const v = Math.floor(rem / u.ms);
    if (v) { parts.push(`${v}${u.abbr}`); rem -= v * u.ms; }
  }
  return parts.slice(0, 2).join(' ') || '0s';
}

// Unit spellings accepted by parseDuration → their size in ms. Every
// fmtDuration abbreviation is here, so fmtDuration output always parses back.
const byAbbr = Object.fromEntries(UNITS.map((u) => [u.abbr, u.ms]));
const PARSE_UNITS: Record<string, number> = {
  ms: 1, msec: 1, msecs: 1, millisecond: 1, milliseconds: 1,
  s: byAbbr.s, sec: byAbbr.s, secs: byAbbr.s, second: byAbbr.s, seconds: byAbbr.s,
  m: byAbbr.m, min: byAbbr.m, mins: byAbbr.m, minute: byAbbr.m, minutes: byAbbr.m,
  h: byAbbr.h, hr: byAbbr.h, hrs: byAbbr.h, hour: byAbbr.h, hours: byAbbr.h,
  d: byAbbr.d, day: byAbbr.d, days: byAbbr.d,
  w: byAbbr.w, wk: byAbbr.w, wks: byAbbr.w, week: byAbbr.w, weeks: byAbbr.w,
  mo: byAbbr.mo, mos: byAbbr.mo, month: byAbbr.mo, months: byAbbr.mo,
  y: byAbbr.y, yr: byAbbr.y, yrs: byAbbr.y, year: byAbbr.y, years: byAbbr.y,
};

/**
 * The reverse of {@link fmtDuration}: human-readable duration → milliseconds.
 * Accepts unit tokens in any casing, with or without spaces/commas between them
 * (`1d 12h`, `1D12h`, `2 hours, 30 minutes`, `1.5h`, `500ms`) plus a bare
 * number, which is taken as already-milliseconds. Returns `null` when any part
 * of the input fails to parse — no silent partial results.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  // A bare number is already ms.
  if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));
  const token = /^(\d+(?:\.\d+)?)\s*([a-z]+)[\s,]*/;
  let total = 0;
  let rest = text;
  while (rest) {
    const m = token.exec(rest);
    const unit = m ? PARSE_UNITS[m[2]] : undefined;
    if (!m || unit === undefined) return null;
    total += Number(m[1]) * unit;
    rest = rest.slice(m[0].length);
  }
  return Math.round(total);
}

const RTF = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/**
 * Relative-time label for a millisecond delta, via the native
 * `Intl.RelativeTimeFormat` — localized and scaling seconds → years (unlike
 * {@link fmtDuration}, which uses compact abbreviations). Positive `deltaMs` =
 * in the past: `fmtAgo(now - endTime)` → "2 hours ago" / "3 months ago" /
 * "last week". Negative = future ("in 5 minutes"). The "ago"/"in" phrasing is
 * baked in — don't append " ago" at the call site.
 */
export function fmtAgo(deltaMs: number): string {
  const past = deltaMs >= 0;
  const abs = Math.abs(deltaMs);
  for (const u of UNITS) {
    if (abs >= u.ms || u.rtf === 'second') {
      const value = Math.round(abs / u.ms);
      return RTF.format(past ? -value : value, u.rtf);
    }
  }
  return RTF.format(0, 'second');
}
