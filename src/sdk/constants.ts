export type AcurastNetwork = 'mainnet' | 'canary';

export const RPC_ENDPOINTS: Record<AcurastNetwork, string> = {
  mainnet: 'wss://public-rpc.mainnet.acurast.com',
  canary: 'wss://public-rpc.canary.acurast.com',
};

export const IPFS_DEFAULTS = {
  endpoint: 'https://ipfs-proxy.acurast.prod.gke.papers.tech',
  apiKey: '', // proxy requires no key
};

export const SYMBOL: Record<AcurastNetwork, string> = {
  mainnet: 'ACU',
  canary: 'cACU',
};

export const MATCHER_ENDPOINTS: Record<AcurastNetwork, string> = {
  mainnet: 'https://matcher.mainnet.acurast.com',
  canary: 'https://matcher.canary.acurast.com',
};

/** A tunnel relay node: a friendly host label plus the IP a wildcard A record points at. */
export interface TunnelRelay {
  host: string;
  ip: string;
}

/**
 * Tunnel relay nodes per network — the IPs a `*.<suffix>` wildcard A record must
 * point at (see the quickstart-tunnel DNS guide). Both networks are supported;
 * users can supply extra IPs for either network via the `acurast.tunnelRelays`
 * setting, which overrides these defaults.
 */
export const RELAY_NODES: Record<AcurastNetwork, TunnelRelay[]> = {
  mainnet: [{ host: 'relay-1.mainnet.acurast.com', ip: '82.220.91.110' }],
  canary: [
    { host: 'relay-2.canary.acurast.com', ip: '57.129.64.128' },
    { host: 'canary-relay.5elementsnodes.com', ip: '176.9.45.137' },
    { host: 'acurast-canary-relay.dishich.com', ip: '82.154.208.246' },
    { host: 'relay.el9-acurast.com', ip: '213.136.88.18' },
    { host: 'canary-relay.vincent-acurast.xyz', ip: '213.136.90.239' },
    { host: 'canary-relay.acurast.online', ip: '107.172.233.226' },
  ],
};

/** Port every tunnel deployment is exposed on: `https://<clientId>.<suffix>:8443`. */
export const TUNNEL_PORT = 8443;
