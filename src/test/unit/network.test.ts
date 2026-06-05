import { describe, it, expect } from 'vitest';
import { networkLabel, isNetworkMismatch } from '../../lib/network';

describe('networkLabel', () => {
  it('capitalizes the first letter', () => {
    expect(networkLabel('mainnet')).toBe('Mainnet');
    expect(networkLabel('canary')).toBe('Canary');
  });

  it('returns an empty string unchanged', () => {
    expect(networkLabel('')).toBe('');
  });
});

describe('isNetworkMismatch', () => {
  it('is true when both networks are set and differ', () => {
    expect(isNetworkMismatch('mainnet', 'canary')).toBe(true);
  });

  it('is false when the networks are equal', () => {
    expect(isNetworkMismatch('canary', 'canary')).toBe(false);
  });

  it('is false when the project network is null or undefined (no opinion)', () => {
    expect(isNetworkMismatch(null, 'mainnet')).toBe(false);
    expect(isNetworkMismatch(undefined, 'mainnet')).toBe(false);
  });

  it('is false when the project network is an empty string', () => {
    // Unified handling: a falsy project network is "no opinion", never a mismatch.
    expect(isNetworkMismatch('', 'mainnet')).toBe(false);
  });

  it('compares case-insensitively (hand-written "Mainnet" is not a mismatch)', () => {
    expect(isNetworkMismatch('Mainnet', 'mainnet')).toBe(false);
    expect(isNetworkMismatch('CANARY', 'canary')).toBe(false);
    expect(isNetworkMismatch('Mainnet', 'canary')).toBe(true);
  });
});
