// Execution-fee conformance (core-lite doc/execution_fees.md). Asserts the opt-in fee model: gating at the
// right entry points, the exemptions (epoch sysprocs + callbacks), reserve depletion/refill, the IPO seed, and
// the invariant that fee accounting never alters contract state (a metered run digests identically to an
// unmetered one). Fixtures are the real wasm `qinit build` emits — Hooks bumps a per-hook counter, Counter is
// an Inc procedure + Get function, Proxy calls Counter across the contract boundary.
import { test, expect } from "bun:test";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";
import { contractId } from "../support/helpers";

const FIX = import.meta.dir + "/../fixtures";
const GET = 1; // Counter/Hooks Get function
const INC = 1; // Counter Inc procedure
const ORIG = new Uint8Array(32);
const EMPTY = new Uint8Array(0);

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

// Hooks Get_output: { ticks, endticks, epochs, endepochs } as four uint64 LE.
function hookCounters(sim: Sim): [bigint, bigint, bigint, bigint] {
  const s = sim.query(28, GET);
  const f = (i: number) => new DataView(s.buffer, s.byteOffset, s.byteLength).getBigUint64(i * 8, true);
  return [f(0), f(1), f(2), f(3)];
}

test("fees off: contracts run with no reserve (default behaviour preserved)", async () => {
  await initK12();
  const sim = new Sim(); // default — fees off
  sim.deploy(28, await wasm("Hooks"));

  expect(sim.feeReserveOf(28)).toBe(0n); // no reserve tracked at all
  for (let i = 0; i < 5; i++) {
    sim.advance();
  }

  // Every tick hook still fired despite a zero reserve — the gate is inert when fees are off.
  expect(hookCounters(sim)).toEqual([5n, 5n, 0n, 0n]);
});

test("metered: BEGIN_TICK / END_TICK are skipped when the reserve is depleted, resume when refilled", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Hooks"));
  sim.setFeeReserve(28, 0n); // dormant

  for (let i = 0; i < 5; i++) {
    sim.advance();
  }
  expect(hookCounters(sim)).toEqual([0n, 0n, 0n, 0n]); // all tick hooks gated out

  sim.setFeeReserve(28, 1_000_000_000n); // refill -> back in service
  for (let i = 0; i < 3; i++) {
    sim.advance();
  }
  const [ticks, endticks] = hookCounters(sim);
  expect(ticks).toBe(3n);
  expect(endticks).toBe(3n);
});

test("metered: BEGIN_EPOCH / END_EPOCH run even on a dormant contract (exempt from the gate)", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.epochLength = 10; // cross a boundary at tick 10
  sim.deploy(28, await wasm("Hooks"));
  sim.setFeeReserve(28, 0n); // dormant for the whole run

  for (let i = 0; i < 10; i++) {
    sim.advance();
  }

  // Tick hooks gated out, but the epoch boundary (END_EPOCH then BEGIN_EPOCH) fired regardless of the reserve.
  expect(hookCounters(sim)).toEqual([0n, 0n, 1n, 1n]);
  expect(sim.epochN).toBe(1);
});

test("metered: a user procedure to a dormant contract is skipped and its amount is refunded", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter"));

  const source = new Uint8Array(32).fill(0x11);
  const dest = contractId(28);
  sim.fund(source, 1_000_000n);

  // Dormant: the Inc procedure must not run and the 500 must come back to the sender.
  sim.setFeeReserve(28, 0n);
  const gated = sim.applyTx(source, dest, 500n, INC, EMPTY, "tx-gated");
  expect(gated.moneyFlew).toBe(false);
  expect(u64(sim.query(28, GET))).toBe(0n); // Inc did not run
  expect(sim.balance(source)).toBe(1_000_000n); // fully refunded
  expect(sim.balanceOf(28)).toBe(0n);

  // Funded: the same tx now runs and the amount sticks as the invocation reward.
  sim.setFeeReserve(28, 1_000_000_000n);
  const ok = sim.applyTx(source, dest, 500n, INC, EMPTY, "tx-ok");
  expect(ok.moneyFlew).toBe(true);
  expect(u64(sim.query(28, GET))).toBe(1n); // Inc ran
  expect(sim.balance(source)).toBe(999_500n);
  expect(sim.balanceOf(28)).toBe(500n);
});

test("metered: running a procedure debits the contract's reserve by a sane metered cost", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter")); // seeded with the default reserve

  const before = sim.feeReserveOf(28);
  sim.procedure(28, INC); // mutates the 8-byte state -> base cost + digest recompute
  const after = sim.feeReserveOf(28);

  const charged = before - after;
  expect(charged).toBeGreaterThanOrEqual(18n); // BASE_CALL_COST(10) + 8 state bytes, at minimum
  expect(charged).toBeLessThan(60n); // no runaway: Inc makes no priced host calls
});

test("metered: fee accounting does not change contract state (digest matches an unmetered run)", async () => {
  await initK12();

  const off = new Sim();
  off.deploy(28, await wasm("Counter"));
  off.procedure(28, INC);
  off.procedure(28, INC);

  const metered = new Sim({ fees: "metered" });
  metered.deploy(28, await wasm("Counter"));
  metered.procedure(28, INC);
  metered.procedure(28, INC);

  expect(u64(metered.query(28, GET))).toBe(2n);
  expect(metered.digest(28)).toBe(off.digest(28)); // identical StateData -> identical digest
});

test("metered: qpi.burn refills a contract's reserve from its balance", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter"));
  sim.setFeeReserve(28, 0n);
  sim.fund(contractId(28), 1000n);

  // burn(amount) with an invalid target index -> burns to the caller's own reserve.
  const remaining = sim.host.burn(28, 400n, 0);
  expect(remaining).toBe(600n); // returns the contract's remaining balance
  expect(sim.feeReserveOf(28)).toBe(400n);
  expect(sim.balanceOf(28)).toBe(600n);

  // burn(amount, target) refills another contract's reserve.
  sim.host.burn(28, 100n, 29);
  expect(sim.feeReserveOf(29)).toBe(100n);
  expect(sim.balanceOf(28)).toBe(500n);
});

test("metered: IPO seeds the reserve; a failed IPO (finalPrice 0) can never be refilled", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter"));

  sim.ipo(28, 1000n);
  expect(sim.feeReserveOf(28)).toBe(676_000n); // finalPrice * NUMBER_OF_COMPUTORS(676)

  // A failed IPO marks the contract unusable — burning to it does nothing and reports failure.
  sim.ipo(29, 0n);
  expect(sim.feeReserveOf(29)).toBe(0n);
  sim.fund(contractId(28), 1000n);
  const r = sim.host.burn(28, 200n, 29);
  expect(r).toBe(-200n); // burn rejected (target IPO-failed)
  expect(sim.feeReserveOf(29)).toBe(0n);
  expect(sim.balanceOf(28)).toBe(1000n); // balance untouched
});

test("metered: contract-to-contract procedure call fails when the callee has no reserve", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter")); // callee
  sim.deploy(29, await wasm("Proxy")); // caller

  sim.setFeeReserve(28, 0n); // dormant callee
  const denied = sim.doInvokeProcedure(29, 28, INC, EMPTY, 0n, ORIG);
  expect(denied.error).toBe(2); // CallErrorInsufficientFees
  expect(u64(sim.query(28, GET))).toBe(0n); // callee did not run

  sim.setFeeReserve(28, 1_000_000_000n);
  const ok = sim.doInvokeProcedure(29, 28, INC, EMPTY, 0n, ORIG);
  expect(ok.error).toBe(0);
  expect(u64(sim.query(28, GET))).toBe(1n);
});

test("metered: contract-to-contract function call fails when the callee has no reserve", async () => {
  await initK12();
  const sim = new Sim({ fees: "metered" });
  sim.deploy(28, await wasm("Counter"));
  sim.deploy(29, await wasm("Proxy"));

  sim.setFeeReserve(28, 0n);
  expect(sim.doCallFunction(29, 28, GET, EMPTY, ORIG).error).toBe(2); // CallErrorInsufficientFees

  sim.setFeeReserve(28, 1_000_000_000n);
  const ok = sim.doCallFunction(29, 28, GET, EMPTY, ORIG);
  expect(ok.error).toBe(0);
  expect(u64(ok.output)).toBe(0n); // reads Counter == 0
});
