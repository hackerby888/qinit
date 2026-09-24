// Read models for the core-lite HTTP RPC, kept apart from the client so a consumer needing only the shapes does not pull in LiteRpc.
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
    // Execution fee reserve in qu as decimal text; at or below zero the contract is dormant. Older nodes omit it.
    feeReserve?: string;
    // What the current fee phase accumulated and has not charged yet; the simulator reports it, a core node does not.
    executionFee?: string;
}
export interface DynamicContractRegistry {
    contracts: DynamicContractRegistryEntry[];
    slotBase: number;
    slotCount: number;
}

// what a node did with the last DEPLOY it processed. Only "incomplete" can still change: every other refusal is final for that session.
export const DEPLOY_OUTCOME_CODES = ["ok", "bad-slot", "abi-mismatch", "session-mismatch", "incomplete", "hash-mismatch", "not-wasm", "load-failed"] as const;
export type DeployOutcomeCode = (typeof DEPLOY_OUTCOME_CODES)[number];
export interface DeployOutcome {
    sessionId: string;
    slot: number;
    tick: number;
    ok: boolean;
    code: DeployOutcomeCode;
    message: string;
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
    /** Ticks since the last chunk landed and the node's idle limit; older nodes omit both. */
    idleTicks?: number;
    staleAfterTicks?: number;
    lastProgressTick?: number;
    /** null until the node has processed a DEPLOY; older nodes omit it. */
    lastDeploy?: DeployOutcome | null;
}

// `ord` is the record's place in the node's emission order, shared by every frame of one call, so a callee's prints read back in order. Older nodes omit it.
export interface DebugHostCall {
    name: string;
    detail: string;
    ord?: number;
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
    ord?: number;
} // a LOG_* call (numeric struct bytes)
export interface DebugCheat {
    slot?: number;
    id: number;
    part: number;
    size: number;
    value: number | string;
    hex: string;
    ord?: number;
} // one CC_PRINT argument; size 0 means the value came by register
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
    /** The slot's state version once this dispatch finished, so a reader can tell whether the state still matches the diff. */
    stateVersion?: number;
    trap?: string;
    hostCalls: DebugHostCall[];
    logs: DebugLog[];
    cheats: DebugCheat[];
    /** Sequence numbers of the frames this dispatch called directly, in completion order; absent on a node too old to record it. */
    children?: number[];
}
export interface DebugTrace {
    enabled: boolean;
    entries: DebugEntry[];
}

// Explorer read models. Amounts stay strings end to end: core encodes them as JSON numbers, which loses precision above 2^53.
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
        // How many finalized ticks the node keeps (the simulator's --history-ticks); absent when it does not say.
        historyTicks?: number;
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
