// Run the persistent in-process engine behind the hidden `__serve` command.
import { EngineServer } from "@qinit/engine/server";
import { VirtualNode } from "@qinit/engine";
import {
  DEFAULT_PEER_PORT,
  DEFAULT_RPC_PORT,
  LOOPBACK_HOST,
  type WasmSlotLayout,
} from "@qinit/core";
import { systemWasm } from "./system-wasm";

// RPC base -> simulator port. Use the standard development port when none is given.
export function portFromRpc(rpcBaseUrl: string): number {
  return Number(new URL(rpcBaseUrl).port || DEFAULT_RPC_PORT);
}

// Seed configured system contracts after startup without blocking RPC or ticking.
async function seedSystemContracts(srv: EngineServer, names: string[]): Promise<void> {
  for (const name of names) {
    try {
      const w = await systemWasm(name);
      srv.engine.deploy(w.index, w.wasm, w.name);
    } catch (e: any) {
      process.stderr.write(
        `qinit __serve: system contract '${name}' not seeded: ${String(e?.message ?? e)}\n`,
      );
    }
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
): Promise<never> {
  const ms = Number.isFinite(tickMs) ? Math.max(0, tickMs as number) : DEFAULT_TICK_MS;
  const srv = new EngineServer(new VirtualNode(slotLayout));
  await srv.start(portFromRpc(rpcBaseUrl), ms, peerPort);
  process.stdout.write(
    `qinit simulator: rpc ${rpcBaseUrl} · peer ${LOOPBACK_HOST}:${peerPort}\n`,
  );
  await seedSystemContracts(srv, system);

  // Keep the process alive indefinitely — EngineServer auto-advances ticks on its own interval, and the
  // process is reaped by killNode (SIGKILL), so there is nothing to await or clean up here.
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}
