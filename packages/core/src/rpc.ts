// Client for the qubic-core-lite built-in HTTP RPC (GET-only; default :41841).
// Fast path for on-chain reads — current tick, spectrum, and (later) the deploy registry.
export interface TickInfo {
  tick: number;
  epoch: number;
  [k: string]: unknown;
}

export interface DynEntry { inputType: number; inputSize: number; outputSize: number; }
export interface DynContract {
  index: number; constructed: boolean; version: number; codeHash: string;
  functions: DynEntry[]; procedures: DynEntry[];
}
export interface DynRegistry { contracts: DynContract[]; }

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
}
