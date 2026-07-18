// Headless background entry (the hidden `__serve` subcommand). Runs the in-process TS engine as a persistent
// node on a fixed RPC port so `qinit mode virtualnode` makes every node command (node run/deploy/call/state/
import { EngineServer } from "@qinit/engine/server";
import { VirtualNode } from "@qinit/engine";
import type { WasmSlotLayout } from "@qinit/core";
import { systemWasm } from "./system-wasm";

// RPC base -> the port the virtual node binds. Defaults to the standard dev-node port when none is given.
export function portFromRpc(rpcBase: string): number {
  return Number(new URL(rpcBase).port || "41841");
}

// Seed the user-chosen built-in system contracts onto the node (compile/cache + direct deploy). Runs AFTER
// start() (needs initK12) and concurrently with serving — a first-run compile doesn't block RPC/ticking; cached
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

// The persistent dev node ticks once per second by default (readable counter, real-node-ish cadence); the
// caller can lower it (down to 0 = as fast as the event loop allows) via `qinit node run --tick-ms`.
export const DEFAULT_TICK_MS = 1000;

export async function serveEngine(
  rpcBase: string,
  tickMs?: number,
  system: string[] = [],
  peerPort = 21841,
  slotLayout?: WasmSlotLayout,
): Promise<never> {
  const ms = Number.isFinite(tickMs) ? Math.max(0, tickMs as number) : DEFAULT_TICK_MS;
  const srv = new EngineServer(new VirtualNode(slotLayout));
  await srv.start(portFromRpc(rpcBase), ms, peerPort);
  process.stdout.write(`qinit virtual node: rpc ${rpcBase} · peer 127.0.0.1:${peerPort}\n`);
  await seedSystemContracts(srv, system);

  // Keep the process alive indefinitely — EngineServer auto-advances ticks on its own interval, and the
  // process is reaped by killNode (SIGKILL), so there is nothing to await or clean up here.
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}
