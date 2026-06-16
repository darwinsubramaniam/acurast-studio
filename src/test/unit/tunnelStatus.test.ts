import { describe, it, expect } from 'vitest';
import { statusPill, wildcardBadge, txtBadge, stepUiState, type StatusInputs } from '../../studio/webview/tunnel/status';

const base: StatusInputs = {
  verifyStatus: 'idle',
  bothVerified: false,
  verifiedCount: 0,
  hasSuffix: true,
  hasRelays: true,
  hasWallet: true,
  step: 2,
  netLabel: 'Canary',
};

describe('statusPill', () => {
  it('is Draft before a suffix is entered', () => {
    expect(statusPill({ ...base, hasSuffix: false, step: 1 })).toEqual({ label: 'Draft · records not generated', tone: 'draft' });
  });

  it('is Records-ready once on step 2 with relays + wallet', () => {
    expect(statusPill(base)).toEqual({ label: 'Records ready · awaiting DNS verification', tone: 'pending' });
  });

  it('is Verifying while a check is in flight', () => {
    expect(statusPill({ ...base, verifyStatus: 'checking' })).toEqual({ label: 'Verifying… · querying DNS resolvers', tone: 'progress' });
  });

  it('is Live when both records verify', () => {
    expect(statusPill({ ...base, verifyStatus: 'done', bothVerified: true, verifiedCount: 2 })).toEqual({ label: 'Live · verified', tone: 'live' });
  });

  it('is Partially verified with the count when one record is pending', () => {
    expect(statusPill({ ...base, verifyStatus: 'done', verifiedCount: 1 })).toEqual({ label: 'Partially verified · 1 of 2 records', tone: 'warn' });
  });

  it('is a Verification error on lookup failure', () => {
    expect(statusPill({ ...base, verifyStatus: 'error' })).toEqual({ label: 'Verification error', tone: 'error' });
  });

  it('is Blocked when the network has no relays (step 2)', () => {
    expect(statusPill({ ...base, hasRelays: false, netLabel: 'Mainnet' })).toEqual({ label: 'Blocked · no relays for Mainnet', tone: 'error' });
  });

  it('is Action-needed when there is no wallet (step 2)', () => {
    expect(statusPill({ ...base, hasWallet: false })).toEqual({ label: 'Action needed · no wallet to sign with', tone: 'warn' });
  });

  it('verify outcomes outrank the step-2 edge states', () => {
    // A failed verify shows the error even if relays/wallet are also missing.
    expect(statusPill({ ...base, verifyStatus: 'error', hasRelays: false, hasWallet: false }).tone).toBe('error');
    expect(statusPill({ ...base, verifyStatus: 'error', hasRelays: false }).label).toBe('Verification error');
  });

  it('stays Draft on step 1 even with a suffix (edge states are step-2 only)', () => {
    // On step 1 the no-relays edge is not surfaced — it's still a Draft.
    expect(statusPill({ ...base, step: 1, hasRelays: false }).label).toBe('Draft · records not generated');
    expect(statusPill({ ...base, step: 1, hasSuffix: false }).label).toBe('Draft · records not generated');
  });
});

describe('record badges', () => {
  it('wildcard is pending before verify, verified/not-found after', () => {
    expect(wildcardBadge(false, false)).toEqual({ label: 'pending', cls: 'pending' });
    expect(wildcardBadge(true, true)).toEqual({ label: 'verified', cls: 'ok' });
    expect(wildcardBadge(true, false)).toEqual({ label: 'not found', cls: 'miss' });
  });

  it('txt is missing before verify, verified/missing after', () => {
    expect(txtBadge(false, false)).toEqual({ label: 'missing', cls: 'miss' });
    expect(txtBadge(true, true)).toEqual({ label: 'verified', cls: 'ok' });
    expect(txtBadge(true, false)).toEqual({ label: 'missing', cls: 'miss' });
  });
});

describe('stepUiState', () => {
  it('marks earlier steps done and the current one active', () => {
    expect(stepUiState(2, 1, false)).toBe('done');
    expect(stepUiState(2, 2, false)).toBe('active');
    expect(stepUiState(2, 3, false)).toBe('todo');
  });

  it('marks Verify done only once both records verify', () => {
    expect(stepUiState(3, 3, false)).toBe('active');
    expect(stepUiState(3, 3, true)).toBe('done');
  });
});
