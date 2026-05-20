import { describe, it, expect } from 'vitest';
import { encrypt, decrypt } from '../../wallet/crypto';

describe('crypto', () => {
  describe('encrypt / decrypt round-trip', () => {
    it('decrypts back to the original plaintext', () => {
      const blob = encrypt('my secret mnemonic', 'password123');
      expect(decrypt(blob, 'password123')).toBe('my secret mnemonic');
    });

    it('works with an empty string plaintext', () => {
      const blob = encrypt('', 'pw');
      expect(decrypt(blob, 'pw')).toBe('');
    });

    it('works with unicode plaintext and password', () => {
      const blob = encrypt('こんにちは', 'pässwörD');
      expect(decrypt(blob, 'pässwörD')).toBe('こんにちは');
    });
  });

  describe('encrypt', () => {
    it('produces a v:1 blob', () => {
      const blob = encrypt('test', 'pw');
      expect(blob.v).toBe(1);
    });

    it('produces unique IV and salt on each call', () => {
      const a = encrypt('test', 'pw');
      const b = encrypt('test', 'pw');
      expect(a.iv).not.toBe(b.iv);
      expect(a.salt).not.toBe(b.salt);
    });

    it('stores the OWASP iteration count', () => {
      const blob = encrypt('test', 'pw');
      expect(blob.iter).toBe(210_000);
    });
  });

  describe('decrypt', () => {
    it('throws on wrong password', () => {
      const blob = encrypt('secret', 'correct');
      expect(() => decrypt(blob, 'wrong')).toThrow('Incorrect password.');
    });

    it('throws on unsupported blob version', () => {
      const blob = { ...encrypt('x', 'pw'), v: 2 as unknown as 1 };
      expect(() => decrypt(blob, 'pw')).toThrow('Unsupported blob version: 2');
    });
  });
});
