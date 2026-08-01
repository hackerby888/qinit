#!/usr/bin/env bun

// Qinit CLI entry — the standalone-binary compile target (`bun build --compile`).
import { render } from "ink";
import { DEFAULT_PEER_PORT, DEFAULT_RPC_BASE } from "@qinit/core";
import { App } from "./app";
import { applyTheme } from "./ui";
import { savedTheme } from "./config";
import { initOutput, parseArgs } from "./args";

// Safety net for async throws that escape a command's try/catch — print one clean line + exit 1
// (instead of a raw stack dump that can also leave the terminal in Ink raw-mode).
const die = (label: string, e: unknown) => {
  process.stderr.write(`\nqinit: ${label}: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
};
process.on("unhandledRejection", (e) => die("unhandled error", e));
process.on("uncaughtException", (e) => die("fatal error", e));

applyTheme(savedTheme()); // apply the saved color variant before anything renders

const [, , command = "help", ...args] = process.argv;

// Hidden background entry for the detached simulator. It runs headless without Ink,
// no exit — so it stays up serving RPC. Must short-circuit before render().
if (command === "__serve") {
  const { serveEngine } = await import("./serve");
  const commandArgs = parseArgs(args, {
    strings: [
      "rpc",
      "tick-ms",
      "system",
      "peer-port",
      "slot-base",
      "slot-count",
    ],
  });
  const rpc = commandArgs.get("rpc") || DEFAULT_RPC_BASE;
  const system = commandArgs.get("system")?.split(",").filter(Boolean) ?? [];
  const tickMs = commandArgs.get("tick-ms");
  const peerPort = commandArgs.get("peer-port");
  const slotBase = commandArgs.get("slot-base");
  const slotCount = commandArgs.get("slot-count");
  await serveEngine(
    rpc,
    tickMs !== undefined ? Number(tickMs) : undefined,
    system,
    peerPort !== undefined ? Number(peerPort) : DEFAULT_PEER_PORT,
    slotBase !== undefined && slotCount !== undefined
      ? {
          slotBase: Number(slotBase),
          slotCount: Number(slotCount),
        }
      : undefined,
  );
}

initOutput(args); // detect --json / --plain (and auto-plain when piped / NO_COLOR) before rendering
const { waitUntilExit } = render(<App command={command} args={args} />);
await waitUntilExit();
