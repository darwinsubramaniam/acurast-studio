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

/**
 * Default base URL of the Grafana Loki HTTP gateway used by the Live Monitoring
 * log viewer. This is the Acurast-hosted (paid) endpoint; users running their
 * own Loki override it per-network via the `acurast.loki.urls` setting.
 * The viewer appends `/loki/api/v1/...` paths to this base.
 */
export const LOKI_ENDPOINTS: Record<AcurastNetwork, string> = {
  mainnet: 'https://logs.acurast.com',
  canary: 'https://logs.acurast.com',
};

/** Loki stream label that carries the Acurast job's local id. Override with
 * `acurast.loki.jobLabel` if your log pipeline uses a different label. */
export const LOKI_DEFAULT_JOB_LABEL = 'job_id';
