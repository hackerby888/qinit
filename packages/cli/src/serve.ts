// Headless background entry (the hidden `__serve` subcommand). Runs the in-process TS engine as a persistent
// node on a fixed RPC port so `qinit mode virtualnode` makes every node command (up/deploy/call/state/dev/...)
// talk to the engine over HTTP exactly like a real qubic node. Spawned detached by launchVirtualNode; the
// parent writes the pidfile, so killNode / nodeAlive / `qinit node stop` track it the same as a real node.
import { EngineServer } from "@qinit/engine/server";

export async function serveEngine(rpcBase: string): Promise<never> {
  const port = Number(new URL(rpcBase).port || "41841");
  const srv = new EngineServer();
  await srv.start(port);

  // Keep the process alive indefinitely — EngineServer auto-advances ticks on its own interval, and the
  // process is reaped by killNode (SIGKILL), so there is nothing to await or clean up here.
  await new Promise<never>(() => {});
  throw new Error("unreachable");
}
