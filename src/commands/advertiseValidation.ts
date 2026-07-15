// Standalone (no vscode / SDK imports) so it can be unit-tested directly. The
// advertise request arrives over the webview postMessage channel and drives a
// wallet-signed `advertiseFor` extrinsic, so its shape/format must be validated
// before anything is signed.
import { decodeAddress } from '@polkadot/util-crypto';

export interface AdvertiseArgsShape {
  walletId: string;
  processor: string;
  modules: string[];
  network: string;
}

/** True when `addr` decodes as a valid SS58 address (checksum verified). */
export function isValidSs58(addr: unknown): boolean {
  if (typeof addr !== 'string' || !addr) return false;
  try {
    decodeAddress(addr);
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate the advertise request. Returns a human-readable error message, or
 * undefined when the args are sound.
 */
export function validateAdvertiseArgs(args: Partial<AdvertiseArgsShape> | undefined): string | undefined {
  if (!args) return 'No advertisement arguments provided.';
  if (args.network !== 'mainnet' && args.network !== 'canary') {
    return `Unknown network "${String(args.network)}".`;
  }
  if (typeof args.walletId !== 'string' || !args.walletId) return 'Missing manager wallet id.';
  if (!isValidSs58(args.processor)) return 'Invalid processor address.';
  if (!Array.isArray(args.modules) || !args.modules.every((m) => typeof m === 'string')) {
    return 'Invalid modules list.';
  }
  return undefined;
}
