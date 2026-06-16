import type { WalletInfo } from '../wallet/walletService';
import type { AcurastNetwork, TunnelRelay } from '../sdk/constants';

export type { WalletInfo, AcurastNetwork, TunnelRelay };

export type Route = 'home' | 'wallets' | 'settings' | 'deploy' | 'history' | 'processors' | 'tunnel';

export interface NavigateMsg { type: 'navigate'; route: Route; }
export interface ReadyMsg { type: 'ready'; }
/**
 * Simple, fire-and-forget wallet action. The richer create/import/reveal/rename/
 * editDescription/delete flows now run as in-panel webview wizards and use the
 * granular `wallet.*` request messages below (which post `wallet.opResult` back);
 * only `setActive` stays here since it needs no in-panel UI.
 */
export interface WalletActionMsg {
  type: 'wallet';
  action: 'setActive';
  id?: string;
}

// ── In-panel wallet flow requests (webview → host) ─────────────────────────────
// Each is answered by a WalletOpResultMsg (`wallet.opResult`) so the webview
// wizard can advance / show errors. Secrets stay on the host (WalletService).
export interface WalletCreateMsg {
  type: 'wallet.create';
  name: string;
  description: string;
  password: string;
}
/** Validate a pasted phrase (checksum) + detect duplicates before advancing import. */
export interface WalletCheckPhraseMsg { type: 'wallet.checkPhrase'; mnemonic: string; }
export interface WalletImportMsg {
  type: 'wallet.import';
  mnemonic: string;
  name: string;
  description: string;
  password: string;
}
export interface WalletRevealMsg { type: 'wallet.reveal'; id: string; password: string; }
export interface WalletRenameMsg { type: 'wallet.rename'; id: string; name: string; }
export interface WalletEditDescriptionMsg { type: 'wallet.editDescription'; id: string; description: string; }
export interface WalletDeleteMsg { type: 'wallet.delete'; id: string; }
/** Copy arbitrary text (address / mnemonic) via the host — CSP blocks the webview clipboard. */
export interface WalletCopyMsg { type: 'wallet.copy'; text: string; note?: string; }
export interface RefreshBalanceMsg { type: 'refreshBalance'; }
export interface ConfigSaveMsg { type: 'config.save'; projectKey: string; patch: Record<string, unknown>; }
export interface ConfigOpenJsonMsg { type: 'config.openJson'; }
export interface ConfigChooseMsg { type: 'config.choose'; }
export interface ConfigNewProjectMsg { type: 'config.newProject'; }
export interface DeployStartMsg { type: 'deploy.start'; }
/** Run the project's `build.command` without deploying (standalone "Build" action). */
export interface BuildStartMsg { type: 'build.start'; projectKey?: string; }
export interface DeployOpenOutputMsg { type: 'deploy.openOutput'; }
export interface DeployQueryProcessorsMsg { type: 'deploy.queryProcessors'; }
export interface DeployCopyMsg { type: 'deploy.copy'; text: string; }
export interface DeployDeregisterMsg { type: 'deploy.deregister'; origin: string; localId: number; }
export interface DevtoolsRefreshKeyMsg { type: 'devtools.refreshKey'; }
export interface DevtoolsOpenUrlMsg { type: 'devtools.openUrl'; url: string; }
/** Open an arbitrary URL in the user's external browser (e.g. the donation page). */
export interface OpenExternalMsg { type: 'openExternal'; url: string; }
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
export interface JobDiagnoseMsg        { type: 'history.diagnose'; origin: string; localId: number; network: string; }
/** Deregister (cancel on-chain) a job shown in the History view. */
export interface HistoryDeregisterMsg  { type: 'history.deregister'; origin: string; localId: number; network: string; }
/** Fetch the per-processor assignments (slot + startDelay) for one History job, on demand. */
export interface HistoryAssignmentsMsg { type: 'history.fetchAssignments'; origin: string; localId: number; network: string; }
export interface HistoryRemovePathMsg  { type: 'history.removePathInfo'; id: string; }
export interface HistoryRemoveMsg      { type: 'history.remove'; id: string; }
export interface HistoryOpenFolderMsg  { type: 'history.openFolder'; path: string; }
/** Align the Studio target network (`acurast.network` setting) to `network`. */
export interface NetworkSetTargetMsg   { type: 'network.setTarget'; network: string; }
/** Open the Studio network quick-pick (the same picker the status bar uses). */
export interface NetworkOpenPickerMsg  { type: 'network.openPicker'; }
/** Recompute the tunnel DNS records for `suffix` on `network`, for `walletId` (defaults to active). */
export interface TunnelComputeMsg      { type: 'tunnel.compute'; suffix: string; network: AcurastNetwork; walletId?: string; }
/** Resolve and verify the published tunnel DNS records for `suffix` on `network`, for `walletId` (defaults to active). */
export interface TunnelVerifyMsg       { type: 'tunnel.verify'; suffix: string; network: AcurastNetwork; walletId?: string; }

export type InMsg =
  | NavigateMsg | ReadyMsg | WalletActionMsg | RefreshBalanceMsg
  | WalletCreateMsg | WalletCheckPhraseMsg | WalletImportMsg | WalletRevealMsg
  | WalletRenameMsg | WalletEditDescriptionMsg | WalletDeleteMsg | WalletCopyMsg
  | ConfigSaveMsg | ConfigOpenJsonMsg | ConfigChooseMsg | ConfigNewProjectMsg
  | DeployStartMsg | BuildStartMsg | DeployOpenOutputMsg | DeployQueryProcessorsMsg | DeployCopyMsg
  | DeployDeregisterMsg | PricingFetchMsg
  | FiatFetchListMsg | FiatSaveMsg
  | DevtoolsRefreshKeyMsg | DevtoolsOpenUrlMsg | OpenExternalMsg
  | ProcessorsQueryMsg | ProcessorsAdvertiseMsg
  | HistoryLoadMsg | HistoryFetchOnlineMsg | JobDiagnoseMsg | HistoryDeregisterMsg | HistoryAssignmentsMsg | HistoryRemovePathMsg | HistoryRemoveMsg | HistoryOpenFolderMsg
  | NetworkSetTargetMsg | NetworkOpenPickerMsg
  | TunnelComputeMsg | TunnelVerifyMsg;

// ── Host → webview messages (OutMsg) ──────────────────────────────────────────
// The reverse-direction mirror of InMsg: every message StudioPanel.post() sends
// to the webview. App.svelte types its message handler as OutMsg so the `type`
// discriminant narrows each case (no `as unknown as` casts). The 9 *StateMsg
// interfaces below already carry their own `type` and are folded into the union;
// these are the previously-inline shapes that lacked a named interface.
export interface RouteMsg { type: 'route'; route: Route; }
export interface ContextMsg {
  type: 'context';
  isAcurastProject: boolean;
  configPath: string | null;
  configRel: string | null;
  configExists: boolean;
  anyConfigExists: boolean;
}
export interface WalletsStateMsg {
  type: 'wallets.state';
  wallets: WalletInfo[];
  activeId: string | null;
  network: string;
  symbol: string;
}
/** Balance payload (BalanceMsg) tagged with its wire `type`. Active wallet only —
 * used by the Home summary card. The Wallets list uses WalletsBalancesMsg. */
export interface BalanceStateMsg extends BalanceMsg { type: 'wallets.balance'; }
/** Per-wallet balances (keyed by wallet id) for the Wallets list, all fetched on
 * the Studio target network. Posted as a `loading` map first, then resolved. */
export interface WalletsBalancesMsg { type: 'wallets.balances'; balances: Record<string, BalanceMsg>; }
/**
 * Result of an in-panel wallet flow request (create/import/reveal/...), answering
 * the matching `wallet.*` InMsg. `seq` is host-incremented so the webview's
 * `$effect` fires on every result even when the payload repeats.
 */
export interface WalletOpResultMsg {
  type: 'wallet.opResult';
  op: 'create' | 'checkPhrase' | 'import' | 'reveal' | 'rename' | 'editDescription' | 'delete';
  ok: boolean;
  seq: number;
  /** Affected / created wallet. */
  id?: string;
  address?: string;
  name?: string;
  /** Create-success (for the backup step) and reveal-success (the decrypted phrase). */
  mnemonic?: string;
  // checkPhrase fields:
  valid?: boolean;
  duplicate?: boolean;
  existingName?: string;
  existingAddress?: string;
  /** Error text / "Incorrect password — try again". */
  message?: string;
}
export interface ConfigStateMsg { type: 'config.state'; config: unknown; }
export interface DeployStateMsg { type: 'deploy.state'; state: DeployState | null; }
export interface NetworkMismatchMsg {
  type: 'network.mismatch';
  projectNetwork: string | null;
  targetNetwork: string;
}

export type OutMsg =
  | RouteMsg | ContextMsg | WalletsStateMsg | BalanceStateMsg
  | WalletsBalancesMsg | WalletOpResultMsg
  | ConfigStateMsg | DeployStateMsg | NetworkMismatchMsg
  | PricingStateMsg | FiatListStateMsg | FiatSelectionStateMsg
  | HistoryStateMsg | ProcessorsStateMsg | TunnelStateMsg
  | DiagnosisStateMsg | DeregisterStateMsg | AssignmentsStateMsg;

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
  /** Token symbol of the project (acurast.json) network the pricing was computed
   * under ('ACU' | 'cACU') — set on `status: 'ok'`. Labels the fees/advice values,
   * which are project-network-scoped (not the Studio target). */
  symbol?: string;
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
  | 'build' | 'bundle' | 'upload' | 'prepare' | 'submit'
  | 'match' | 'acknowledge' | 'envvars';
export type StageStatus = 'pending' | 'active' | 'done' | 'error';

export type LogLevel = 'info' | 'debug' | 'warn' | 'error';
/** One line of captured output, attributed to a deploy stage and colored by level. */
export interface LogLine {
  level: LogLevel;
  text: string;
  ts: number;
}

export interface DeployStage {
  id: DeployStageId;
  label: string;
  status: StageStatus;
  detail?: string;
  /** Output captured while this stage was active (build/SDK logs). Colored by level in the webview. */
  logs?: LogLine[];
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

/**
 * One entry of a Single strategy's `instantMatch` array: a processor pinned for
 * the deployment plus its own max start delay. The array may hold zero (open
 * matching), one, or many such entries.
 */
export interface InstantMatchEntry {
  processor: string;
  maxAllowedStartDelayInMs: number;
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
  /** On-chain schedule of the deployed job (epoch ms). Combined with each
   * processor's `startDelay` to show the actual first-execution time. */
  schedule?: { startTime: number; endTime: number; maxStartDelay?: number };
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
  /** Max per-processor stagger (ms) the matcher may add to `startTime`. */
  maxStartDelay: number;
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

/** Lifecycle status of a local record's job, resolved from the chain.
 * `none` = no matching registration found on-chain (deregistered / cleaned). */
export type LocalJobStatus = 'active' | 'scheduled' | 'expired' | 'none';

export interface HistoryStateMsg {
  type: 'history.state';
  status: 'loading' | 'ok' | 'error';
  records?: StoredDeploymentWithMeta[];
  offset?: number;
  hasMore?: boolean;
  total?: number;
  onlineRecords?: StoredDeploymentWithMeta[];
  /** Per-record on-chain status, keyed by record id. Posted asynchronously
   * after the local list, once the chain query for that page resolves. */
  statuses?: Record<string, LocalJobStatus>;
  error?: string;
}

// ── Job diagnosis ─────────────────────────────────────────────────────────────
// Explains why an on-chain job is / isn't matching by evaluating every gate the
// marketplace enforces. Produced by AcurastClient.diagnoseJob.
export type DiagnosisStatus = 'pass' | 'fail' | 'warn' | 'info';

export interface DiagnosisCheck {
  /** Stable id e.g. 'lifecycle' | 'modules' | 'whitelist' | 'consumers' | 'fee' | 'version' | 'reputation' | 'resources' | 'startWindow' | 'assignment' | 'heartbeat'. */
  id: string;
  label: string;
  status: DiagnosisStatus;
  detail: string;
}

export interface ProcessorDiagnosis {
  address: string;
  /** True if every hard gate (modules/consumers/fee/version/resources) passes. */
  eligible: boolean;
  checks: DiagnosisCheck[];
}

export interface JobDiagnosis {
  found: boolean;
  origin: string;
  localId: number;
  network: string;
  /** 'open' = registered but unmatched, 'assigned' = matched, 'unknown' = no status / not found. */
  jobStatus: 'open' | 'assigned' | 'unknown';
  assignedSlots?: number;
  /** True once the schedule's end has passed (now > schedule.endTime). The chain keeps a matched job 'assigned' forever, so this is the real lifecycle signal. */
  expired?: boolean;
  /** schedule.endTime in ms — for display in the verdict. */
  endTime?: number;
  /** One-line overall verdict shown as the panel heading. */
  summary: string;
  /** Job-level checks (start window, assignment strategy). */
  checks: DiagnosisCheck[];
  /** Per whitelisted processor; empty when the job is public (any processor). */
  processors: ProcessorDiagnosis[];
}

export interface DiagnosisStateMsg {
  type: 'diagnosis.state';
  /** `${origin}:${localId}` — keys the result per job in the webview. */
  key: string;
  status: 'loading' | 'ok' | 'error';
  result?: JobDiagnosis;
  error?: string;
}

/** Progress of a History-view deregister, posted host→webview. */
export interface DeregisterStateMsg {
  type: 'deregister.state';
  /** `${origin}:${localId}` — keys the result per job in the webview. */
  key: string;
  status: 'loading' | 'ok' | 'error';
  /** Submitted extrinsic hash, set once the deregister is in a block. */
  txHash?: string;
  error?: string;
}

/** Per-processor assignments for one History job, posted host→webview on demand. */
export interface AssignmentsStateMsg {
  type: 'assignments.state';
  /** `${origin}:${localId}` — keys the result per job in the webview. */
  key: string;
  status: 'loading' | 'ok' | 'error';
  /** Acknowledged/matched processors with slot + startDelay (ms). */
  processors?: ProcessorInfo[];
  error?: string;
}

export interface BalanceMsg {
  status: 'idle' | 'loading' | 'ok' | 'error';
  value?: number;
  symbol?: string;
  network?: string;
  message?: string;
}

// ── Tunnel DNS wizard ─────────────────────────────────────────────────────────
/** The `_acu.<suffix>` TXT record for one deployer wallet. */
export interface TunnelTxtRecord {
  walletId: string;
  /** Wallet display name. */
  name: string;
  /** SS58 address of the wallet. */
  address: string;
  /** base64(sha256(pubkey || suffix)). */
  txtValue: string;
  /** null = not checked yet; true/false after a DNS verify. */
  verified?: boolean | null;
}

export interface TunnelVerifyState {
  status: 'idle' | 'checking' | 'done' | 'error';
  error?: string;
  wildcard?: { name: string; expectedIps: string[]; resolvedIps: string[]; ok: boolean };
  /** Raw TXT records found at `_acu.<suffix>` during the last check. */
  txtFound?: string[];
}

export interface TunnelStateMsg {
  type: 'tunnel.state';
  network: AcurastNetwork;
  /** Normalized domain suffix the records are computed for ('' when unset). */
  suffix: string;
  relays: TunnelRelay[];
  /** `*.<suffix>` ('' when no suffix). */
  wildcardName: string;
  /** `_acu.<suffix>` ('' when no suffix). */
  txtName: string;
  /** `https://<clientId>.<suffix>:8443` ('' when no suffix). */
  publicUrlExample: string;
  port: number;
  /** Wallet the TXT record is currently shown for (resolved to the active wallet by default). */
  selectedWalletId: string | null;
  /** TXT record for the selected deployer wallet (null until a suffix is set). */
  record: TunnelTxtRecord | null;
  verify: TunnelVerifyState;
}
