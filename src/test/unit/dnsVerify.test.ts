import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockResolve4, mockResolveTxt } = vi.hoisted(() => ({
  mockResolve4: vi.fn(),
  mockResolveTxt: vi.fn(),
}));

vi.mock('dns', () => ({
  promises: { resolve4: mockResolve4, resolveTxt: mockResolveTxt },
}));

import { verifyTunnelDns } from '../../tunnel/dnsVerify';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('verifyTunnelDns', () => {
  it('queries the wildcard probe and _acu TXT under the normalized suffix', async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolveTxt.mockResolvedValue([]);
    await verifyTunnelDns('Tunnel.Example.com.', [], []);
    expect(mockResolve4).toHaveBeenCalledWith('acurast-studio-probe.tunnel.example.com');
    expect(mockResolveTxt).toHaveBeenCalledWith('_acu.tunnel.example.com');
  });

  it('marks the wildcard ok when an expected relay IP resolves and finds the TXT', async () => {
    mockResolve4.mockResolvedValue(['57.129.64.128', '1.1.1.1']);
    mockResolveTxt.mockResolvedValue([['abc123'], ['def456']]);
    const res = await verifyTunnelDns(
      'tunnel.example.com',
      ['57.129.64.128'],
      [{ walletId: 'w1', value: 'def456' }],
    );
    expect(res.wildcard.ok).toBe(true);
    expect(res.wildcard.resolvedIps).toContain('57.129.64.128');
    expect(res.txtFound).toEqual(['abc123', 'def456']);
    expect(res.verifiedWalletIds).toEqual(['w1']);
    expect(res.error).toBeUndefined();
  });

  it('joins multi-chunk TXT records before matching', async () => {
    mockResolve4.mockResolvedValue([]);
    mockResolveTxt.mockResolvedValue([['part1', 'part2']]);
    const res = await verifyTunnelDns('x.example.com', [], [{ walletId: 'w1', value: 'part1part2' }]);
    expect(res.txtFound).toEqual(['part1part2']);
    expect(res.verifiedWalletIds).toEqual(['w1']);
  });

  it('marks the wildcard not ok when no expected IP resolves', async () => {
    mockResolve4.mockResolvedValue(['9.9.9.9']);
    mockResolveTxt.mockResolvedValue([]);
    const res = await verifyTunnelDns('x.example.com', ['57.129.64.128'], []);
    expect(res.wildcard.ok).toBe(false);
    expect(res.wildcard.resolvedIps).toEqual(['9.9.9.9']);
  });

  it('treats a missing record (ENOTFOUND) as empty, not an error', async () => {
    const noRec = Object.assign(new Error('not found'), { code: 'ENOTFOUND' });
    mockResolve4.mockRejectedValue(noRec);
    mockResolveTxt.mockRejectedValue(noRec);
    const res = await verifyTunnelDns('missing.example.com', ['1.2.3.4'], [{ walletId: 'w1', value: 'v' }]);
    expect(res.error).toBeUndefined();
    expect(res.wildcard.resolvedIps).toEqual([]);
    expect(res.wildcard.ok).toBe(false);
    expect(res.txtFound).toEqual([]);
    expect(res.verifiedWalletIds).toEqual([]);
  });

  it('surfaces unexpected resolver errors', async () => {
    mockResolve4.mockRejectedValue(Object.assign(new Error('SERVFAIL'), { code: 'SERVFAIL' }));
    mockResolveTxt.mockResolvedValue([]);
    const res = await verifyTunnelDns('x.example.com', ['1.2.3.4'], []);
    expect(res.error).toMatch(/SERVFAIL/);
    expect(res.verifiedWalletIds).toEqual([]);
  });
});
