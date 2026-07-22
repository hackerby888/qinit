// Verifies tick and epoch lifecycle hooks, including boundary ordering.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)

// Get_output is { ticks, endticks, epochs, endepochs } — four uint64 LE, read by field index.
function field(b: Uint8Array, i: number): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(i * 8, true);
}
function counters(sim: Sim): [bigint, bigint, bigint, bigint] {
  const s = sim.query(28, GET);
  return [field(s, 0), field(s, 1), field(s, 2), field(s, 3)];
}
test("BEGIN_TICK / END_TICK fire on every advanced tick", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Hooks"));

  // Deploy runs INITIALIZE only — no tick/epoch hook has fired yet.
  expect(counters(sim)).toEqual([0n, 0n, 0n, 0n]);

  for (let i = 0; i < 10; i++) {
    sim.advance(); // 10 ticks, no epoch boundary (epochLength defaults to 3000)
  }

  const [ticks, endticks, epochs, endepochs] = counters(sim);
  expect(ticks).toBe(10n); // BEGIN_TICK x10
  expect(endticks).toBe(10n); // END_TICK x10
  expect(epochs).toBe(0n); // no boundary crossed -> no BEGIN_EPOCH
  expect(endepochs).toBe(0n);
  expect(sim.epochN).toBe(0);
});

test("crossing an epoch boundary fires END_EPOCH then BEGIN_EPOCH", async () => {
  await initK12();
  const sim = new Sim();
  sim.epochLength = 10; // short epoch so the test crosses a boundary quickly
  sim.deploy(28, await wasm("Hooks"));

  for (let i = 0; i < 9; i++) {
    sim.advance(); // ticks 1..9 — still inside epoch 0
  }
  expect(sim.tickN).toBe(9);
  expect(sim.epochN).toBe(0);
  expect(counters(sim)).toEqual([9n, 9n, 0n, 0n]);

  sim.advance(); // tick 10 == boundary -> END_EPOCH, epoch++, BEGIN_EPOCH, then BEGIN_TICK/END_TICK
  expect(sim.tickN).toBe(10);
  expect(sim.epochN).toBe(1);
  expect(counters(sim)).toEqual([10n, 10n, 1n, 1n]);

  for (let i = 0; i < 10; i++) {
    sim.advance(); // a whole second epoch
  }
  expect(sim.epochN).toBe(2);
  const [ticks, endticks, epochs, endepochs] = counters(sim);
  expect(ticks).toBe(20n);
  expect(endticks).toBe(20n);
  expect(epochs).toBe(2n); // BEGIN_EPOCH fired at tick 10 and tick 20
  expect(endepochs).toBe(2n); // END_EPOCH likewise
});
