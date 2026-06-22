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
  const engine = new InProcessEngine({ mempool: true, verifySigs: true });
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
    // -getasset queries ownership AND possession; the bridge now serves both
    expect(out).toContain("======== OWNERSHIP ========");
    expect(out).toContain("======== POSSESSION ========");
    expect(out).toContain("Owner ID:"); // printed only in the possession section
  } finally {
    stop();
  }
});

it("-gettickdata + -readtickdata verify the leader's signed TickData", async () => {
  const { port, stop } = await serve();
  try {
    const tdFile = "/tmp/qinit-cli-td.bin";
    const compFile = "/tmp/qinit-cli-td-comps.bin";
    await runCli(port, ["-getcomputorlist", compFile]);

    // tick 3 is finalized: the server pre-advances 5 ticks before it starts serving.
    const got = await runCli(port, ["-gettickdata", "3", tdFile]);
    expect(got).toContain("Found");
    expect(got).toContain("written to");

    const read = await runCli(port, ["-readtickdata", tdFile, compFile]);
    expect(read).toContain("Tick is VERIFIED"); // leader signature checks against computors[tick % N]
    expect(read).toContain("Epoch: 1");
    expect(read).toMatch(/Tick: 3\b/);
  } finally {
    stop();
  }
});

it("a scheduled tx lands in its tick's TickData (-gettickdata finds it, -readtickdata verifies)", async () => {
  const { port, stop } = await serve();
  try {
    const dest = (await deriveIdentity("b".repeat(55))).identity;
    const sent = await runCli(port, ["-seed", "a".repeat(55), "-sendtoaddress", dest, "1"]);
    const hint = sent.match(/-checktxontick (\d+) ([a-z]+)/);
    expect(hint).not.toBeNull();
    const txTick = Number(hint![1]);

    // wait for the auto-ticking chain to pass the scheduled tick (offset 8, tick 50ms)
    for (let i = 0; i < 80; i++) {
      const cur = (await runCli(port, ["-getcurrenttick"])).match(/Tick:\s*(\d+)/);
      if (cur && Number(cur[1]) > txTick) {
        break;
      }
      await Bun.sleep(50);
    }

    const tdFile = "/tmp/qinit-cli-txtd.bin";
    const compFile = "/tmp/qinit-cli-txtd-comps.bin";
    await runCli(port, ["-getcomputorlist", compFile]);

    const got = await runCli(port, ["-gettickdata", String(txTick), tdFile]);
    expect(got).toContain(`Found 1 transactions in tick ${txTick}`);

    const read = await runCli(port, ["-readtickdata", tdFile, compFile]);
    expect(read).toContain("Tick is VERIFIED");
    expect(read).toContain("Total number of transaction digests: 1");
  } finally {
    stop();
  }
});

it("-getsysteminfo reports the version + entity count", async () => {
  const { port, stop } = await serve();
  try {
    const out = await runCli(port, ["-getsysteminfo"]);
    expect(out).toContain("Version:");
    expect(out).toContain("NumberOfEntities:");
  } finally {
    stop();
  }
});

it("-getquorumtick returns the tick's verifiable votes", async () => {
  const { port, stop } = await serve();
  try {
    const compFile = "/tmp/qinit-cli-qt-comps.bin";
    await runCli(port, ["-getcomputorlist", compFile]);

    // tick 3 is finalized (the server pre-advances 5 ticks); the cli parses the 352-byte Tick votes
    const out = await runCli(port, ["-getquorumtick", compFile, "3"]);
    expect(out).toContain("quorum tick #3");
    expect(out).toContain("Number of unique votes:");
  } finally {
    stop();
  }
});

it("-sendcustomtransaction runs a contract procedure over the wire, and -gettxinfo returns its receipt", async () => {
  const counter = await wasm("Counter");
  const { port, stop } = await serve((e) => {
    e.deploy(28, counter, "Counter");
  });
  try {
    const id = await bytesToIdentity(contractId(28));
    // inputType 1 = Counter Inc; amount 0; no extra data
    const sent = await runCli(port, ["-seed", "a".repeat(55), "-sendcustomtransaction", id, "1", "0", "0", ""]);
    const hint = sent.match(/-checktxontick (\d+) ([a-z]+)/);
    expect(hint).not.toBeNull();
    const txTick = Number(hint![1]);
    const txHash = hint![2];

    // the raw tx is retrievable immediately (indexed at broadcast, before the tick)
    const info = await runCli(port, ["-gettxinfo", txHash]);
    expect(info).toContain("~~~~~RECEIPT~~~~~");

    // wait for the procedure's tick to be processed, then read the Counter
    for (let i = 0; i < 80; i++) {
      const cur = (await runCli(port, ["-getcurrenttick"])).match(/Tick:\s*(\d+)/);
      if (cur && Number(cur[1]) > txTick) {
        break;
      }
      await Bun.sleep(50);
    }

    const out = await runCli(port, ["-callcontractfunction", "28", "1", "", "uint64"]);
    expect(out).toContain("Contract Function Output");
    expect(out).toMatch(/\b1\b/); // Inc applied once -> Get == 1
  } finally {
    stop();
  }
});
