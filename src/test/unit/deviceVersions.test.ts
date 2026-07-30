import { describe, it, expect, beforeAll } from 'vitest';
import { deviceVersions } from '@acurast/sdk/chain';
import { lookupBuildNumber, recentVersionNames } from '../../sdk/deviceVersions';

// Seed the SDK's module-level table with the shape the live versions.json has,
// including the duplicate name upstream ships (123 and 124 are both 1.25.1).
// Vitest isolates test files, so this stays local to this suite.
beforeAll(() => {
  const android = deviceVersions.get(0)!;
  android.set(122, '1.26.0-rc1');
  android.set(123, '1.25.1');
  android.set(124, '1.25.1');
  android.set(128, '1.26.0');
  android.set(129, '1.27.0-rc1');
});

describe('lookupBuildNumber', () => {
  it('resolves a version name to its build number', () => {
    expect(lookupBuildNumber('android', '1.26.0')).toBe(128);
  });

  it('picks the lowest build when one version name spans several builds', () => {
    // A processor on build 123 IS running 1.25.1, so a `>= 1.25.1` minimum
    // must not exclude it.
    expect(lookupBuildNumber('android', '1.25.1')).toBe(123);
  });

  it('returns undefined for an unknown name', () => {
    expect(lookupBuildNumber('android', '9.9.9')).toBeUndefined();
  });

  it('does not resolve android names against the iOS table', () => {
    expect(lookupBuildNumber('ios', '1.26.0')).toBeUndefined();
  });
});

describe('recentVersionNames', () => {
  it('lists names newest build first, without duplicates', () => {
    const names = recentVersionNames('android', 4);
    expect(names).toEqual(['1.27.0-rc1', '1.26.0', '1.25.1', '1.26.0-rc1']);
  });

  it('honours the limit', () => {
    expect(recentVersionNames('android', 2)).toHaveLength(2);
  });
});
