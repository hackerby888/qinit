// Client for the qubic-core-lite built-in HTTP RPC.
// Fast path for on-chain reads — current tick, spectrum, and (later) the deploy registry.
import {
  DEFAULT_RPC_BASE,
  fetchWithTimeout,
  broadcastTx as netBroadcastTx,
} from "./net";
import type { NodeTransport, EntityInfo, TxInfo } from "./transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

function explorerTx(t: Record<string, unknown>): ExplorerTx {
  return {
    hash: String(t.hash ?? t.txId ?? ""),
    amount: String(t.amount ?? "0"),
    source: String(t.source ?? t.sourceId ?? ""),
    destination: String(t.destination ?? t.destId ?? ""),
    tickNumber: Number(t.tickNumber ?? t.tick ?? 0),
    timestamp: String(t.timestamp ?? ""),
    inputType: Number(t.inputType ?? 0),
    inputSize: Number(t.inputSize ?? 0),
    inputData: String(t.inputData ?? ""),
    signature: String(t.signature ?? ""),
    moneyFlew: Boolean(t.moneyFlew ?? true),
  };
}

export class LiteRpc implements NodeTransport {
  constructor(private base = DEFAULT_RPC_BASE) {}

  // GETs are idempotent reads: a connect/timeout failure is retried (bounded, backoff) so a momentary
  // blip during node boot/load doesn't fail the command. An HTTP non-2xx is a real answer -> not retried.
  private async get<T = unknown>(path: string, tries = 3): Promise<T> {
    for (let a = 0; ; a++) {
      let r: Response;
      try {
        r = await fetchWithTimeout(this.base + path, undefined, 10000);
      } catch (e: any) {
        if (a < tries - 1) {
          await sleep(200 * (a + 1));
          continue;
        }
        throw new Error(
          `node unreachable at ${this.base} — is it running? (qinit node run)  [${e?.message ?? e}]`,
        );
      }
      if (!r.ok) {
        const body = (await r.json().catch(() => null)) as
          | { message?: unknown }
          | null;
        const detail =
          typeof body?.message === "string" ? `: ${body.message}` : "";

        throw new Error(`RPC GET ${path} → HTTP ${r.status}${detail}`);
      }
      try {
        return (await r.json()) as T;
      } catch {
        throw new Error(`RPC GET ${path}: malformed JSON response from the node`);
      }
    }
  }

  // Explorer queries are POSTs with a JSON body. The status is returned alongside the parsed body so
  // callers can treat 404 as a real answer ("no such tick/tx") instead of a failure.
  private async post<T = unknown>(
    path: string,
    body: unknown,
    timeoutMs = 10000,
  ): Promise<{ status: number; json: T }> {
    let r: Response;
    try {
      r = await fetchWithTimeout(
        this.base + path,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        timeoutMs,
      );
    } catch (e: any) {
      throw new Error(
        `node unreachable at ${this.base} — is it running? (qinit node run)  [${e?.message ?? e}]`,
      );
    }
    const json = (await r.json().catch(() => ({}))) as T;
    if (!r.ok && r.status !== 404) {
      const detail = (json as { message?: unknown })?.message;
      throw new Error(
        `RPC POST ${path} → HTTP ${r.status}${typeof detail === "string" ? `: ${detail}` : ""}`,
      );
    }
    return { status: r.status, json };
  }

  /** Current tick / epoch — used to stamp outgoing transactions. */
  tickInfo() {
    return this.get<TickInfo>("/tick-info");
  }
  latestCreatedTickInfo() {
    return this.get<TickInfo>("/latest-created-tick-info");
  }
  faultInfo() {
    return this.get<EngineFaultInfo | null>("/live/v1/dev/fault");
  }
  /** Escape hatch for any GET route (e.g. a future /dyn/registry). */
  raw<T = unknown>(path: string) {
    return this.get<T>(path);
  }

  /** Deployed dynamic contracts + their fn/proc inputTypes (GET /live/v1/dyn-registry). */
  dynRegistry() {
    return this.get<DynamicContractRegistry>("/live/v1/dyn-registry");
  }

  /** Active upload session — assembled chunk count + which seqs are still missing (GET /live/v1/dyn-upload).
   * Lets deploy confirm the node assembled the full Wasm module before DEPLOY. */
  dynUpload() {
    return this.get<DynamicContractUploadStatus>("/live/v1/dyn-upload");
  }

  /** Exact tx confirmation (GET /live/v1/tx-status/{tick}/{txId}) — needs the tx-status addon.
   * found => included; processed => node ticked past {tick} (verdict final). */
  txStatus(tick: number, txId: string) {
    return this.get<{
      tick: number;
      currentTick: number;
      txId: string;
      found: boolean;
      moneyFlew: boolean;
      processed: boolean;
    }>(`/live/v1/tx-status/${tick}/${txId}`);
  }

  /** Recent wasm contract-call traces (GET /live/v1/debug-trace?since&limit) — the `qinit debug` data source. */
  debugTrace(since = 0, limit = 64) {
    return this.get<DebugTrace>(`/live/v1/debug-trace?since=${since}&limit=${limit}`);
  }
  /** Toggle trace capture on the node (GET /live/v1/dev/debug?on=0|1). Off by default. */
  setDebug(on: boolean) {
    return this.get<{ enabled: boolean }>(`/live/v1/dev/debug?on=${on ? 1 : 0}`);
  }
  /** Read current contract state bytes (GET /live/v1/dev/state-read) — for the debugger's container decode. */
  stateRead(slot: number, off: number, len: number) {
    return this.get<{ off: number; len: number; stateSize: number; hex: string }>(
      `/live/v1/dev/state-read?slot=${slot}&off=${off}&len=${len}`,
    );
  }
  /** K12 digest of the full effective resident state, as computed by the node. */
  contractDigest(slot: number) {
    return this.get<{ slot: number; stateSize: number; digest: string }>(
      `/live/v1/dev/contract-digest?slot=${slot}`,
    );
  }

  /** Testnet-only funded seed for signing txs when none is given (GET /live/v1/dev/funded-seed). */
  async fundedSeed(): Promise<string | undefined> {
    try {
      return (await this.get<{ seed?: string }>("/live/v1/dev/funded-seed")).seed;
    } catch {
      return undefined;
    }
  }
  /** Testnet-only funded-seed list (GET /live/v1/dev/funded-seeds?limit) — for `qinit seed` to pick from. */
  fundedSeeds(limit = 32) {
    return this.get<{ seeds: string[]; count: number }>(`/live/v1/dev/funded-seeds?limit=${limit}`);
  }

  /** Testnet-only current-epoch tick window (GET /live/v1/dev/epoch-info). */
  epochInfo() {
    return this.get<{
      epoch: number;
      tick: number;
      initialTick: number;
      epochLastTick: number;
      ticksLeft: number;
      duration: number;
    }>("/live/v1/dev/epoch-info");
  }
  /** Testnet-only: advance the chain by n ticks (GET /live/v1/dev/advance-tick?n). Capped at the epoch's last tick. */
  advanceTick(n: number) {
    return this.get<{
      from: number;
      requested: number;
      target: number;
      reached: number;
      epochLastTick: number;
      cappedAtEpochEnd: boolean;
    }>(`/live/v1/dev/advance-tick?n=${n}`);
  }
  /** Testnet-only: advance to epochLastTick - gap (GET /live/v1/dev/advance-to-last?gap), default gap 3. */
  advanceToLast(gap = 3) {
    return this.get<{
      from: number;
      target: number;
      reached: number;
      epochLastTick: number;
      epoch: number;
    }>(`/live/v1/dev/advance-to-last?gap=${gap}`);
  }
  /** Testnet-only: advance to the next epoch via the node's seamless transition (GET /live/v1/dev/advance-epoch). */
  advanceEpoch() {
    return this.get<{
      fromEpoch: number;
      toEpoch: number;
      fromTick: number;
      tick: number;
      initialTick: number;
      switched: boolean;
    }>("/live/v1/dev/advance-epoch");
  }
  /** Set the simulator tick interval without restarting it. */
  setTickMs(ms: number) {
    return this.get<{ tickMs: number }>(`/live/v1/dev/tick-ms?ms=${ms}`);
  }

  /** Broadcast a signed tx (POST /live/v1/broadcast-transaction) — folded into NodeTransport. */
  broadcastTx(txBytes: Uint8Array) {
    return netBroadcastTx(txBytes, this.base);
  }

  /** Call a contract function (read-only) via POST /live/v1/querySmartContract. */
  async querySmartContract(
    contractIndex: number,
    inputType: number,
    input: Uint8Array,
  ): Promise<Uint8Array> {
    let r: Response;
    try {
      r = await fetchWithTimeout(
        this.base + "/live/v1/querySmartContract",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            contractIndex,
            inputType,
            inputSize: input.length,
            requestData: Buffer.from(input).toString("base64"),
          }),
        },
        15000,
      );
    } catch (e: any) {
      throw new Error(
        `node unreachable at ${this.base} — is it running? (qinit node run)  [${e?.message ?? e}]`,
      );
    }
    const j: any = await r.json().catch(() => ({}));
    if (typeof j.responseData !== "string")
      throw new Error(`querySmartContract: code=${j.code} ${j.message ?? r.status}`);
    return new Uint8Array(Buffer.from(j.responseData, "base64"));
  }

  /** Dev-only: store a deployed contract's .h source on the node (POST /live/v1/dev/contract-source?slot=N,
   *  body = raw source) so inter-contract callers can resolve callees from the registry without --callee. */
  async putContractSource(slot: number, source: string): Promise<boolean> {
    try {
      const r = await fetchWithTimeout(
        this.base + `/live/v1/dev/contract-source?slot=${slot}`,
        {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: source,
        },
        15000,
      );
      return r.ok;
    } catch {
      return false;
    }
  }

  /** Single-authority simulator deploy without chunk upload.
   * Returns null when the route is absent so callers can use the protocol path. */
  async directDeploy(
    slot: number,
    wasm: Uint8Array,
    name: string,
  ): Promise<{ ok: boolean; slot: number; digest: string } | null> {
    let r: Response;
    try {
      r = await fetchWithTimeout(
        this.base + "/live/v1/dev/deploy",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slot, name, wasm: Buffer.from(wasm).toString("base64") }),
        },
        30000,
      );
    } catch (e: any) {
      throw new Error(
        `node unreachable at ${this.base} — is it running? (qinit node run)  [${e?.message ?? e}]`,
      );
    }
    if (r.status === 404) return null;
    const j: any = await r.json().catch(() => ({}));
    if (!j.ok) throw new Error(`direct-deploy failed: ${j.message ?? r.status}`);
    return j;
  }

  /** Remove a deployed contract. This development endpoint is simulator-only. */
  async undeploy(slot: number): Promise<boolean> {
    const r = await fetchWithTimeout(
      this.base + `/live/v1/dev/undeploy?slot=${slot}`,
      { method: "POST" },
      15000,
    );
    if (r.status === 404) throw new Error("undeploy is simulator-only");
    const j: any = await r.json().catch(() => ({}));
    return !!j.ok;
  }

  /** Spectrum balance / entity (GET /live/v1/balances/{id}). */
  async balance(id: string): Promise<EntityInfo> {
    const j = await this.get<{ balance?: Record<string, unknown> }>(`/live/v1/balances/${id}`);
    const b = j.balance ?? {};
    return {
      id: String(b.id ?? id),
      balance: String(b.balance ?? "0"),
      incomingAmount: String(b.incomingAmount ?? "0"),
      outgoingAmount: String(b.outgoingAmount ?? "0"),
      numberOfIncomingTransfers: Number(b.numberOfIncomingTransfers ?? 0),
      numberOfOutgoingTransfers: Number(b.numberOfOutgoingTransfers ?? 0),
      latestIncomingTransferTick: Number(b.latestIncomingTransferTick ?? 0),
      latestOutgoingTransferTick: Number(b.latestOutgoingTransferTick ?? 0),
    };
  }

  /** Aggregate explorer dashboard payload (GET /explorer/data) — one round trip for the overview. */
  explorerData() {
    return this.get<ExplorerData>("/explorer/data");
  }

  /** Tick header (POST /query/v1/getTickData). Null when the tick is empty or out of range. */
  async getTickData(tick: number): Promise<ExplorerTickData | null> {
    const { status, json } = await this.post<Record<string, unknown>>(
      "/query/v1/getTickData",
      { tickNumber: tick },
    );
    if (status === 404) return null;
    return {
      tickNumber: Number(json.tickNumber ?? tick),
      epoch: Number(json.epoch ?? 0),
      computorIndex: Number(json.computorIndex ?? 0),
      timestamp: String(json.timestamp ?? ""),
      timelock: String(json.timelock ?? ""),
      transactionDigests: Array.isArray(json.transactionDigests)
        ? json.transactionDigests.map(String)
        : [],
      signature: String(json.signature ?? ""),
    };
  }

  /** Every transaction in a tick, in the explorer's full shape (POST /query/v1/getTransactionsForTick). */
  async explorerTickTransactions(tick: number): Promise<ExplorerTx[]> {
    const { json } = await this.post<{ transactions?: Record<string, unknown>[] }>(
      "/query/v1/getTransactionsForTick",
      { tickNumber: tick },
    );
    const txs = Array.isArray(json.transactions) ? json.transactions : [];
    return txs.map((t) => explorerTx({ tickNumber: tick, ...t }));
  }

  /** One transaction by hash (POST /query/v1/getTransactionByHash). A tick bounds the node's scan. */
  async getTransactionByHash(hash: string, tick?: number): Promise<ExplorerTx | null> {
    const { status, json } = await this.post<Record<string, unknown>>(
      "/query/v1/getTransactionByHash",
      tick != null ? { hash, tickNumber: tick } : { hash },
    );
    if (status === 404 || typeof json.hash !== "string") return null;
    return explorerTx(json);
  }

  /** Recent transfers touching an identity (POST /query/v1/getTransfersForIdentity). */
  async getTransfersForIdentity(
    identity: string,
    limit = 50,
  ): Promise<{ count: number; transactions: IdentityTransfer[] }> {
    const { json } = await this.post<{
      count?: unknown;
      transactions?: Record<string, unknown>[];
    }>("/query/v1/getTransfersForIdentity", { identity, direction: "both", limit });
    const txs = Array.isArray(json.transactions) ? json.transactions : [];
    return {
      count: Number(json.count ?? txs.length),
      transactions: txs.map((t) => ({
        ...explorerTx(t),
        direction: t.direction === "out" ? "out" : "in",
      })),
    };
  }

  /** Contract calls in a tick window (POST /query/v1/getContractCalls), optionally one contract. */
  async getContractCalls(options: {
    fromTick: number;
    toTick: number;
    contractIndex?: number;
    page?: number;
    pageSize?: number;
  }): Promise<ContractCallsPage> {
    const { json } = await this.post<Record<string, unknown>>("/query/v1/getContractCalls", {
      fromTick: options.fromTick,
      toTick: options.toTick,
      ...(options.contractIndex != null ? { contractIndex: options.contractIndex } : {}),
      page: options.page ?? 0,
      pageSize: options.pageSize ?? 50,
    });
    const txs = Array.isArray(json.transactions)
      ? (json.transactions as Record<string, unknown>[])
      : [];
    return {
      fromTick: Number(json.fromTick ?? options.fromTick),
      toTick: Number(json.toTick ?? options.toTick),
      total: Number(json.total ?? txs.length),
      page: Number(json.page ?? options.page ?? 0),
      pageSize: Number(json.pageSize ?? options.pageSize ?? 50),
      transactions: txs.map((t) => ({
        ...explorerTx(t),
        contractIndex: Number(t.contractIndex ?? 0),
      })),
    };
  }

  /** Contract catalog known to the node (GET /query/v1/getContracts). */
  async getContracts(): Promise<{ contracts: ContractListEntry[] }> {
    const json = await this.get<{ contracts?: Record<string, unknown>[] }>(
      "/query/v1/getContracts",
    );
    const list = Array.isArray(json.contracts) ? json.contracts : [];
    return {
      contracts: list.map((c) => ({
        index: Number(c.index ?? 0),
        name: String(c.name ?? ""),
        constructionEpoch: Number(c.constructionEpoch ?? 0),
        destructionEpoch: Number(c.destructionEpoch ?? 0),
        stateSize: Number(c.stateSize ?? 0),
      })),
    };
  }

  /** Transactions in a tick (POST /query/v1/getTransactionsForTick) — lite tickdata. */
  async tickTransactions(tick: number): Promise<TxInfo[]> {
    try {
      const r = await fetchWithTimeout(
        this.base + "/query/v1/getTransactionsForTick",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tickNumber: tick }),
        },
        10000,
      );
      const j = (await r.json().catch(() => ({}))) as { transactions?: Record<string, unknown>[] };
      const txs = Array.isArray(j.transactions) ? j.transactions : [];
      return txs.map((t) => ({
        txId: String(t.hash ?? t.txId ?? t.transactionId ?? ""),
        tick,
        source: String(t.sourceId ?? t.source ?? ""),
        dest: String(t.destId ?? t.destination ?? ""),
        amount: String(t.amount ?? "0"),
        inputType: Number(t.inputType ?? 0),
        moneyFlew: Boolean(t.moneyFlew ?? true),
      }));
    } catch {
      return [];
    }
  }
}
