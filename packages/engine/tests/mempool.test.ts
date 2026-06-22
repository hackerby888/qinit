// Mempool mode (opt-in): a broadcast tx is deferred to its scheduled tick — applied + recorded there — instead
// of immediately. Off by default, so the rest of the engine keeps immediate-apply semantics.
import { test, expect } from "bun:test";
import { initK12 } from "../src/k12";
import { Sim } from "../src/sim";

const FIX = import.meta.dir + "/fixtures";
const INC = 1; // Counter Inc procedure
const GET = 1; // Counter Get function
const EMPTY = new Uint8Array(0);

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

function contractId(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}

test("mempool mode: a tx applies + is recorded at its scheduled tick, not before", async () => {
  await initK12();
  const sim = new Sim({ mempool: true });
  sim.deploy(28, await wasm("Counter"));

  const scheduled = sim.tickN + 3;
  sim.enqueueTx(scheduled, new Uint8Array(32).fill(0x11), contractId(28), 0n, INC, EMPTY, "tx-sched");

  // deferred: not applied, not recorded yet
  expect(u64(sim.query(28, GET))).toBe(0n);
  expect(sim.tickTransactions(scheduled).length).toBe(0);

  while (sim.tickN < scheduled) {
    sim.advance();
  }

  expect(u64(sim.query(28, GET))).toBe(1n); // Inc ran at its tick
  const recs = sim.tickTransactions(scheduled);
  expect(recs.length).toBe(1);
  expect(recs[0].txId).toBe("tx-sched"); // recorded under the scheduled tick (what checktxontick queries)
});

test("mempool mode: a tx scheduled for a past/current tick applies immediately", async () => {
  await initK12();
  const sim = new Sim({ mempool: true });
  sim.deploy(28, await wasm("Counter"));

  sim.enqueueTx(sim.tickN, new Uint8Array(32), contractId(28), 0n, INC, EMPTY, "tx-now");
  expect(u64(sim.query(28, GET))).toBe(1n);
});

test("mempool off (default): a tx with a future tick still applies immediately", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Counter"));

  sim.enqueueTx(sim.tickN + 5, new Uint8Array(32), contractId(28), 0n, INC, EMPTY, "tx-imm");
  expect(u64(sim.query(28, GET))).toBe(1n); // immediate-apply semantics preserved
});
