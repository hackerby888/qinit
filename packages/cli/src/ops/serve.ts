// Run the persistent in-process engine behind the hidden `__serve` command.
import { EngineServer } from "@qinit/engine/server";
import { VirtualNode } from "@qinit/engine";
import { DEFAULT_PEER_PORT, DEFAULT_RPC_PORT, LOOPBACK_HOST, type WasmSlotLayout } from "@qinit/core";
import { systemContractClosure } from "@qinit/build";
import type { SystemContract, SystemContractCompiler } from "@qinit/build";
import { resolveCoreDir } from "../config";
import { systemWasm } from "../contracts/system-wasm";

// RPC base -> simulator port. Use the standard development port when none is given.
export function portFromRpc(rpcBaseUrl: string): number {
    return Number(new URL(rpcBaseUrl).port || DEFAULT_RPC_PORT);
}

// Seed configured system contracts after startup without blocking RPC or ticking.
async function seedSystemContracts(srv: EngineServer, names: string[], compiler: SystemContractCompiler): Promise<void> {
    const core = resolveCoreDir();
    const contracts = new Map<number, SystemContract>();
    for (const name of names) {
        for (const contract of systemContractClosure(core, name)) {
            contracts.set(contract.index, contract);
        }
    }

    const built = [];
    for (const contract of [...contracts.values()].sort((left, right) => left.index - right.index)) {
        built.push(await systemWasm(contract.name, undefined, compiler));
    }
    for (const contract of built) {
        srv.engine.deploy(contract.index, contract.wasm, contract.name);
    }
}

// The simulator ticks once per second by default. A zero interval runs as fast as the event loop allows.
export const DEFAULT_TICK_MS = 1000;

export async function serveEngine(
    rpcBaseUrl: string,
    tickMs?: number,
    system: string[] = [],
    peerPort = DEFAULT_PEER_PORT,
    slotLayout?: WasmSlotLayout,
    compiler: SystemContractCompiler = "clang",
    historyTicks?: number,
    liteTicking?: boolean,
): Promise<never> {
    const ms = Number.isFinite(tickMs) ? Math.max(0, tickMs as number) : DEFAULT_TICK_MS;
    const srv = new EngineServer(new VirtualNode({ ...slotLayout, historyTicks, liteTicking }));
    await srv.start(portFromRpc(rpcBaseUrl), ms, peerPort);
    process.stdout.write(`qinit simulator: rpc ${rpcBaseUrl} · peer ${LOOPBACK_HOST}:${peerPort}\n`);
    await seedSystemContracts(srv, system, compiler);

    // Keep the process alive indefinitely — EngineServer auto-advances ticks on its own interval, and the
    // process is reaped by killNode (SIGKILL), so there is nothing to await or clean up here.
    await new Promise<never>(() => {});
    throw new Error("unreachable");
}
