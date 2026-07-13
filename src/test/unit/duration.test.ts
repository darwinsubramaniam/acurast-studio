import { describe, it, expect } from 'vitest';
import { fmtDuration, fmtAgo, parseDuration } from '../../lib/duration';

const SEC = 1_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONTH = 2_592_000_000;
const YEAR = 31_536_000_000;

describe('fmtDuration', () => {
  it('returns "—" for empty/invalid/non-positive input', () => {
    expect(fmtDuration(0)).toBe('—');
    expect(fmtDuration(-5)).toBe('—');
    expect(fmtDuration(NaN)).toBe('—');
  });

  it('shows sub-second durations in ms', () => {
    expect(fmtDuration(500)).toBe('500ms');
  });

  it('keeps the two most-significant non-zero units', () => {
    expect(fmtDuration(30 * SEC)).toBe('30s');
    expect(fmtDuration(90 * SEC)).toBe('1m 30s');
    expect(fmtDuration(2 * HOUR + 5 * MIN)).toBe('2h 5m');
    expect(fmtDuration(27 * HOUR)).toBe('1d 3h');
  });

  it('rounds to whole seconds so 59 999 ms reads as 1m', () => {
    expect(fmtDuration(59_999)).toBe('1m');
  });

  it('scales large spans into months and years', () => {
    // 166d 16h — the value seen in the project-settings echo — reads in months.
    expect(fmtDuration(166 * DAY + 16 * HOUR)).toBe('5mo 16d');
    expect(fmtDuration(45 * DAY)).toBe('1mo 15d');
    expect(fmtDuration(2 * YEAR + 3 * MONTH)).toBe('2y 3mo');
  });

  it('does NOT emit weeks (months → days directly) for a clean span', () => {
    expect(fmtDuration(10 * DAY)).toBe('10d');
  });
});

describe('fmtAgo', () => {
  it('formats past deltas with "ago", scaling up to years', () => {
    expect(fmtAgo(2 * HOUR)).toBe('2 hours ago');
    expect(fmtAgo(2 * YEAR)).toBe('2 years ago');
    expect(fmtAgo(45 * SEC)).toBe('45 seconds ago');
  });

  it('formats months ago (the case fmtDuration could not reach)', () => {
    expect(fmtAgo(MONTH)).toBe('last month'); // 1 month, numeric: auto
    expect(fmtAgo(3 * MONTH)).toBe('3 months ago');
    expect(fmtAgo(11 * MONTH)).toBe('11 months ago');
    // ~6 weeks rounds to roughly 1 month, still phrased in months not weeks
    expect(fmtAgo(45 * DAY)).toBe('2 months ago');
  });

  it('uses natural phrasing for the ±1 / 0 boundary (numeric: auto)', () => {
    expect(fmtAgo(DAY)).toBe('yesterday');
    expect(fmtAgo(0)).toBe('now');
  });

  it('formats future deltas with "in"', () => {
    expect(fmtAgo(-5 * MIN)).toBe('in 5 minutes');
  });
});

describe('parseDuration', () => {
  it('parses a bare number as already-milliseconds', () => {
    expect(parseDuration('86400000')).toBe(DAY);
    expect(parseDuration('500')).toBe(500);
  });

  it('parses single units across the supported spelling families', () => {
    expect(parseDuration('30s')).toBe(30 * SEC);
    expect(parseDuration('90m')).toBe(90 * MIN);
    expect(parseDuration('1d')).toBe(DAY);
    expect(parseDuration('2 hours')).toBe(2 * HOUR);
    expect(parseDuration('3 weeks')).toBe(3 * 604_800_000);
    expect(parseDuration('1mo')).toBe(MONTH);
    expect(parseDuration('1y')).toBe(YEAR);
    expect(parseDuration('250ms')).toBe(250);
  });

  it('combines units, case-insensitively, with or without separators', () => {
    expect(parseDuration('1d 12h')).toBe(DAY + 12 * HOUR);
    expect(parseDuration('1D12H')).toBe(DAY + 12 * HOUR);
    expect(parseDuration('2 hours, 30 minutes')).toBe(2 * HOUR + 30 * MIN);
    expect(parseDuration('1m 30s')).toBe(90 * SEC);
  });

  it('accepts decimal values', () => {
    expect(parseDuration('1.5h')).toBe(90 * MIN);
    expect(parseDuration('0.5s')).toBe(500);
  });

  it('round-trips fmtDuration output (the converter prefill relies on this)', () => {
    for (const ms of [500, 30 * SEC, 90 * SEC, 2 * HOUR + 5 * MIN, DAY, 27 * HOUR]) {
      expect(parseDuration(fmtDuration(ms))).toBe(ms);
    }
  });

  it('parses "0s" (a zero delay is a valid field value)', () => {
    expect(parseDuration('0s')).toBe(0);
  });

  it('rejects anything it cannot fully parse — no silent partial results', () => {
    expect(parseDuration('')).toBeNull();
    expect(parseDuration('abc')).toBeNull();
    expect(parseDuration('5 parsecs')).toBeNull();
    expect(parseDuration('1h banana')).toBeNull();
    expect(parseDuration('h1')).toBeNull();
    expect(parseDuration('1.2.3h')).toBeNull();
    expect(parseDuration('-5s')).toBeNull();
  });
});
