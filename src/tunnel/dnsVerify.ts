import { promises as dns } from 'dns';
import { normalizeSuffix, txtName } from './tunnel';

/** Probe label resolved under the suffix to exercise the wildcard A record.
 * The apex itself does not match a `*.<suffix>` wildcard, so we must query a
 * sub-label. */
const PROBE_LABEL = 'acurast-studio-probe';
const LOOKUP_TIMEOUT_MS = 5000;

export interface TunnelTxtCheck {
  walletId: string;
  value: string;
}

export interface WildcardVerifyResult {
  /** The probe name actually queried, e.g. `acurast-studio-probe.<suffix>`. */
  name: string;
  expectedIps: string[];
  resolvedIps: string[];
  /** True when at least one expected relay IP is among the resolved IPs. */
  ok: boolean;
}

export interface TunnelVerifyResult {
  wildcard: WildcardVerifyResult;
  /** TXT records found at `_acu.<suffix>` (each record's chunks joined). */
  txtFound: string[];
  /** walletIds whose computed TXT value is present in `txtFound`. */
  verifiedWalletIds: string[];
  /** Set when the lookup failed for a reason other than "no record yet". */
  error?: string;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('DNS lookup timed out')), ms);
      // Don't let a pending timer keep the host process alive.
      (t as { unref?: () => void }).unref?.();
    }),
  ]);
}

/** A missing record (not yet published) is an empty result, not a hard error. */
function isNoRecord(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NXDOMAIN';
}

async function resolve4Safe(name: string): Promise<string[]> {
  try {
    return await withTimeout(dns.resolve4(name), LOOKUP_TIMEOUT_MS);
  } catch (err) {
    if (isNoRecord(err)) return [];
    throw err;
  }
}

async function resolveTxtSafe(name: string): Promise<string[]> {
  try {
    const records = await withTimeout(dns.resolveTxt(name), LOOKUP_TIMEOUT_MS);
    // resolveTxt returns string[][] — a record can be split into chunks; join them.
    return records.map((chunks) => chunks.join(''));
  } catch (err) {
    if (isNoRecord(err)) return [];
    throw err;
  }
}

/**
 * Resolve the tunnel DNS records for `suffix` and check them against expectation.
 * Uses Node's built-in resolver (`dns.promises`) so behaviour is identical on
 * macOS, Windows and Linux — no `dig`/`nslookup` dependency. Each lookup is
 * bounded by a ~5s timeout.
 */
export async function verifyTunnelDns(
  suffix: string,
  expectedIps: string[],
  expectedTxt: TunnelTxtCheck[],
): Promise<TunnelVerifyResult> {
  const norm = normalizeSuffix(suffix);
  const probe = `${PROBE_LABEL}.${norm}`;
  try {
    const [resolvedIps, txtFound] = await Promise.all([
      resolve4Safe(probe),
      resolveTxtSafe(txtName(norm)),
    ]);
    const expectedSet = new Set(expectedIps);
    const wildcardOk = expectedIps.length > 0 && resolvedIps.some((ip) => expectedSet.has(ip));
    const foundSet = new Set(txtFound.map((v) => v.trim()));
    const verifiedWalletIds = expectedTxt.filter((t) => foundSet.has(t.value)).map((t) => t.walletId);
    return {
      wildcard: { name: probe, expectedIps, resolvedIps, ok: wildcardOk },
      txtFound,
      verifiedWalletIds,
    };
  } catch (err) {
    return {
      wildcard: { name: probe, expectedIps, resolvedIps: [], ok: false },
      txtFound: [],
      verifiedWalletIds: [],
      error: (err as Error).message,
    };
  }
}
