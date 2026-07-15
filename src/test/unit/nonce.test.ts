import { describe, it, expect } from 'vitest';
import { getNonce } from '../../lib/nonce';

describe('getNonce', () => {
  it('returns a non-empty base64 string of at least 128 bits of entropy', () => {
    const nonce = getNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // 16 random bytes → 24 base64 chars (with padding).
    expect(Buffer.from(nonce, 'base64').length).toBe(16);
  });

  it('produces a fresh value on every call (not a constant)', () => {
    const values = new Set(Array.from({ length: 100 }, () => getNonce()));
    expect(values.size).toBe(100);
  });
});
