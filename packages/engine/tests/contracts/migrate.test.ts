// State migration on redeploy: when the redeployed module declares MIGRATE() and its OldStateData size matches
// the live state, the engine runs __migrate(newState, oldState) to convert the old state into the new layout —
// instead of zeroing it. Mirrors core-lite (lite_wasm_contracts.h kind=3 + lite_dynamic_contracts.h). Also
// covers the parity fix: a plain redeploy (no MIGRATE) preserves overlapping state rather than wiping it.
// Fixtures: CounterV1 = { counter }; CounterV2 = { counter, lastMigratedTick } + MIGRATE() carrying counter over.
import { test, expect } from "bun:test";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

const FIX = import.meta.dir + "/../fixtures";
const INC = 1; // REGISTER_USER_PROCEDURE(Inc, 1)
const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}
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

  for (let i = 0; i < 5; i++) sim.advance(); // move the tick on so MIGRATE()'s qpi.tick() is non-zero

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
