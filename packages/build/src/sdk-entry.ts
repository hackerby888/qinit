// Test SDK assembled from canonical Qinit codec, transaction, and RPC sources.
export { deriveIdentity, bytesToIdentity, identityToBytes, buildSignedTx, broadcastTx, initK12, LiteRpc } from "@qinit/core/browser";
export { encodeInput, decodeOutput, callFunction, invokeProcedure, contractAddress } from "@qinit/proto";
import { LiteRpc } from "@qinit/core/browser";

const ORACLE_STATUS_SUCCESS = 3;

// ---------------- test provider (env injected by `qinit test`) ----------------
export interface Provider {
  rpcBase: string;
  seed?: string;
  index?: number;
}
const defaultRpcBase = () => process.env.QINIT_RPC || "http://127.0.0.1:41841";
export function provider(): Provider {
  return {
    rpcBase: defaultRpcBase(),
    seed: process.env.QINIT_SEED || undefined,
    index: process.env.QINIT_CONTRACT ? Number(process.env.QINIT_CONTRACT) : undefined,
  };
}
export function rpc(): LiteRpc {
  return new LiteRpc(defaultRpcBase());
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Wait until the node tick advances by `ticks` from now (procedures broadcast a few ticks ahead).
export async function settle(ticks = 12, timeoutMs = 30000): Promise<number> {
  const client = rpc();
  const start = Date.now();
  const currentTick = async () => {
    try {
      return (await client.tickInfo()).tick ?? 0;
    } catch {
      return 0;
    }
  };
  const initialTick = await currentTick();
  for (;;) {
    const tick = await currentTick();
    if (tick >= initialTick + ticks) return tick;
    if (Date.now() - start > timeoutMs) return tick;
    await sleep(300);
  }
}

// ---------------- oracle dev/test seam (virtual node only) ----------------
export async function oraclePending(
  rpcBase = defaultRpcBase(),
): Promise<{ queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[]> {
  const response = await fetch(rpcBase + "/live/v1/dev/oracle-pending");
  if (!response.ok) throw new Error("oracle-pending -> " + response.status);
  const payload: any = await response.json();
  return (payload.queries ?? []).map((query: any) => ({
    queryId: BigInt(query.queryId),
    slot: query.slot,
    interfaceIndex: query.interfaceIndex,
    query: new Uint8Array(Buffer.from(query.query, "base64")),
  }));
}

export async function resolveOracle(
  queryId: bigint,
  reply: Uint8Array,
  opts: { status?: number; rpcBase?: string } = {},
): Promise<boolean> {
  const response = await fetch((opts.rpcBase ?? defaultRpcBase()) + "/live/v1/dev/oracle-resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queryId: queryId.toString(),
      reply: Buffer.from(reply).toString("base64"),
      status: opts.status ?? ORACLE_STATUS_SUCCESS,
    }),
  });
  if (!response.ok) throw new Error("oracle-resolve -> " + response.status);
  return (await response.json()).ok === true;
}
