import { randomBytes, createCipheriv, createDecipheriv, pbkdf2Sync } from 'crypto';

const ALGO = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 12;
const SALT_LEN = 16;
const ITERATIONS = 210_000; // OWASP 2023 recommendation for PBKDF2-SHA256

export interface EncryptedBlob {
  v: 1;
  ct: string;   // ciphertext base64
  iv: string;   // base64
  salt: string; // base64
  tag: string;  // GCM auth tag base64
  iter: number;
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password.normalize('NFKC'), salt, ITERATIONS, KEY_LEN, 'sha256');
}

export function encrypt(plaintext: string, password: string): EncryptedBlob {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    ct: ct.toString('base64'),
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    tag: tag.toString('base64'),
    iter: ITERATIONS,
  };
}

export function decrypt(blob: EncryptedBlob, password: string): string {
  if (blob.v !== 1) throw new Error(`Unsupported blob version: ${blob.v}`);
  const salt = Buffer.from(blob.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const ct = Buffer.from(blob.ct, 'base64');
  const tag = Buffer.from(blob.tag, 'base64');
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  try {
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString('utf8');
  } catch {
    throw new Error('Incorrect password.');
  }
}
