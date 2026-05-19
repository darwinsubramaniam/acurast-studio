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
