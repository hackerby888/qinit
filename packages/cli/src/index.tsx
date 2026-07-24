#!/usr/bin/env bun
// Qinit CLI entry — the standalone-binary compile target (`bun build --compile`).
import { render } from "ink";
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

// Hidden background entry: the virtualnode backend (a detached in-process engine). Runs headless — no Ink,
// no exit — so it stays up serving RPC like a real node. Must short-circuit before render().
if (command === "__serve") {
  const { serveEngine } = await import("./serve");
  const { flags } = parseArgs(args, {
    strings: [
      "rpc",
      "tick-ms",
      "system",
      "peer-port",
      "slot-base",
      "slot-count",
    ],
  });
  const rpc = flags.rpc || "http://127.0.0.1:41841";
  const system = flags.system?.split(",").filter(Boolean) ?? [];
  await serveEngine(
    rpc,
    flags["tick-ms"] !== undefined ? Number(flags["tick-ms"]) : undefined,
    system,
    flags["peer-port"] !== undefined ? Number(flags["peer-port"]) : 21841,
    flags["slot-base"] !== undefined && flags["slot-count"] !== undefined
      ? {
          slotBase: Number(flags["slot-base"]),
          slotCount: Number(flags["slot-count"]),
        }
      : undefined,
  );
}

initOutput(args); // detect --json / --plain (and auto-plain when piped / NO_COLOR) before rendering
const { waitUntilExit } = render(<App command={command} args={args} />);
await waitUntilExit();
