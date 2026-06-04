import type { WalletInfo } from '../wallet/walletService';

export type { WalletInfo };

export type Route = 'home' | 'wallets' | 'settings' | 'deploy' | 'history' | 'processors';

export interface NavigateMsg { type: 'navigate'; route: Route; }
export interface ReadyMsg { type: 'ready'; }
export interface WalletActionMsg {
  type: 'wallet';
  action: 'create' | 'import' | 'reveal' | 'delete' | 'copyAddress' | 'rename' | 'editDescription' | 'setActive';
  id?: string;
}
export interface RefreshBalanceMsg { type: 'refreshBalance'; }
export interface ConfigSaveMsg { type: 'config.save'; projectKey: string; patch: Record<string, unknown>; }
export interface ConfigOpenJsonMsg { type: 'config.openJson'; }
export interface ConfigChooseMsg { type: 'config.choose'; }
export interface ConfigNewProjectMsg { type: 'config.newProject'; }
export interface DeployStartMsg { type: 'deploy.start'; }
export interface DeployOpenOutputMsg { type: 'deploy.openOutput'; }
export interface DeployQueryProcessorsMsg { type: 'deploy.queryProcessors'; }
export interface DeployCopyMsg { type: 'deploy.copy'; text: string; }
export interface DeployDeregisterMsg { type: 'deploy.deregister'; origin: string; localId: number; }
export interface DevtoolsRefreshKeyMsg { type: 'devtools.refreshKey'; }
export interface DevtoolsOpenUrlMsg { type: 'devtools.openUrl'; url: string; }
export type CoinGeckoPlan = 'demo' | 'pro';

export interface PricingFetchMsg { type: 'pricing.fetch'; }
export interface FiatFetchListMsg {
  type: 'fiat.fetchList';
  exchangerId: number;
  apiKey?: string;
  coingeckoPlan?: CoinGeckoPlan;
}
export interface FiatSaveMsg {
  type: 'fiat.save';
  exchangerId: number;
  currencyId: string; // empty string disables fiat conversion
  apiKey?: string;    // stored in SecretStorage per exchanger
  coingeckoPlan?: CoinGeckoPlan;
}
export interface ProcessorsQueryMsg    { type: 'processors.query'; address: string; network: string; }
export interface ProcessorsAdvertiseMsg {
  type: 'processors.advertise';
  /** Vault id of the manager wallet that signs the advertiseFor extrinsic. */
  walletId: string;
  /** Processor address whose advertisement is being updated. */
  processor: string;
  /** Full replacement set of available modules to advertise. */
  modules: string[];
  network: string;
}
export interface HistoryLoadMsg        { type: 'history.load'; offset?: number; }
export interface HistoryFetchOnlineMsg { type: 'history.fetchOnline'; address: string; network: string; }
export interface HistoryRemovePathMsg  { type: 'history.removePathInfo'; id: string; }
export interface HistoryRemoveMsg      { type: 'history.remove'; id: string; }
export interface HistoryOpenFolderMsg  { type: 'history.openFolder'; path: string; }

export type InMsg =
  | NavigateMsg | ReadyMsg | WalletActionMsg | RefreshBalanceMsg
  | ConfigSaveMsg | ConfigOpenJsonMsg | ConfigChooseMsg | ConfigNewProjectMsg
  | DeployStartMsg | DeployOpenOutputMsg | DeployQueryProcessorsMsg | DeployCopyMsg
  | DeployDeregisterMsg | PricingFetchMsg
  | FiatFetchListMsg | FiatSaveMsg
  | DevtoolsRefreshKeyMsg | DevtoolsOpenUrlMsg
  | ProcessorsQueryMsg | ProcessorsAdvertiseMsg
  | HistoryLoadMsg | HistoryFetchOnlineMsg | HistoryRemovePathMsg | HistoryRemoveMsg | HistoryOpenFolderMsg;

export interface SerializedFees {
  numberOfExecutions: string;
  numberOfReplicas: string;
  totalRuns: string;
  maxCostPerExecution: string;
  maxCostPerExecutionCACU: string;
  maxCostPerExecutionPerReplicaCACU: string;
  suggestedCostPerExecution: string;
  suggestedCostPerExecutionCACU: string;
  maxTotalCostCACU: string;
  excessCostPerExecution: string;
  excessCostPerExecutionPercentage: string;
}

export interface SerializedAdvice {
  status: 'sufficient' | 'insufficient' | 'overpaying';
  matchedProcessors: number;
  requiredProcessors: number;
  currentPrice: string;
  suggestedPrice: string | null;
  averagePrice: string | null;
  distribution: Array<{ range_min: string; range_max: string; count: number }>;
}

export interface PricingFiatInfo {
  exchangerId: number;
  exchangerName: string;
  currencyId: string;
  currencyName: string;
  currencySign: string;
  currencySymbol: string;
  /** Price of 1 ACU in the selected fiat. */
  acuPriceFiat: number;
  /** ms epoch when the price was fetched. */
  fetchedAt: number;
  /** Set if the fiat lookup failed; conversion is then omitted. */
  error?: string;
}

export interface PricingStateMsg {
  type: 'pricing.state';
  status: 'idle' | 'loading' | 'ok' | 'error';
  fees?: SerializedFees;
  advice?: SerializedAdvice;
  fiat?: PricingFiatInfo;
  fallbackReason?: string;
  error?: string;
}

export interface FiatListItem {
  id: string;
  name: string;
  sign: string;
  symbol: string;
}

export interface FiatListStateMsg {
  type: 'fiat.listState';
  status: 'loading' | 'ok' | 'error';
  exchangerId: number;
  list?: FiatListItem[];
  error?: string;
}

export interface FiatSelectionStateMsg {
  type: 'fiat.selection';
  exchangerId: number;
  currencyId: string;
  hasApiKey: boolean;
  coingeckoPlan: CoinGeckoPlan;
}

export type DeployStageId =
  | 'bundle' | 'upload' | 'prepare' | 'submit'
  | 'match' | 'acknowledge' | 'envvars';
export type StageStatus = 'pending' | 'active' | 'done' | 'error';

export interface DeployStage {
  id: DeployStageId;
  label: string;
  status: StageStatus;
  detail?: string;
}

export interface DeployJobId {
  origin: string;
  localId: number;
  deregistering?: boolean;
  deregistered?: boolean;
  deregisterTxHash?: string;
  deregisterError?: string;
}

export interface ProcessorPubKey {
  curve: string;
  key: string;
}

export interface ProcessorInfo {
  address: string;
  slot?: number;
  startDelay?: number;
  feePerExecution?: string;
  acknowledged?: boolean;
  slaTotal?: string;
  slaMet?: string;
  pubKeys?: ProcessorPubKey[];
}

export interface ProcessorsState {
  status: 'idle' | 'loading' | 'ok' | 'error';
  list?: ProcessorInfo[];
  message?: string;
  fetchedAt?: number;
}

/**
 * A processor device paired to (managed by) a wallet, read from
 * `acurastProcessorManager` + `acurastMarketplace` storage. Distinct from
 * `ProcessorInfo` above, which describes a processor *assigned to a job*.
 */
export interface ManagedProcessorReputation { r: number; s: number; }
export interface ManagedProcessorAd {
  maxMemory?: number;
  networkRequestQuota?: number;
  storageCapacity?: number;
  availableModules?: string[];
  /** null/undefined = open to any consumer; otherwise restricted to these addresses. */
  allowedConsumers?: string[] | null;
}
export interface ManagedProcessorPricing {
  feePerMillisecond?: string;
  feePerStorageByte?: string;
  baseFeePerExecution?: string; // planck
  schedulingWindowEnd?: number; // ms epoch
}
export interface ManagedProcessor {
  address: string;
  /** The manager NFT item id (managerId) this processor is paired under. */
  managerId: string;
  /** ms epoch of last heartbeat; 0 if never seen. */
  lastSeen: number;
  /** Human-readable app version, e.g. "1.26.0-rc1". */
  version?: string;
  /** Raw platform code from `processorVersion` (0 = Android). */
  platform?: number;
  reputation?: ManagedProcessorReputation;
  /** True when the processor currently advertises on the marketplace. */
  advertising: boolean;
  ad?: ManagedProcessorAd;
  pricing?: ManagedProcessorPricing;
}
export interface ManagedProcessorsResult {
  /** NFT item ids that resolved to managers owned by the wallet. */
  managerIds: string[];
  processors: ManagedProcessor[];
}
export interface ProcessorsStateMsg {
  type: 'processors.state';
  status: 'idle' | 'loading' | 'ok' | 'error';
  address?: string;
  network?: string;
  result?: ManagedProcessorsResult;
  error?: string;
}

export interface ChainEvent {
  ts: number;
  section: string;
  method: string;
  jobLocalId?: number;
  summary: string;
  kind: 'started' | 'reported' | 'finalized' | 'other';
  label: string;
}

export interface DeployState {
  active: boolean;
  startedAt: number;
  finishedAt?: number;
  result?: 'ok' | 'error';
  errorMessage?: string;
  project?: string;
  network?: string;
  ipfsHash?: string;
  txHash?: string;
  ackCount?: number;
  jobIds: DeployJobId[];
  processors?: ProcessorsState;
  stages: DeployStage[];
  chainEvents: ChainEvent[];
  watching: boolean;
  devtoolsEnabled?: boolean;
  devtoolsUrl?: string;
  devtoolsLoading?: boolean;
}

export interface StoredDeployment {
  id: string;
  project: string;
  network: string;
  startedAt: number;
  finishedAt: number;
  jobIds: DeployJobId[];
  ipfsHash?: string;
  txHash?: string;
  projectPath?: string;
}

export interface OnlineJobRegistration {
  startTime: number;
  endTime: number;
  intervalMs: string;
  durationMs: number;
  slots: number;
  rewardPlanck: string;
  strategy: 'Single' | 'Competing';
  modules: string[];
  scriptUrl?: string;
}

export interface StoredDeploymentWithMeta extends StoredDeployment {
  pathExists: boolean;
  registration?: OnlineJobRegistration;
}

export interface HistoryStateMsg {
  type: 'history.state';
  status: 'loading' | 'ok' | 'error';
  records?: StoredDeploymentWithMeta[];
  offset?: number;
  hasMore?: boolean;
  total?: number;
  onlineRecords?: StoredDeploymentWithMeta[];
  error?: string;
}

export interface BalanceMsg {
  status: 'idle' | 'loading' | 'ok' | 'error';
  value?: number;
  symbol?: string;
  network?: string;
  message?: string;
}
