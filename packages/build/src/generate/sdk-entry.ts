// Test SDK assembled from canonical Qinit codec, transaction, and RPC sources.
export { DEFAULT_RPC_BASE, deriveIdentity, bytesToIdentity, identityToBytes, buildSignedTx, broadcastTx, initK12, LiteRpc } from "@qinit/core/browser";
export { encodeInputFormat, encodeInputJson, decodeAbi, callFunction, invokeProcedure, sendTransfer, contractAddress } from "@qinit/proto";
import { DEFAULT_RPC_BASE, LiteRpc } from "@qinit/core/browser";

const ORACLE_STATUS_SUCCESS = 3;

// test provider (env injected by `qinit test`)
export interface Provider {
    rpcBaseUrl: string;
    seed?: string;
    index?: number;
    trace?: boolean;
}
const defaultRpcBaseUrl = () => process.env.QINIT_RPC || DEFAULT_RPC_BASE;
export function provider(): Provider {
    return {
        rpcBaseUrl: defaultRpcBaseUrl(),
        seed: process.env.QINIT_SEED || undefined,
        index: process.env.QINIT_CONTRACT ? Number(process.env.QINIT_CONTRACT) : undefined,
        // tracing snapshots state on every invoke, so a very large contract can opt out with QINIT_TRACE=0.
        trace: process.env.QINIT_TRACE !== "0",
    };
}
export function rpc(): LiteRpc {
    return new LiteRpc(defaultRpcBaseUrl());
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

// oracle dev/test seam, served by the simulator and by a testnet node alike
export function oraclePending(rpcBaseUrl = defaultRpcBaseUrl()): Promise<{ queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[]> {
    return new LiteRpc(rpcBaseUrl).oraclePending();
}

export async function resolveOracle(queryId: bigint, reply: Uint8Array, opts: { status?: number; rpcBaseUrl?: string } = {}): Promise<boolean> {
    const result = await new LiteRpc(opts.rpcBaseUrl ?? defaultRpcBaseUrl()).oracleResolve(queryId, reply, opts.status ?? ORACLE_STATUS_SUCCESS);
    return result.ok === true;
}
