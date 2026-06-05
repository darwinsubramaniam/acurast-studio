import { describe, it, expect } from 'vitest';
import { randomBytes, createCipheriv, pbkdf2Sync } from 'crypto';
import { encrypt, decrypt, type EncryptedBlob } from '../../wallet/crypto';

/** Encrypt with an explicit PBKDF2 iteration count (mirrors crypto.ts but parameterized). */
function encryptWithIter(plaintext: string, password: string, iterations: number): EncryptedBlob {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(password.normalize('NFKC'), salt, iterations, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    v: 1,
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    iter: iterations,
  };
}

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

    it('honors the blob\'s stored iter, not the current ITERATIONS constant', () => {
      // A blob encrypted with a different iteration count must still decrypt —
      // otherwise bumping ITERATIONS would brick every existing wallet.
      const blob = encryptWithIter('legacy mnemonic', 'pw', 1_000);
      expect(blob.iter).not.toBe(210_000);
      expect(decrypt(blob, 'pw')).toBe('legacy mnemonic');
    });

    it('fails to decrypt if blob.iter is altered after encryption', () => {
      // Tampering with iter changes the derived key → GCM auth failure.
      const blob = encrypt('secret', 'pw');
      expect(() => decrypt({ ...blob, iter: blob.iter + 1 }, 'pw')).toThrow('Incorrect password.');
    });
  });
});
