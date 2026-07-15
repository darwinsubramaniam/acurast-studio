import { describe, it, expect, beforeAll } from 'vitest';
import { cryptoWaitReady } from '@polkadot/util-crypto';
import { validateAdvertiseArgs, isValidSs58 } from '../../commands/advertiseValidation';

// A valid SS58 address (Alice, generic substrate / prefix-42 format).
const VALID_ADDR = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY';

beforeAll(async () => {
  await cryptoWaitReady();
});

const base = { walletId: 'w1', processor: VALID_ADDR, modules: ['DataInputOutput'], network: 'mainnet' };

describe('isValidSs58', () => {
  it('accepts a well-formed address and rejects garbage', () => {
    expect(isValidSs58(VALID_ADDR)).toBe(true);
    expect(isValidSs58('not-an-address')).toBe(false);
    expect(isValidSs58('')).toBe(false);
    expect(isValidSs58(undefined)).toBe(false);
    expect(isValidSs58(42)).toBe(false);
  });
});

describe('validateAdvertiseArgs', () => {
  it('accepts a sound request', () => {
    expect(validateAdvertiseArgs(base)).toBeUndefined();
    expect(validateAdvertiseArgs({ ...base, network: 'canary', modules: [] })).toBeUndefined();
  });

  it('rejects a missing payload', () => {
    expect(validateAdvertiseArgs(undefined)).toMatch(/No advertisement/);
  });

  it('rejects an unknown network', () => {
    expect(validateAdvertiseArgs({ ...base, network: 'testnet' })).toMatch(/Unknown network/);
  });

  it('rejects a missing wallet id', () => {
    expect(validateAdvertiseArgs({ ...base, walletId: '' })).toMatch(/wallet id/);
  });

  it('rejects an invalid processor address', () => {
    expect(validateAdvertiseArgs({ ...base, processor: 'deadbeef' })).toMatch(/processor address/);
  });

  it('rejects a non-string modules list', () => {
    expect(validateAdvertiseArgs({ ...base, modules: [1, 2] as unknown as string[] })).toMatch(/modules/);
    expect(validateAdvertiseArgs({ ...base, modules: undefined })).toMatch(/modules/);
  });
});
