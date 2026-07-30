import { describe, it, expect } from 'vitest';
import type { AcurastProjectConfig } from '@acurast/sdk/types';
import {
  resolveMinProcessorVersionsWith,
  UnknownProcessorVersionError,
  type VersionResolver,
} from '../../sdk/configCompat';

// Minimal config factory — only the fields the resolver reads matter.
function cfg(minProcessorVersions?: AcurastProjectConfig['minProcessorVersions']): AcurastProjectConfig {
  return { minProcessorVersions } as AcurastProjectConfig;
}

// Stand-in for the live table: enough of the real android map to cover the
// duplicate-name case (123 and 124 are both 1.25.1 upstream).
const ANDROID: Record<string, number> = {
  '1.25.1': 123,
  '1.26.0-rc1': 122,
  '1.26.0': 128,
};
const IOS: Record<string, number> = { '2.0.0': 7 };

function resolver(overrides: Partial<VersionResolver> = {}): VersionResolver {
  return {
    lookup: (platform, name) => (platform === 'android' ? ANDROID : IOS)[name],
    suggest: (platform) => (platform === 'android' ? Object.keys(ANDROID) : Object.keys(IOS)),
    stale: false,
    ...overrides,
  };
}

describe('resolveMinProcessorVersionsWith', () => {
  it('resolves a readable android version name to its build number', () => {
    const out = resolveMinProcessorVersionsWith(cfg({ android: '1.26.0' }), resolver());
    expect(out.minProcessorVersions).toEqual({ android: 128, ios: undefined });
    expect(typeof out.minProcessorVersions!.android).toBe('number');
  });

  it('resolves both platforms', () => {
    const out = resolveMinProcessorVersionsWith(cfg({ android: '1.25.1', ios: '2.0.0' }), resolver());
    expect(out.minProcessorVersions).toEqual({ android: 123, ios: 7 });
  });

  it('coerces a quoted build number without consulting the table', () => {
    const out = resolveMinProcessorVersionsWith(
      cfg({ android: '122' }),
      resolver({ lookup: () => undefined })
    );
    expect(out.minProcessorVersions!.android).toBe(122);
  });

  it('handles surrounding whitespace in a quoted build number', () => {
    const out = resolveMinProcessorVersionsWith(cfg({ android: ' 122 ' }), resolver());
    expect(out.minProcessorVersions!.android).toBe(122);
  });

  it('trims whitespace around a version name before lookup', () => {
    const out = resolveMinProcessorVersionsWith(cfg({ android: ' 1.26.0 ' }), resolver());
    expect(out.minProcessorVersions!.android).toBe(128);
  });

  it('treats an empty string as unset', () => {
    const out = resolveMinProcessorVersionsWith(cfg({ android: '' }), resolver());
    expect(out.minProcessorVersions!.android).toBeUndefined();
  });

  it('leaves real build numbers untouched and returns the same reference', () => {
    const input = cfg({ android: 122 });
    expect(resolveMinProcessorVersionsWith(input, resolver())).toBe(input);
  });

  it('returns the same reference when minProcessorVersions is absent', () => {
    const input = cfg(undefined);
    expect(resolveMinProcessorVersionsWith(input, resolver())).toBe(input);
  });

  it('does not mutate the input config', () => {
    const input = cfg({ android: '1.26.0' });
    resolveMinProcessorVersionsWith(input, resolver());
    expect(input.minProcessorVersions!.android).toBe('1.26.0');
  });

  it('throws a named error listing known versions for an unknown name', () => {
    expect(() => resolveMinProcessorVersionsWith(cfg({ android: '9.9.9' }), resolver()))
      .toThrow(UnknownProcessorVersionError);

    try {
      resolveMinProcessorVersionsWith(cfg({ android: '9.9.9' }), resolver());
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain('Unknown Android processor version "9.9.9"');
      expect(message).toContain('minProcessorVersions.android');
      expect(message).toContain('1.26.0');
      expect(message).not.toContain('could not be reached');
    }
  });

  it('says the version list may be incomplete when the live fetch failed', () => {
    try {
      resolveMinProcessorVersionsWith(cfg({ android: '9.9.9' }), resolver({ stale: true }));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('could not be reached');
    }
  });

  it('reports the iOS platform label for an unknown iOS version', () => {
    expect(() => resolveMinProcessorVersionsWith(cfg({ ios: '9.9.9' }), resolver()))
      .toThrow(/Unknown iOS processor version/);
  });
});
