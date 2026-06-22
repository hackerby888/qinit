// End-to-end against the real external CLI binary. Gated: runs only when QUBIC_CLI points at a built binary, so
// CI and machines without it skip. Each test stands up an in-process PeerServer on an ephemeral port, spawns
// the CLI against it, and asserts its stdout.
//   QUBIC_CLI=/path/to/qubic-cli bun test tests/cli-e2e.test.ts
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { initK12 } from "../src/k12";
import { InProcessEngine } from "../src/transport";
import { PeerServer } from "../src/peer-server";
import { deriveIdentity, bytesToIdentity } from "@qinit/core";

const CLI = process.env.QUBIC_CLI ?? "";
const have = CLI !== "" && existsSync(CLI);
const it = test.skipIf(!have);
const FIX = import.meta.dir + "/fixtures";

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

function contractId(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}

// Run the CLI against `port` and return its stdout.
async function runCli(port: number, args: string[]): Promise<string> {
  const proc = Bun.spawn([CLI, "-nodeip", "127.0.0.1", "-nodeport", String(port), ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// Start a PeerServer on an ephemeral port over a configured engine; returns the port + a stop fn.
async function serve(setup?: (e: InProcessEngine) => void | Promise<void>): Promise<{ port: number; stop: () => void }> {
  await initK12();
  const engine = new InProcessEngine({ mempool: true });
  if (setup) {
    await setup(engine);
  }
  const server = new PeerServer(engine);
  return server.start(0);
}

it("-getcurrenttick reports the tick + the quorum's aligned votes", async () => {
  const { port, stop } = await serve();
  try {
    const out = await runCli(port, ["-getcurrenttick"]);
    expect(out).toContain("Tick:");
    expect(out).toContain("Epoch: 1");
    expect(out).toMatch(/Number Of Aligned Votes:\s*8/);
  } finally {
    stop();
  }
});

it("-getbalance returns the funded-seed balance", async () => {
  const { port, stop } = await serve();
  try {
    const { identity } = await deriveIdentity("a".repeat(55));
    const out = await runCli(port, ["-getbalance", identity]);
    expect(out).toContain("Balance: 1000000000000");
  } finally {
    stop();
  }
});

it("-callcontractfunction returns a Counter value", async () => {
  const counter = await wasm("Counter");
  const { port, stop } = await serve((e) => {
    e.deploy(28, counter, "Counter");
    e.sim.procedure(28, 1); // Inc -> Get == 1
  });
  try {
    const out = await runCli(port, ["-callcontractfunction", "28", "1", "", "uint64"]);
    expect(out).toContain("Contract Function Output");
    expect(out).toMatch(/\b1\b/);
  } finally {
    stop();
  }
});

it("-getcomputorlist returns the committee identities", async () => {
  const { port, stop } = await serve();
  try {
    const out = await runCli(port, ["-getcomputorlist", "/tmp/qinit-cli-comps.bin"]);
    expect(out).toMatch(/^0\s+[A-Z]{60}/m); // computor 0 -> a 60-char identity
  } finally {
    stop();
  }
});

it("-getasset shows an issued asset's holding", async () => {
  const token = await wasm("Token");
  const { port, stop } = await serve((e) => {
    e.deploy(28, token, "Token"); // built for slot 28 -> SELF = id(28)
    const input = new Uint8Array(16);
    new DataView(input.buffer).setBigUint64(0, 0x4e454b4f54n, true); // "TOKEN"
    new DataView(input.buffer).setBigInt64(8, 1000n, true);
    e.sim.procedure(28, 1, input); // Issue
  });
  try {
    const id = await bytesToIdentity(contractId(28));
    const out = await runCli(port, ["-getasset", id]);
    expect(out).toContain("TOKEN");
    expect(out).toContain("Number Of Shares: 1000");
  } finally {
    stop();
  }
});
