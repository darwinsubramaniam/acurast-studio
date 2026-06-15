import { createHash } from 'crypto';
import { RELAY_NODES, TUNNEL_PORT, type AcurastNetwork, type TunnelRelay } from '../sdk/constants';

/**
 * Normalize a user-entered domain suffix to the bare form the DNS records use.
 * Strips a leading `*.` or `_acu.` (in case the user pasted a full record name),
 * any trailing dots, surrounding whitespace, and lowercases it. DNS is
 * case-insensitive, so lowercasing keeps the computed TXT value stable.
 */
export function normalizeSuffix(input: string): string {
  let s = (input ?? '').trim().toLowerCase();
  s = s.replace(/^\*\./, '').replace(/^_acu\./, '');
  s = s.replace(/\.+$/, '');
  return s;
}

/**
 * The TXT value proving deployer ownership of `suffix`:
 *   base64( sha256( <32-byte pubkey bytes> || utf8(suffix) ) )
 *
 * `publicKeyHex` is the wallet's raw sr25519 public key as hex (a leading `0x`
 * is tolerated). This is pure Node `crypto` — it deliberately replaces the
 * docs' `openssl dgst | base64` + `xxd` one-liner so the value is computed
 * identically on macOS, Windows and Linux with no external tools.
 */
export function computeTxtValue(publicKeyHex: string, suffix: string): string {
  const hex = (publicKeyHex ?? '').replace(/^0x/i, '');
  const pubkey = Buffer.from(hex, 'hex');
  const suffixBytes = Buffer.from(normalizeSuffix(suffix), 'utf8');
  return createHash('sha256').update(Buffer.concat([pubkey, suffixBytes])).digest('base64');
}

/** Wildcard record name: `*.<suffix>`. */
export function wildcardName(suffix: string): string {
  return `*.${normalizeSuffix(suffix)}`;
}

/** TXT record name: `_acu.<suffix>`. */
export function txtName(suffix: string): string {
  return `_acu.${normalizeSuffix(suffix)}`;
}

/** Example public URL of a deployment under `suffix`. */
export function publicUrlExample(suffix: string): string {
  return `https://<clientId>.${normalizeSuffix(suffix)}:${TUNNEL_PORT}`;
}

/**
 * Relay nodes for `network`, merging the built-in defaults with the optional
 * `acurast.tunnelRelays` setting. When the override lists IPs for a network it
 * fully replaces the defaults for that network; IPs already known in the
 * defaults keep their friendly host label, the rest fall back to the IP itself.
 */
export function relaysFor(
  network: AcurastNetwork,
  override?: Partial<Record<AcurastNetwork, string[]>>,
): TunnelRelay[] {
  const defaults = RELAY_NODES[network] ?? [];
  const overrideIps = override?.[network];
  if (!overrideIps || overrideIps.length === 0) return defaults;
  const labelByIp = new Map(defaults.map((r) => [r.ip, r.host]));
  return overrideIps
    .map((ip) => ip.trim())
    .filter((ip) => ip.length > 0)
    .map((ip) => ({ ip, host: labelByIp.get(ip) ?? ip }));
}
