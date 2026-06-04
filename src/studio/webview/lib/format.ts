import { DateTime, Duration } from 'luxon';

/** Planck (÷ 1e12) → ACU string, trailing zeros stripped. */
export function planckToAcu(planck: string | null | undefined): string {
  if (!planck) return '—';
  const n = parseFloat(planck) / 1e12;
  if (!Number.isFinite(n) || n === 0) return '—';
  return n.toFixed(6).replace(/\.?0+$/, '') || '0';
}

/** Planck → fiat number (null if input is missing or non-finite). */
export function planckToFiat(planck: string | null | undefined, rate: number): number | null {
  if (!planck) return null;
  const acu = parseFloat(planck) / 1e12;
  if (!Number.isFinite(acu)) return null;
  return acu * rate;
}

/** ACU/CACU string (already in token units) → fiat number (null if missing or non-finite). */
export function acuToFiat(acu: string | null | undefined, rate: number): number | null {
  if (!acu) return null;
  const n = parseFloat(acu);
  if (!Number.isFinite(n)) return null;
  return n * rate;
}

/** Format a fiat amount with adaptive decimal places and a currency sign/symbol. */
export function fmtFiat(amount: number, sign: string, symbol: string): string {
  const digits = amount >= 100 ? 2 : amount >= 1 ? 3 : 5;
  const value = amount.toFixed(digits);
  return sign ? `${sign}${value} ${symbol}` : `${value} ${symbol}`;
}

/** ms epoch → locale date+time string, '—' for falsy input. */
export function fmtTimestamp(ts: number): string {
  if (!ts) return '—';
  return DateTime.fromMillis(ts).toLocaleString(DateTime.DATETIME_SHORT);
}

/** ms epoch → HH:MM:SS string (for live event logs). */
export function fmtClock(ts: number): string {
  return DateTime.fromMillis(ts).toFormat('HH:mm:ss');
}

/** Truncate a string to n chars on each side with an ellipsis in the middle. */
export function truncate(s: string | undefined, n = 10): string {
  if (!s) return '—';
  if (s.length <= n * 2 + 1) return s;
  return s.slice(0, n) + '…' + s.slice(-6);
}

/** ms epoch → relative time like '3 minutes ago', '2 hours ago'; '—' for falsy. */
export function fmtRelative(ts: number): string {
  if (!ts) return '—';
  return DateTime.fromMillis(ts).toRelative() ?? '—';
}

/**
 * Millisecond duration → compact human-readable string, largest unit first.
 * Sub-second shows as `500ms`; otherwise the two most-significant non-zero
 * units are kept: `30s`, `1m 30s`, `2h 5m`, `1d 3h`. '—' for empty/invalid.
 * The stored value stays in ms — this is display-only.
 */
export function fmtMs(ms: string | number): string {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return `${Math.round(n)}ms`;
  // Round to whole seconds so 59 999 ms reads as '1m', not '60s'.
  const dur = Duration.fromMillis(Math.round(n / 1000) * 1000)
    .shiftTo('days', 'hours', 'minutes', 'seconds');
  const parts: string[] = [];
  if (dur.days) parts.push(`${dur.days}d`);
  if (dur.hours) parts.push(`${dur.hours}h`);
  if (dur.minutes) parts.push(`${dur.minutes}m`);
  if (dur.seconds) parts.push(`${dur.seconds}s`);
  return parts.slice(0, 2).join(' ') || '0s';
}
