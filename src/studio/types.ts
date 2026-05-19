import type { WalletInfo } from '../wallet/walletService';

export type { WalletInfo };

export type Route = 'home' | 'wallets' | 'settings' | 'deploy';

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
export interface DeployStartMsg { type: 'deploy.start'; }
export interface DeployOpenOutputMsg { type: 'deploy.openOutput'; }
export interface DeployQueryProcessorsMsg { type: 'deploy.queryProcessors'; }
export interface DeployCopyMsg { type: 'deploy.copy'; text: string; }
export interface DeployDeregisterMsg { type: 'deploy.deregister'; origin: string; localId: number; }
export interface PricingFetchMsg { type: 'pricing.fetch'; }
export type InMsg =
  | NavigateMsg | ReadyMsg | WalletActionMsg | RefreshBalanceMsg
  | ConfigSaveMsg | ConfigOpenJsonMsg | ConfigChooseMsg
  | DeployStartMsg | DeployOpenOutputMsg | DeployQueryProcessorsMsg | DeployCopyMsg
  | DeployDeregisterMsg | PricingFetchMsg;

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

export interface PricingStateMsg {
  type: 'pricing.state';
  status: 'idle' | 'loading' | 'ok' | 'error';
  fees?: SerializedFees;
  advice?: SerializedAdvice;
  fallbackReason?: string;
  error?: string;
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
}

export interface BalanceMsg {
  status: 'idle' | 'loading' | 'ok' | 'error';
  value?: number;
  symbol?: string;
  network?: string;
  message?: string;
}
