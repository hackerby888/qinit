// Client for the qubic-core-lite built-in HTTP RPC (GET-only; default :41841).
// Fast path for on-chain reads — current tick, spectrum, and (later) the deploy registry.
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

export class LiteRpc {
  constructor(private base = "http://127.0.0.1:41841") {}

  private async get<T = unknown>(path: string): Promise<T> {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error(`RPC GET ${path} -> ${r.status}`);
    return (await r.json()) as T;
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

  /** Call a contract function (read-only) via POST /live/v1/querySmartContract. */
  async querySmartContract(contractIndex: number, inputType: number, input: Uint8Array): Promise<Uint8Array> {
    const r = await fetch(this.base + "/live/v1/querySmartContract", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contractIndex, inputType, inputSize: input.length,
        requestData: Buffer.from(input).toString("base64"),
      }),
    });
    const j: any = await r.json().catch(() => ({}));
    if (typeof j.responseData !== "string") throw new Error(`querySmartContract: code=${j.code} ${j.message ?? r.status}`);
    return new Uint8Array(Buffer.from(j.responseData, "base64"));
  }

  /** Dev-only: store a deployed contract's .h source on the node (POST /live/v1/dev/contract-source?slot=N,
   *  body = raw source) so inter-contract callers can resolve callees from the registry without --callee. */
  async putContractSource(slot: number, source: string): Promise<boolean> {
    try {
      const r = await fetch(this.base + `/live/v1/dev/contract-source?slot=${slot}`, {
        method: "POST", headers: { "content-type": "text/plain" }, body: source,
      });
      return r.ok;
    } catch { return false; }
  }
}
