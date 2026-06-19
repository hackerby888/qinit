// Client for the qubic-core-lite built-in HTTP RPC (GET-only; default :41841).
// Fast path for on-chain reads — current tick, spectrum, and (later) the deploy registry.
import { fetchT, broadcastTx as netBroadcastTx } from "./net";
import type { NodeTransport, EntityInfo, TxInfo } from "./transport";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface TickInfo {
  tick: number;
  epoch: number;
  [k: string]: unknown;
}

export interface DynEntry { inputType: number; inputSize: number; outputSize: number; }
export interface DynContract {
  index: number; armed: boolean; constructed: boolean; version: number; name: string; codeHash: string;
  functions: DynEntry[]; procedures: DynEntry[]; source?: string; lastError?: string;
}
export interface DynRegistry { contracts: DynContract[]; slotBase: number; slotCount: number; }

export interface DynUpload {
  active: boolean; sessionId: string; totalSize: number; chunkSize: number;
  chunkCount: number; receivedCount: number; complete: boolean; finalHash: string;
  missing: number[]; missingCount: number;
}

export interface DebugHostCall { name: string; detail: string; }
export interface DebugStateRegion { off: number; before: string; after: string; }  // changed byte run (hex)
export interface DebugLog { type: number; size: number; hex: string; }              // a LOG_* call (numeric struct bytes)
export interface DebugEntry {
  seq: number; tick: number; index: number; entry: number; kind: number; ok: boolean;
  execNs: number; inSize: number; outSize: number; stateSize: number; stateTruncated: boolean;
  invocator: string; invocationReward: number;
  inHex: string; outHex: string; stateDiff: DebugStateRegion[];
  trap?: string; hostCalls: DebugHostCall[]; logs: DebugLog[];
}
export interface DebugTrace { enabled: boolean; entries: DebugEntry[]; }

export class LiteRpc implements NodeTransport {
  constructor(private base = "http://127.0.0.1:41841") {}

  // GETs are idempotent reads: a connect/timeout failure is retried (bounded, backoff) so a momentary
  // blip during node boot/load doesn't fail the command. An HTTP non-2xx is a real answer -> not retried.
  private async get<T = unknown>(path: string, tries = 3): Promise<T> {
    for (let a = 0; ; a++) {
      let r: Response;
      try { r = await fetchT(this.base + path, undefined, 10000); }
      catch (e: any) {
        if (a < tries - 1) { await sleep(200 * (a + 1)); continue; }
        throw new Error(`node unreachable at ${this.base} — is it running? (qinit up)  [${e?.message ?? e}]`);
      }
      if (!r.ok) throw new Error(`RPC GET ${path} → HTTP ${r.status}`);
      try { return (await r.json()) as T; }
      catch { throw new Error(`RPC GET ${path}: malformed JSON response from the node`); }
    }
  }

  /** Current tick / epoch — used to stamp outgoing transactions. */
  tickInfo() {
    return this.get<TickInfo>("/tick-info");
  }
  latestCreatedTickInfo() {
    return this.get<TickInfo>("/latest-created-tick-info");
  }
  /** Escape hatch for any GET route (e.g. a future /dyn/registry). */
  raw<T = unknown>(path: string) {
    return this.get<T>(path);
  }

  /** Deployed dynamic contracts + their fn/proc inputTypes (GET /live/v1/dyn-registry). */
  dynRegistry() {
    return this.get<DynRegistry>("/live/v1/dyn-registry");
  }

  /** Active upload session — assembled chunk count + which seqs are still missing (GET /live/v1/dyn-upload).
   * Lets deploy confirm the node assembled the full .so (and resend only missing chunks) before DEPLOY. */
  dynUpload() {
    return this.get<DynUpload>("/live/v1/dyn-upload");
  }

  /** Exact tx confirmation (GET /live/v1/tx-status/{tick}/{txId}) — needs the tx-status addon.
   * found => included; processed => node ticked past {tick} (verdict final). */
  txStatus(tick: number, txId: string) {
    return this.get<{ tick: number; currentTick: number; txId: string; found: boolean; moneyFlew: boolean; processed: boolean }>(`/live/v1/tx-status/${tick}/${txId}`);
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
    return this.get<{ off: number; len: number; stateSize: number; hex: string }>(`/live/v1/dev/state-read?slot=${slot}&off=${off}&len=${len}`);
  }

  /** Testnet-only funded seed for signing txs when none is given (GET /live/v1/dev/funded-seed). */
  async fundedSeed(): Promise<string | undefined> {
    try { return (await this.get<{ seed?: string }>("/live/v1/dev/funded-seed")).seed; }
    catch { return undefined; }
  }
  /** Testnet-only funded-seed list (GET /live/v1/dev/funded-seeds?limit) — for `qinit seed` to pick from. */
  fundedSeeds(limit = 32) {
    return this.get<{ seeds: string[]; count: number }>(`/live/v1/dev/funded-seeds?limit=${limit}`);
  }

  /** Testnet-only current-epoch tick window (GET /live/v1/dev/epoch-info). */
  epochInfo() {
    return this.get<{ epoch: number; tick: number; initialTick: number; epochLastTick: number; ticksLeft: number; duration: number }>("/live/v1/dev/epoch-info");
  }
  /** Testnet-only: advance the chain by n ticks (GET /live/v1/dev/advance-tick?n). Capped at the epoch's last tick. */
  advanceTick(n: number) {
    return this.get<{ from: number; requested: number; target: number; reached: number; epochLastTick: number; cappedAtEpochEnd: boolean }>(`/live/v1/dev/advance-tick?n=${n}`);
  }
  /** Testnet-only: advance to epochLastTick - gap (GET /live/v1/dev/advance-to-last?gap), default gap 3. */
  advanceToLast(gap = 3) {
    return this.get<{ from: number; target: number; reached: number; epochLastTick: number; epoch: number }>(`/live/v1/dev/advance-to-last?gap=${gap}`);
  }
  /** Testnet-only: advance to the next epoch via the node's seamless transition (GET /live/v1/dev/advance-epoch). */
  advanceEpoch() {
    return this.get<{ fromEpoch: number; toEpoch: number; fromTick: number; tick: number; initialTick: number; switched: boolean }>("/live/v1/dev/advance-epoch");
  }

  /** Broadcast a signed tx (POST /live/v1/broadcast-transaction) — folded into NodeTransport. */
  broadcastTx(txBytes: Uint8Array) {
    return netBroadcastTx(txBytes, this.base);
  }

  /** Call a contract function (read-only) via POST /live/v1/querySmartContract. */
  async querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array> {
    let r: Response;
    try {
      r = await fetchT(this.base + "/live/v1/querySmartContract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contractIndex, inputType, inputSize: input.length,
          requestData: Buffer.from(input).toString("base64"),
        }),
      }, 15000);
    } catch (e: any) { throw new Error(`node unreachable at ${this.base} — is it running? (qinit up)  [${e?.message ?? e}]`); }
    const j: any = await r.json().catch(() => ({}));
    if (typeof j.responseData !== "string") throw new Error(`querySmartContract: code=${j.code} ${j.message ?? r.status}`);
    return new Uint8Array(Buffer.from(j.responseData, "base64"));
  }

  /** Dev-only: store a deployed contract's .h source on the node (POST /live/v1/dev/contract-source?slot=N,
   *  body = raw source) so inter-contract callers can resolve callees from the registry without --callee. */
  async putContractSource(slot: number, source: string): Promise<boolean> {
    try {
      const r = await fetchT(this.base + `/live/v1/dev/contract-source?slot=${slot}`, {
        method: "POST", headers: { "content-type": "text/plain" }, body: source,
      }, 15000);
      return r.ok;
    } catch { return false; }
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

  /** Transactions in a tick (POST /query/v1/getTransactionsForTick) — lite tickdata. */
  async tickTransactions(tick: number): Promise<TxInfo[]> {
    try {
      const r = await fetchT(this.base + "/query/v1/getTransactionsForTick", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tickNumber: tick }),
      }, 10000);
      const j = (await r.json().catch(() => ({}))) as { transactions?: Record<string, unknown>[] };
      const txs = Array.isArray(j.transactions) ? j.transactions : [];
      return txs.map((t) => ({
        txId: String(t.txId ?? t.transactionId ?? ""),
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
