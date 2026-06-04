import { describe, it, expect } from 'vitest';
import { fmtDuration, fmtAgo } from '../../lib/duration';

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
