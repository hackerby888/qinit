// Redeploy migration converts matching old state into the new layout without reinitializing.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { readUint64LE } from "../support/helpers";

const INC = 1; // REGISTER_USER_PROCEDURE(Inc, 1)
const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)

test("redeploy with MIGRATE() carries old state into the new layout", async () => {
  await initK12();
  const sim = new QubicSimulator();
  sim.deploy(28, await wasm("CounterV1")); // v1: StateData { counter }
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  expect(readUint64LE(sim.query(28, GET))).toBe(3n); // counter = 3

  // Advance so MIGRATE() observes a non-zero qpi.tick().
  for (let i = 0; i < 5; i++) {
    sim.advance();
  }

  sim.deploy(28, await wasm("CounterV2")); // v2: StateData { counter, lastMigratedTick } + MIGRATE()

  const out = sim.query(28, GET); // Get_output { value, lastMigratedTick }
  expect(readUint64LE(out)).toBe(3n); // counter preserved across the layout change (migrated, NOT zeroed by INITIALIZE)
  expect(readUint64LE(out, 8)).toBe(BigInt(sim.currentTick));
});

test("plain redeploy (no MIGRATE) preserves overlapping state — parity with core", async () => {
  await initK12();
  const sim = new QubicSimulator();
  sim.deploy(28, await wasm("CounterV1"));
  sim.procedure(28, INC);
  sim.procedure(28, INC);
  expect(readUint64LE(sim.query(28, GET))).toBe(2n);

  sim.deploy(28, await wasm("CounterV1")); // same module: no migrate -> preserve overlap (was zeroed before the fix)
  expect(readUint64LE(sim.query(28, GET))).toBe(2n); // counter survives the redeploy; INITIALIZE did not re-run
});
