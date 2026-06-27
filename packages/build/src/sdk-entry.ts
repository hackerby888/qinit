// The test-SDK surface, assembled from the REAL @qinit source so the emitted runtime can't drift from the
// codec/tx/rpc the rest of qinit uses. A build step (scripts/gen-runtime.ts) bundles this into a single
// self-contained file (assets/test-runtime.gen.ts) with @qubic-lib left external — that file is what
// `qinit test` / `qinit gen` write into a user's project as runtime.ts. The only hand-written part is the
// test glue below (env-injected provider + settle + the oracle dev seam), which has no home in the packages.
export { deriveIdentity, bytesToIdentity, identityToBytes, buildSignedTx, broadcastTx, initK12, LiteRpc } from "@qinit/core/browser";
export { encodeInput, decodeOutput, callFunction, invokeProcedure, contractAddress } from "@qinit/proto";
import { LiteRpc } from "@qinit/core/browser";

const ORACLE_STATUS_SUCCESS = 3;

// ---------------- test provider (env injected by `qinit test`) ----------------
export interface Provider { rpcBase: string; seed?: string; index?: number }
const RPC_BASE = () => process.env.QINIT_RPC || "http://127.0.0.1:41841";
export function provider(): Provider {
  return { rpcBase: RPC_BASE(), seed: process.env.QINIT_SEED || undefined, index: process.env.QINIT_CONTRACT ? Number(process.env.QINIT_CONTRACT) : undefined };
}
export function rpc(): LiteRpc { return new LiteRpc(RPC_BASE()); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Wait until the node tick advances by `ticks` from now (procedures broadcast a few ticks ahead).
export async function settle(ticks = 12, timeoutMs = 30000): Promise<number> {
  const r = rpc();
  const start = Date.now();
  const cur = async () => { try { return (await r.tickInfo()).tick ?? 0; } catch { return 0; } };
  const t0 = await cur();
  for (;;) {
    const t = await cur();
    if (t >= t0 + ticks) return t;
    if (Date.now() - start > timeoutMs) return t;
    await sleep(300);
  }
}

// ---------------- oracle dev/test seam (virtual node only) ----------------
export async function oraclePending(rpcBase = RPC_BASE()): Promise<{ queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[]> {
  const r = await fetch(rpcBase + "/live/v1/dev/oracle-pending");
  if (!r.ok) throw new Error("oracle-pending -> " + r.status);
  const j: any = await r.json();
  return (j.queries ?? []).map((q: any) => ({ queryId: BigInt(q.queryId), slot: q.slot, interfaceIndex: q.interfaceIndex, query: new Uint8Array(Buffer.from(q.query, "base64")) }));
}

export async function resolveOracle(queryId: bigint, reply: Uint8Array, opts: { status?: number; rpcBase?: string } = {}): Promise<boolean> {
  const r = await fetch((opts.rpcBase ?? RPC_BASE()) + "/live/v1/dev/oracle-resolve", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ queryId: queryId.toString(), reply: Buffer.from(reply).toString("base64"), status: opts.status ?? ORACLE_STATUS_SUCCESS }),
  });
  if (!r.ok) throw new Error("oracle-resolve -> " + r.status);
  return (await r.json()).ok === true;
}
