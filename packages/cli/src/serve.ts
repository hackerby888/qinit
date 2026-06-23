// Headless background entry (the hidden `__serve` subcommand). Runs the in-process TS engine as a persistent
// node on a fixed RPC port so `qinit mode virtualnode` makes every node command (node run/deploy/call/state/
// dev/...) talk to the engine over HTTP exactly like a real qubic node. Spawned detached by launchVirtualNode;
// the parent writes the pidfile, so killNode / nodeAlive / `qinit node stop` track it the same as a real node.
import { EngineServer } from "@qinit/engine/server";

// RPC base -> the port the virtual node binds. Defaults to the standard dev-node port when none is given.
export function portFromRpc(rpcBase: string): number {
  return Number(new URL(rpcBase).port || "41841");
}

// The persistent dev node ticks once per second by default (readable counter, real-node-ish cadence); the
// caller can lower it (down to 0 = as fast as the event loop allows) via `qinit node run --tick-ms`.
export const DEFAULT_TICK_MS = 1000;

export async function serveEngine(rpcBase: string, tickMs?: number): Promise<never> {
  const ms = Number.isFinite(tickMs) ? Math.max(0, tickMs as number) : DEFAULT_TICK_MS;
  const srv = new EngineServer();
  await srv.start(portFromRpc(rpcBase), ms);

  // Keep the process alive indefinitely — EngineServer auto-advances ticks on its own interval, and the
  // process is reaped by killNode (SIGKILL), so there is nothing to await or clean up here.
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}
