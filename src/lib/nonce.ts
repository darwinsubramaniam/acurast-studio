import { randomBytes } from 'crypto';

/**
 * A CSP-grade nonce: 128 bits from a CSPRNG, base64-encoded. Used for the
 * webview's `script-src 'nonce-…'`. Must NOT use Math.random() — a predictable
 * nonce would let an injected inline script satisfy the CSP.
 */
export function getNonce(): string {
  return randomBytes(16).toString('base64');
}
