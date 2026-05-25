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
  return new Date(ts).toLocaleString();
}

/** ms epoch → HH:MM:SS string (for live event logs). */
export function fmtClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Truncate a string to n chars on each side with an ellipsis in the middle. */
export function truncate(s: string | undefined, n = 10): string {
  if (!s) return '—';
  if (s.length <= n * 2 + 1) return s;
  return s.slice(0, n) + '…' + s.slice(-6);
}

/** Millisecond duration → human-readable '30s', '5m', '2h'. */
export function fmtMs(ms: string | number): string {
  const n = Number(ms);
  if (!n) return '—';
  if (n < 60_000) return `${Math.round(n / 1000)}s`;
  if (n < 3_600_000) return `${Math.round(n / 60_000)}m`;
  return `${Math.round(n / 3_600_000)}h`;
}
