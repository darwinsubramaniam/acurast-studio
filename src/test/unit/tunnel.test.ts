import { describe, it, expect } from 'vitest';
import {
  computeTxtValue,
  normalizeSuffix,
  wildcardName,
  txtName,
  publicUrlExample,
  relaysFor,
} from '../../tunnel/tunnel';
import { RELAY_NODES } from '../../sdk/constants';

// Alice's well-known sr25519 public key (account 5GrwvaEF…).
const ALICE_PK = 'd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d';
const SUFFIX = 'tunnel.example.com';
// Independently verified to equal the docs' pipeline:
//   { printf '%s' <PK> | xxd -r -p; printf '%s' <SUFFIX>; } | openssl dgst -sha256 -binary | base64
const ALICE_TXT = 'S3pxg6mmjQPxKevr9Uz3OVgx/SYpV4qqlArx76Ahaw8=';

describe('computeTxtValue', () => {
  it('matches the reference base64(sha256(pubkey || suffix))', () => {
    expect(computeTxtValue(ALICE_PK, SUFFIX)).toBe(ALICE_TXT);
  });

  it('tolerates a leading 0x on the public key', () => {
    expect(computeTxtValue('0x' + ALICE_PK, SUFFIX)).toBe(ALICE_TXT);
  });

  it('is insensitive to suffix casing and trailing dots', () => {
    expect(computeTxtValue(ALICE_PK, 'Tunnel.Example.com.')).toBe(ALICE_TXT);
  });

  it('changes when the suffix changes', () => {
    expect(computeTxtValue(ALICE_PK, 'other.example.com')).not.toBe(ALICE_TXT);
  });
});

describe('normalizeSuffix', () => {
  it('trims, lowercases and strips trailing dots', () => {
    expect(normalizeSuffix('  Tunnel.Example.COM.  ')).toBe('tunnel.example.com');
  });
  it('strips a pasted wildcard prefix', () => {
    expect(normalizeSuffix('*.tunnel.example.com')).toBe('tunnel.example.com');
  });
  it('strips a pasted _acu prefix', () => {
    expect(normalizeSuffix('_acu.tunnel.example.com')).toBe('tunnel.example.com');
  });
  it('handles empty / nullish input', () => {
    expect(normalizeSuffix('')).toBe('');
    expect(normalizeSuffix(undefined as unknown as string)).toBe('');
  });
});

describe('record name helpers', () => {
  it('builds wildcard, txt and url names from a normalized suffix', () => {
    expect(wildcardName(' tunnel.example.com. ')).toBe('*.tunnel.example.com');
    expect(txtName('tunnel.example.com')).toBe('_acu.tunnel.example.com');
    expect(publicUrlExample('tunnel.example.com')).toBe(
      'https://<clientId>.tunnel.example.com:8443',
    );
  });
});

describe('relaysFor', () => {
  it('returns the built-in defaults when no override is set', () => {
    expect(relaysFor('canary')).toEqual(RELAY_NODES.canary);
    expect(relaysFor('canary').length).toBeGreaterThan(0);
  });

  it('returns the built-in mainnet relay by default', () => {
    expect(relaysFor('mainnet')).toEqual(RELAY_NODES.mainnet);
    expect(relaysFor('mainnet').length).toBeGreaterThan(0);
  });

  it('ignores an empty override and keeps defaults', () => {
    expect(relaysFor('canary', { canary: [] })).toEqual(RELAY_NODES.canary);
  });

  it('replaces defaults with override IPs, keeping known host labels', () => {
    const knownIp = RELAY_NODES.canary[0].ip;
    const result = relaysFor('canary', { canary: [knownIp, '1.2.3.4', '  '] });
    expect(result).toEqual([
      { ip: knownIp, host: RELAY_NODES.canary[0].host },
      { ip: '1.2.3.4', host: '1.2.3.4' },
    ]);
  });

  it('lets an override supply mainnet relays', () => {
    expect(relaysFor('mainnet', { mainnet: ['9.9.9.9'] })).toEqual([
      { ip: '9.9.9.9', host: '9.9.9.9' },
    ]);
  });
});
