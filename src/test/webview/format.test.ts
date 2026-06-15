import { describe, it, expect } from 'vitest';
import { fmtCountdown } from '../../studio/webview/lib/format';

describe('fmtCountdown', () => {
  it('renders a future remaining span as "in <duration>"', () => {
    expect(fmtCountdown(90_000)).toBe('in 1m 30s');
    expect(fmtCountdown(5_000)).toBe('in 5s');
  });

  it('renders "running" once the remaining time is zero or negative', () => {
    expect(fmtCountdown(0)).toBe('running');
    expect(fmtCountdown(-12_345)).toBe('running');
  });
});
