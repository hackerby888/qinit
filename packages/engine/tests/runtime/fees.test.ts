// FeeManager (fees.ts) in isolation — no Sim. The execution-fee reserve accounting extracted from the Sim god
// object: per-contract reserves, the off/metered policy, the IPO seeding, and the reserveOk gate.
import { test, expect } from "bun:test";
import { FeeManager, DEFAULT_FEE_RESERVE } from "../../src/fees";

test("off mode: inert — reserveOk always true, queryFeeReserve a positive constant", () => {
  const f = new FeeManager("off");
  expect(f.metered).toBe(false);
  expect(f.getReserve(5)).toBe(0n);
  expect(f.reserveOk(5)).toBe(true); // never gated when off
  expect(f.queryFeeReserve(5, 5)).toBe(1000000n); // the legacy constant
});

test("metered: reserveOk gates on a positive reserve", () => {
  const f = new FeeManager("metered");
  expect(f.metered).toBe(true);
  expect(f.reserveOk(5)).toBe(false); // unfunded
  f.setReserve(5, 10n);
  expect(f.reserveOk(5)).toBe(true);
  f.sub(5, 10n);
  expect(f.getReserve(5)).toBe(0n);
  expect(f.reserveOk(5)).toBe(false); // exhausted -> dormant
});

test("add/sub: credit + debit; sub may drive the reserve non-positive", () => {
  const f = new FeeManager("metered");
  f.setReserve(1, 100n);
  f.add(1, 50n);
  expect(f.getReserve(1)).toBe(150n);
  f.add(1, -5n); // non-positive add is a no-op
  expect(f.getReserve(1)).toBe(150n);
  f.sub(1, 200n); // overshoot -> negative (dormant until refilled)
  expect(f.getReserve(1)).toBe(-50n);
  expect(f.reserveOk(1)).toBe(false);
  f.sub(1, -5n); // non-positive sub is a no-op
  expect(f.getReserve(1)).toBe(-50n);
});

test("ipo: success funds finalPrice*676 and clears failed; failure marks failed with a zero reserve", () => {
  const f = new FeeManager("metered");
  f.ipo(2, 1000000n);
  expect(f.getReserve(2)).toBe(1000000n * 676n);
  expect(f.isFailed(2)).toBe(false);

  f.ipo(3, 0n);
  expect(f.getReserve(3)).toBe(0n);
  expect(f.isFailed(3)).toBe(true);

  f.setReserve(3, 5n); // a positive set clears the failed mark
  expect(f.isFailed(3)).toBe(false);
});

test("seedOnDeploy: a metered deploy is seeded with the default reserve unless already funded", () => {
  const f = new FeeManager("metered");
  f.seedOnDeploy(7);
  expect(f.getReserve(7)).toBe(DEFAULT_FEE_RESERVE);

  f.setReserve(8, 42n);
  f.seedOnDeploy(8); // already funded — not overwritten
  expect(f.getReserve(8)).toBe(42n);

  const custom = new FeeManager("metered", 999n);
  custom.seedOnDeploy(1);
  expect(custom.getReserve(1)).toBe(999n);

  const off = new FeeManager("off");
  off.seedOnDeploy(1); // off mode never seeds
  expect(off.getReserve(1)).toBe(0n);
});

test("queryFeeReserve: out-of-range contract index resolves to the caller's own contract", () => {
  const f = new FeeManager("metered");
  f.setReserve(9, 321n);
  f.setReserve(12, 654n);
  expect(f.queryFeeReserve(9, 12)).toBe(654n); // valid index -> that contract
  expect(f.queryFeeReserve(9, 0)).toBe(321n); // ci < 1 -> caller (9)
  expect(f.queryFeeReserve(9, 99999)).toBe(321n); // ci >= MAX_NUMBER_OF_CONTRACTS -> caller (9)
});
