import { describe, it, expect } from 'vitest';
import type { AcurastProjectConfig } from '@acurast/sdk/types';
import { normalizeMinProcessorVersions } from '../../sdk/configCompat';

// Minimal config factory — only the fields the normalizer reads matter.
function cfg(minProcessorVersions?: AcurastProjectConfig['minProcessorVersions']): AcurastProjectConfig {
  return { minProcessorVersions } as AcurastProjectConfig;
}

describe('normalizeMinProcessorVersions', () => {
  it('coerces a quoted numeric android version to a number', () => {
    const out = normalizeMinProcessorVersions(cfg({ android: '122' }));
    expect(out.minProcessorVersions).toEqual({ android: 122, ios: undefined });
    expect(typeof out.minProcessorVersions!.android).toBe('number');
  });

  it('coerces quoted numeric values for both platforms', () => {
    const out = normalizeMinProcessorVersions(cfg({ android: '122', ios: '14' }));
    expect(out.minProcessorVersions).toEqual({ android: 122, ios: 14 });
  });

  it('leaves real numbers untouched and returns the same reference', () => {
    const input = cfg({ android: 122 });
    const out = normalizeMinProcessorVersions(input);
    expect(out).toBe(input);
  });

  it('leaves non-numeric version names (e.g. "1.26.0") for the SDK to resolve', () => {
    const out = normalizeMinProcessorVersions(cfg({ android: '1.26.0' }));
    expect(out.minProcessorVersions!.android).toBe('1.26.0');
  });

  it('handles surrounding whitespace in numeric strings', () => {
    const out = normalizeMinProcessorVersions(cfg({ android: ' 122 ' }));
    expect(out.minProcessorVersions!.android).toBe(122);
  });

  it('returns the same reference when minProcessorVersions is absent', () => {
    const input = cfg(undefined);
    expect(normalizeMinProcessorVersions(input)).toBe(input);
  });

  it('does not mutate the input config', () => {
    const input = cfg({ android: '122' });
    normalizeMinProcessorVersions(input);
    expect(input.minProcessorVersions!.android).toBe('122');
  });
});
