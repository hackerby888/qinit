// Read models for the core-lite HTTP RPC. Kept apart from the client so a consumer that only needs
// the shapes does not pull the LiteRpc implementation in with them.
export interface TickInfo {
  tick: number;
  epoch: number;
  fault?: EngineFaultInfo;
  [k: string]: unknown;
}

export interface EngineFaultInfo {
  message: string;
  phase: string;
  failedTick: number;
  failedEpoch: number;
  lastFinalizedTick: number;
  lastFinalizedEpoch: number;
  slot?: number;
  kind?: number;
  entry?: number;
  txId?: string;
}

export interface NodeBackendIdentity {
  backend: "core" | "simulator";
}

export type DirectDeploymentKind = "dynamic" | "system";

export interface DynamicContractEntry {
  inputType: number;
  inputSize: number;
  outputSize: number;
}
export interface DynamicContractRegistryEntry {
  index: number;
  armed: boolean;
  constructed: boolean;
  version: number;
  name: string;
  codeHash: string;
  functions: DynamicContractEntry[];
  procedures: DynamicContractEntry[];
  source?: string;
  lastError?: string;
}
export interface DynamicContractRegistry {
  contracts: DynamicContractRegistryEntry[];
  slotBase: number;
  slotCount: number;
}

export interface DynamicContractUploadStatus {
  active: boolean;
  sessionId: string;
  totalSize: number;
  chunkSize: number;
  chunkCount: number;
  receivedCount: number;
  complete: boolean;
  finalHash: string;
  missing: number[];
  missingCount: number;
}

export interface DebugHostCall {
  name: string;
  detail: string;
}
export interface DebugStateRegion {
  off: number;
  before: string;
  after: string;
} // changed byte run (hex)
export interface DebugLog {
  type: number;
  size: number;
  hex: string;
} // a LOG_* call (numeric struct bytes)
export interface DebugEntry {
  seq: number;
  tick: number;
  index: number;
  entry: number;
  kind: number;
  ok: boolean;
  execNs: number;
  inSize: number;
  outSize: number;
  stateSize: number;
  stateTruncated: boolean;
  invocator: string;
  invocationReward: number;
  inHex: string;
  outHex: string;
  stateDiff: DebugStateRegion[];
  trap?: string;
  hostCalls: DebugHostCall[];
  logs: DebugLog[];
}
export interface DebugTrace {
  enabled: boolean;
  entries: DebugEntry[];
}

// Explorer read models. Amounts stay strings end to end: core encodes them as JSON numbers,
// which loses precision above 2^53, so nothing downstream should widen them back to Number.
export interface ExplorerTx {
  hash: string;
  amount: string;
  source: string;
  destination: string;
  tickNumber: number;
  timestamp: string; // unix seconds, "" when the node has no tick data
  inputType: number;
  inputSize: number;
  inputData: string; // base64
  signature: string; // base64
  moneyFlew: boolean;
}
export interface ExplorerTickData {
  tickNumber: number;
  epoch: number;
  computorIndex: number;
  timestamp: string;
  timelock: string;
  transactionDigests: string[];
  signature: string;
}
export interface IdentityTransfer extends ExplorerTx {
  direction: "in" | "out";
}
export interface ContractCall extends ExplorerTx {
  contractIndex: number;
}
export interface ContractCallsPage {
  fromTick: number;
  toTick: number;
  total: number;
  page: number;
  pageSize: number;
  transactions: ContractCall[];
}
export interface ContractListEntry {
  index: number;
  name: string;
  constructionEpoch: number;
  destructionEpoch: number;
  stateSize: number;
}
export interface ExplorerData {
  header: {
    tick: number;
    epoch: number;
    initialTick: number;
    alignedVotes: number;
    ticksInCurrentEpoch: number;
    latestCreatedTick: number;
    mainAuxStatus: number;
    isSavingSnapshot: boolean;
  };
  recentTicks: {
    tick: number;
    leader: string;
    empty: boolean;
    txCount: number;
    timestamp: string;
  }[];
  mempool: { totalPending: number; perTick: { tick: number; count: number }[] };
  network: { connectedPeers: number; outgoing: number; incoming: number };
  spectrum: { circulatingSupply: string; activeAddresses: number };
}
