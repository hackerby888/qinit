// Redeploy migration converts matching old state into the new layout without reinitializing.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

const INC = 1; // REGISTER_USER_PROCEDURE(Inc, 1)
const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)

function u64(b: Uint8Array, i = 0): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(i * 8, true);
}

test("redeploy with MIGRATE() carries old state into the new layout", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("CounterV1")); // v1: StateData { counter }
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  expect(u64(sim.query(28, GET))).toBe(3n); // counter = 3

  // Advance so MIGRATE() observes a non-zero qpi.tick().
  for (let i = 0; i < 5; i++) {
    sim.advance();
  }

  sim.deploy(28, await wasm("CounterV2")); // v2: StateData { counter, lastMigratedTick } + MIGRATE()

  const out = sim.query(28, GET); // Get_output { value, lastMigratedTick }
  expect(u64(out, 0)).toBe(3n); // counter preserved across the layout change (migrated, NOT zeroed by INITIALIZE)
  expect(u64(out, 1)).toBe(BigInt(sim.tickN)); // lastMigratedTick == qpi.tick() at the migrate
});

test("plain redeploy (no MIGRATE) preserves overlapping state — parity with core", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("CounterV1"));
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  expect(u64(sim.query(28, GET))).toBe(2n);

  sim.deploy(28, await wasm("CounterV1")); // same module: no migrate -> preserve overlap (was zeroed before the fix)
  expect(u64(sim.query(28, GET))).toBe(2n); // counter survives the redeploy; INITIALIZE did not re-run
});
