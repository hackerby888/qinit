// FeeManager (fees.ts) in isolation: per-contract reserves, the off/metered policy, IPO seeding, and the reserveOk gate, extracted from the simulator.
import { test, expect } from "bun:test";
import { FeeManager, DEFAULT_FEE_RESERVE } from "../../src/contract/fees";

test("off mode: inert — reserveOk always true, queryFeeReserve a positive constant", () => {
    const f = new FeeManager("off");
    expect(f.metered).toBe(false);
    expect(f.getContractFeeReserve(5)).toBe(0n);
    expect(f.reserveOk(5)).toBe(true); // never gated when off
    expect(f.queryFeeReserve(5, 5)).toBe(1000000n); // the legacy constant
});

test("off mode: a reserve a test set is what the contract reads, and nothing is charged", () => {
    const f = new FeeManager("off");
    f.setContractFeeReserve(5, 8000000n);

    expect(f.queryFeeReserve(5, 5)).toBe(8000000n);
    expect(f.queryFeeReserve(5, 0)).toBe(8000000n);
    expect(f.queryFeeReserve(5, 6)).toBe(1000000n);
    expect(f.reserveOk(6)).toBe(true);
});

test("metered: reserveOk gates on a positive reserve", () => {
    const f = new FeeManager("metered");
    expect(f.metered).toBe(true);
    expect(f.reserveOk(5)).toBe(false); // unfunded
    f.setContractFeeReserve(5, 10n);
    expect(f.reserveOk(5)).toBe(true);
    f.subtractFromContractFeeReserve(5, 10n);
    expect(f.getContractFeeReserve(5)).toBe(0n);
    expect(f.reserveOk(5)).toBe(false); // exhausted -> dormant
});

test("the reserve rises and falls, and may be driven non-positive", () => {
    const f = new FeeManager("metered");
    f.setContractFeeReserve(1, 100n);
    f.addToContractFeeReserve(1, 50n);
    expect(f.getContractFeeReserve(1)).toBe(150n);
    f.addToContractFeeReserve(1, -5n); // non-positive add is a no-op
    expect(f.getContractFeeReserve(1)).toBe(150n);
    f.subtractFromContractFeeReserve(1, 200n); // overshoot -> negative (dormant until refilled)
    expect(f.getContractFeeReserve(1)).toBe(-50n);
    expect(f.reserveOk(1)).toBe(false);
    f.subtractFromContractFeeReserve(1, -5n); // non-positive sub is a no-op
    expect(f.getContractFeeReserve(1)).toBe(-50n);
});

test("ipo: success funds finalPrice*computors and clears failed; failure marks failed with a zero reserve", () => {
    const f = new FeeManager("metered");
    f.ipo(2, 1000000n);
    expect(f.getContractFeeReserve(2)).toBe(1000000n * 676n);
    expect(f.isFailed(2)).toBe(false);

    f.ipo(3, 0n);
    expect(f.getContractFeeReserve(3)).toBe(0n);
    expect(f.isFailed(3)).toBe(true);

    f.setContractFeeReserve(3, 5n); // a positive set clears the failed mark
    expect(f.isFailed(3)).toBe(false);
});

test("seedOnDeploy: a metered deploy is seeded with the default reserve unless already funded", () => {
    const f = new FeeManager("metered");
    f.seedOnDeploy(7);
    expect(f.getContractFeeReserve(7)).toBe(DEFAULT_FEE_RESERVE);

    f.setContractFeeReserve(8, 42n);
    f.seedOnDeploy(8); // already funded — not overwritten
    expect(f.getContractFeeReserve(8)).toBe(42n);

    const custom = new FeeManager("metered", 999n);
    custom.seedOnDeploy(1);
    expect(custom.getContractFeeReserve(1)).toBe(999n);

    const off = new FeeManager("off");
    off.seedOnDeploy(1); // off mode never seeds
    expect(off.getContractFeeReserve(1)).toBe(0n);
});

test("addTime accumulates without touching the reserve; the phase boundary charges the total once", () => {
    const f = new FeeManager("metered");
    f.setContractFeeReserve(5, 1000n);
    f.processReportsOnNewPhase(0); // adopt phase 0, nothing accumulated yet

    f.addTime(5, 30n);
    f.addTime(5, 12n);
    expect(f.executionFee(5)).toBe(42n);
    expect(f.getContractFeeReserve(5)).toBe(1000n); // untouched inside the phase

    for (let tick = 1; tick < f.numberOfComputors; tick++) {
        expect(f.processReportsOnNewPhase(tick)).toEqual([]); // still the same phase
    }
    expect(f.getContractFeeReserve(5)).toBe(1000n);

    expect(f.processReportsOnNewPhase(f.numberOfComputors)).toEqual([{ contractIndex: 5, deductedAmount: 42n, remainingAmount: 958n }]);
    expect(f.getContractFeeReserve(5)).toBe(958n);
    expect(f.executionFee(5)).toBe(0n); // the accumulation is reset, like core's startNewAccumulation
    expect(f.processReportsOnNewPhase(f.numberOfComputors)).toEqual([]); // settled once per phase
});

test("a contract that outspends its reserve keeps running to the boundary, then goes dormant", () => {
    const f = new FeeManager("metered");
    f.setContractFeeReserve(5, 50n);
    f.processReportsOnNewPhase(0);

    f.addTime(5, 80n);
    expect(f.reserveOk(5)).toBe(true); // still funded as far as the gate can see

    expect(f.processReportsOnNewPhase(f.numberOfComputors)).toEqual([{ contractIndex: 5, deductedAmount: 80n, remainingAmount: -30n }]);
    expect(f.reserveOk(5)).toBe(false);
});

test("off mode accumulates nothing, and the multiplier scales what a phase charges", () => {
    const off = new FeeManager("off");
    off.setContractFeeReserve(5, 100n);
    off.addTime(5, 40n);
    expect(off.executionFee(5)).toBe(0n);
    expect(off.processReportsOnNewPhase(off.numberOfComputors)).toEqual([]);

    const f = new FeeManager("metered");
    f.setContractFeeReserve(5, 1000n);
    f.multiplierNumerator = 2n;
    f.addTime(5, 40n);
    expect(f.executionFee(5)).toBe(80n);

    f.multiplierNumerator = 0n; // core reports nothing when either side of the multiplier is zero
    expect(f.executionFee(5)).toBe(0n);
    expect(f.processReportsOnNewPhase(f.numberOfComputors)).toEqual([]);
    expect(f.getContractFeeReserve(5)).toBe(1000n);
});

test("queryFeeReserve: out-of-range contract index resolves to the caller's own contract", () => {
    const f = new FeeManager("metered");
    f.setContractFeeReserve(9, 321n);
    f.setContractFeeReserve(12, 654n);
    expect(f.queryFeeReserve(9, 12)).toBe(654n); // valid index -> that contract
    expect(f.queryFeeReserve(9, 0)).toBe(321n); // ci < 1 -> caller (9)
    expect(f.queryFeeReserve(9, 99999)).toBe(321n); // ci >= MAX_NUMBER_OF_CONTRACTS -> caller (9)

    // 1 is the first in-range index, so it is the only value that separates `ci < 1` from `ci <= 1`.
    f.setContractFeeReserve(1, 111n);
    expect(f.queryFeeReserve(9, 1)).toBe(111n);
});
