// Verifies fee gating, exemptions, depletion, refill, IPO seeding, and reserve behavior.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { contractId, readUint64LE } from "../support/helpers";

const GET = 1; // Counter/Hooks Get function
const INC = 1; // Counter Inc procedure
const ORIG = new Uint8Array(32);
const EMPTY = new Uint8Array(0);

// Hooks Get_output: { ticks, endticks, epochs, endepochs } as four uint64 LE.
function hookCounters(sim: QubicSimulator): [bigint, bigint, bigint, bigint] {
    const s = sim.query(28, GET);
    const f = (i: number) => new DataView(s.buffer, s.byteOffset, s.byteLength).getBigUint64(i * 8, true);
    return [f(0), f(1), f(2), f(3)];
}

test("fees off: contracts run with no reserve (default behaviour preserved)", async () => {
    await initK12();
    const sim = new QubicSimulator(); // default — fees off
    sim.deploy(28, await wasm("Hooks"));

    expect(sim.getContractFeeReserve(28)).toBe(0n); // no reserve tracked at all
    for (let i = 0; i < 5; i++) {
        sim.advance();
    }

    // Every tick hook still fired despite a zero reserve — the gate is inert when fees are off.
    expect(hookCounters(sim)).toEqual([5n, 5n, 0n, 0n]);
});

test("metered: BEGIN_TICK / END_TICK are skipped when the reserve is depleted, resume when refilled", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Hooks"));
    sim.setContractFeeReserve(28, 0n); // dormant

    for (let i = 0; i < 5; i++) {
        sim.advance();
    }
    expect(hookCounters(sim)).toEqual([0n, 0n, 0n, 0n]); // all tick hooks gated out

    sim.setContractFeeReserve(28, 1_000_000_000n); // refill -> back in service
    for (let i = 0; i < 3; i++) {
        sim.advance();
    }
    const [ticks, endticks] = hookCounters(sim);
    expect(ticks).toBe(3n);
    expect(endticks).toBe(3n);
});

test("metered: BEGIN_EPOCH / END_EPOCH run even on a dormant contract (exempt from the gate)", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.epochLength = 10; // the switch follows tick 10
    sim.deploy(28, await wasm("Hooks"));
    sim.setContractFeeReserve(28, 0n); // dormant for the whole run

    for (let i = 0; i < 11; i++) {
        sim.advance();
    }

    // Tick hooks gated out, but the epoch boundary (END_EPOCH then BEGIN_EPOCH) fired regardless of the reserve.
    expect(hookCounters(sim)).toEqual([0n, 0n, 1n, 1n]);
    expect(sim.currentEpoch).toBe(1);
});

test("metered: a user procedure to a dormant contract is skipped and its amount is refunded", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter"));

    const source = new Uint8Array(32).fill(0x11);
    const dest = contractId(28);
    sim.fund(source, 1_000_000n);

    // Dormant: the Inc procedure must not run and the 500 must come back to the sender.
    sim.setContractFeeReserve(28, 0n);
    const gated = sim.processTickTransaction(source, dest, 500n, INC, EMPTY, "tx-gated");
    expect(gated.moneyFlew).toBe(false);
    expect(readUint64LE(sim.query(28, GET))).toBe(0n); // Inc did not run
    expect(sim.balance(source)).toBe(1_000_000n); // fully refunded
    expect(sim.balanceOf(28)).toBe(0n);

    // Funded: the same tx now runs and the amount sticks as the invocation reward.
    sim.setContractFeeReserve(28, 1_000_000_000n);
    const ok = sim.processTickTransaction(source, dest, 500n, INC, EMPTY, "tx-ok");
    expect(ok.moneyFlew).toBe(true);
    expect(readUint64LE(sim.query(28, GET))).toBe(1n); // Inc ran
    expect(sim.balance(source)).toBe(999_500n);
    expect(sim.balanceOf(28)).toBe(500n);
});

test("metered: a plain transfer to a dormant contract is refunded and fires no POST_INCOMING_TRANSFER", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Vault"));

    const source = new Uint8Array(32).fill(0x11);
    const dest = contractId(28);
    sim.fund(source, 1000n);
    const incomingCount = () => readUint64LE(sim.query(28, GET), 8); // Vault Get_output.incomingCount

    // Dormant: core refuses the whole transaction, not only procedure calls — the callback is gated out with it.
    sim.setContractFeeReserve(28, 0n);
    const gated = sim.processTickTransaction(source, dest, 500n, 0, EMPTY, "plain-gated");
    expect(gated.moneyFlew).toBe(false);
    expect(incomingCount()).toBe(0n);
    expect(sim.balance(source)).toBe(1000n); // fully refunded
    expect(sim.balanceOf(28)).toBe(0n);

    // Funded: the same plain transfer now sticks and notifies the contract.
    sim.setContractFeeReserve(28, 1_000_000_000n);
    const ok = sim.processTickTransaction(source, dest, 500n, 0, EMPTY, "plain-ok");
    expect(ok.moneyFlew).toBe(true);
    expect(incomingCount()).toBe(1n);
    expect(sim.balance(source)).toBe(500n);
    expect(sim.balanceOf(28)).toBe(500n);
});

test("metered: a procedure accrues a sane cost, and the phase boundary charges exactly that", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter")); // seeded with the default reserve

    const before = sim.getContractFeeReserve(28);
    sim.procedure(28, INC); // mutates the 8-byte state -> base cost + digest recompute

    const accrued = sim.executionFee(28);
    // a core node measured 79 us/call for this exact shape, so the base entry time alone should account for it.
    expect(accrued).toBe(80n); // BASE_EXECUTION_TIME; an 8-byte state rounds to no digest time, and Inc prices no host calls
    expect(sim.getContractFeeReserve(28)).toBe(before); // nothing charged yet — core only deducts at the boundary

    // one full phase of ticks, so the accumulation is reported and charged once.
    for (let i = 0; i < 9; i++) {
        sim.advance();
    }
    expect(sim.getContractFeeReserve(28)).toBe(before - accrued);
    expect(sim.executionFee(28)).toBe(0n);
});

test("metered: fee accounting does not change contract state (digest matches an unmetered run)", async () => {
    await initK12();

    const off = new QubicSimulator();
    off.deploy(28, await wasm("Counter"));
    off.procedure(28, INC);
    off.procedure(28, INC);

    const metered = new QubicSimulator({ fees: "metered" });
    metered.deploy(28, await wasm("Counter"));
    metered.procedure(28, INC);
    metered.procedure(28, INC);

    expect(readUint64LE(metered.query(28, GET))).toBe(2n);
    expect(metered.digest(28)).toBe(off.digest(28)); // identical StateData -> identical digest
});

test("metered: qpi.burn refills a contract's reserve from its balance", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter"));
    sim.setContractFeeReserve(28, 0n);
    sim.fund(contractId(28), 1000n);

    // burn(amount) with an invalid target index -> burns to the caller's own reserve.
    const remaining = sim.host.burn(28, 400n, 0);
    expect(remaining).toBe(600n); // returns the contract's remaining balance
    expect(sim.getContractFeeReserve(28)).toBe(400n);
    expect(sim.balanceOf(28)).toBe(600n);

    // burn(amount, target) refills another contract's reserve.
    sim.host.burn(28, 100n, 29);
    expect(sim.getContractFeeReserve(29)).toBe(100n);
    expect(sim.balanceOf(28)).toBe(500n);
});

// every committee-sized amount follows the configured committee, as the node's NUMBER_OF_COMPUTORS sizes its own.
test("ipo shares, reserve and dividends scale with the committee", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered", consensus: { numberOfComputors: 3 } });
    const holder = new Uint8Array(32).fill(0x33);

    sim.ipo(28, 1000n);
    expect(sim.getContractFeeReserve(28)).toBe(3_000n);
    expect(sim.host.ipoBidPrice(28, 2)).toBe(1000000n);
    expect(sim.host.ipoBidPrice(28, 3)).toBe(-3n);

    sim.mintDeployShares(28, "DIV", holder);
    sim.fund(contractId(28), 15n);
    expect(sim.host.distributeDividends(28, 6n)).toBe(0); // 6 * 3 seats > 15
    expect(sim.host.distributeDividends(28, 5n)).toBe(1);
    expect(sim.balanceOf(28)).toBe(0n);
    expect(sim.balance(holder)).toBe(15n);
});

test("metered: IPO seeds the reserve; a failed IPO (finalPrice 0) can never be refilled", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter"));

    sim.ipo(28, 1000n);
    expect(sim.getContractFeeReserve(28)).toBe(676_000n); // finalPrice * NUMBER_OF_COMPUTORS(676)

    // A failed IPO marks the contract unusable — burning to it does nothing and reports failure.
    sim.ipo(29, 0n);
    expect(sim.getContractFeeReserve(29)).toBe(0n);
    sim.fund(contractId(28), 1000n);
    const r = sim.host.burn(28, 200n, 29);
    expect(r).toBe(-200n); // burn rejected (target IPO-failed)
    expect(sim.getContractFeeReserve(29)).toBe(0n);
    expect(sim.balanceOf(28)).toBe(1000n); // balance untouched
});

// core bounds the burn target by its contract count, not by the 1024-entry reserve table, and credits the reserve whatever the fee mode.
test("burn resolves its target and credits the reserve the way core does", async () => {
    await initK12();

    for (const fees of ["off", "metered"] as const) {
        const sim = new QubicSimulator({ fees, contractCount: 40 });
        sim.deploy(28, await wasm("Counter"));
        sim.setContractFeeReserve(28, 0n);
        sim.setContractFeeReserve(29, 0n);
        sim.fund(contractId(28), 1000n);

        // past the contract count but inside the reserve table: the caller, as for index 0.
        expect(sim.host.burn(28, 100n, 40)).toBe(900n);
        expect(sim.host.burn(28, 100n, 1023)).toBe(800n);
        expect(sim.getContractFeeReserve(28)).toBe(200n);
        expect(sim.getContractFeeReserve(40)).toBe(0n);

        expect(sim.host.burn(28, 100n, 39)).toBe(700n);
        expect(sim.getContractFeeReserve(39)).toBe(fees === "off" ? 1000100n : 100n);

        // more than the balance: the shortfall comes back negative and nothing moves.
        expect(sim.host.burn(28, 701n, 29)).toBe(-1n);
        expect(sim.getContractFeeReserve(29)).toBe(0n);

        sim.ipo(29, 0n);
        expect(sim.host.burn(28, 100n, 29)).toBe(-100n);
        expect(sim.balanceOf(28)).toBe(700n);
    }
});

// the dual-engine driver's Burn procedure, run here so its three rows are known-good before they meet a core node.
test("a contract burning for itself, a callee and an out-of-range index reads the deltas core reports", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("QpiDualCallee"));
    sim.deploy(29, await wasm("QpiDual"));
    sim.fund(contractId(29), 1000n);

    const burn = (burnedFor: bigint) => {
        const input = new Uint8Array(16);
        const view = new DataView(input.buffer);
        view.setBigInt64(0, 100n, true);
        view.setBigUint64(8, burnedFor, true);
        const output = new DataView(sim.procedure(29, 4, input).buffer);

        return [output.getBigInt64(0, true), output.getBigInt64(8, true), output.getBigInt64(16, true)];
    };

    expect(burn(29n)).toEqual([900n, 100n, 100n]);
    expect(burn(28n)).toEqual([800n, 0n, 100n]);
    expect(burn(1023n)).toEqual([700n, 100n, 100n]);
});

test("a burn moves the reserve a contract reads by exactly the amount, and saturates at the sint64 maximum", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "off" });
    sim.deploy(28, await wasm("Counter"));
    sim.fund(contractId(28), 1000n);

    const before = sim.host.queryFeeReserve(28, 28);
    sim.host.burn(28, 250n, 28);
    expect(sim.host.queryFeeReserve(28, 28) - before).toBe(250n);

    sim.setContractFeeReserve(28, (1n << 63n) - 10n);
    sim.host.burn(28, 250n, 28);
    expect(sim.getContractFeeReserve(28)).toBe((1n << 63n) - 1n);
});

test("metered: contract-to-contract procedure call fails when the callee has no reserve", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter")); // callee
    sim.deploy(29, await wasm("Proxy")); // caller

    sim.setContractFeeReserve(28, 0n); // dormant callee
    const denied = sim.invokeProcedure(29, 28, INC, EMPTY, 0n, ORIG);
    expect(denied.error).toBe(2); // CallErrorInsufficientFees
    expect(readUint64LE(sim.query(28, GET))).toBe(0n); // callee did not run

    sim.setContractFeeReserve(28, 1_000_000_000n);
    const ok = sim.invokeProcedure(29, 28, INC, EMPTY, 0n, ORIG);
    expect(ok.error).toBe(0);
    expect(readUint64LE(sim.query(28, GET))).toBe(1n);
});

test("metered: contract-to-contract function call fails when the callee has no reserve", async () => {
    await initK12();
    const sim = new QubicSimulator({ fees: "metered" });
    sim.deploy(28, await wasm("Counter"));
    sim.deploy(29, await wasm("Proxy"));

    sim.setContractFeeReserve(28, 0n);
    expect(sim.callFunction(29, 28, GET, EMPTY, ORIG).error).toBe(2); // CallErrorInsufficientFees

    sim.setContractFeeReserve(28, 1_000_000_000n);
    const ok = sim.callFunction(29, 28, GET, EMPTY, ORIG);
    expect(ok.error).toBe(0);
    expect(readUint64LE(ok.output)).toBe(0n); // reads Counter == 0
});

// HookFault Seen output: begin ticks, end ticks, begin epochs, end epochs, incoming transfers, deposits.
function hookFaultSeen(sim: QubicSimulator): bigint[] {
    const output = sim.query(29, 1);
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    return Array.from({ length: 6 }, (_, index) => view.getBigUint64(index * 8, true));
}

// core runs no tick or epoch phase for a contract in an error state, and refunds what is sent to it.
test("an errored contract gets no hooks and refunds its transactions, while its neighbour runs on", async () => {
    await initK12();
    const sim = new QubicSimulator({ haltOnContractFault: false, epochLength: 4 });
    const user = new Uint8Array(32).fill(0x61);
    sim.deploy(28, await wasm("Hooks"));
    sim.deploy(29, await wasm("HookFault"));
    sim.fund(user, 1000n);

    sim.advance();
    expect(hookFaultSeen(sim).slice(0, 2)).toEqual([1n, 1n]);

    // a function failure is only that query's error and leaves the contract in service.
    expect(() => sim.query(29, 2)).toThrow();
    expect(sim.contractErrorOf(29)).toBe(0);
    sim.advance();
    expect(hookFaultSeen(sim).slice(0, 2)).toEqual([2n, 2n]);

    expect(() => sim.procedure(29, 1)).toThrow(/abort/);
    expect(sim.contractErrorOf(29)).not.toBe(0);

    const neighbourBefore = readUint64LE(sim.query(28, 1));
    for (let i = 0; i < 6; i++) {
        sim.advance();
    }
    expect(hookFaultSeen(sim)).toEqual([2n, 2n, 0n, 0n, 0n, 0n]);
    expect(readUint64LE(sim.query(28, 1))).toBe(neighbourBefore + 6n);

    expect(sim.processTickTransaction(user, contractId(29), 40n, 2, new Uint8Array(0), "to-errored")).toEqual({ moneyFlew: false });
    expect(sim.balanceOf(29)).toBe(0n);
    expect(hookFaultSeen(sim).slice(4)).toEqual([0n, 0n]);
});

test("a contract outside its epochs gets no hooks and keeps what is sent to it, then resumes inside them", async () => {
    await initK12();
    const sim = new QubicSimulator({ epochLength: 4 });
    const user = new Uint8Array(32).fill(0x62);
    sim.deploy(29, await wasm("HookFault"));
    sim.setContractLifetime(29, 1, 2);
    sim.fund(user, 1000n);

    sim.advance();
    sim.advance();
    expect(hookFaultSeen(sim)).toEqual([0n, 0n, 0n, 0n, 0n, 0n]);
    expect(sim.processTickTransaction(user, contractId(29), 40n, 2, new Uint8Array(0), "too-early")).toEqual({ moneyFlew: true });
    expect(sim.balanceOf(29)).toBe(40n);
    expect(hookFaultSeen(sim).slice(4)).toEqual([0n, 0n]);

    // tick 5 switches to epoch 1: BEGIN_EPOCH runs for it there, END_EPOCH of epoch 0 did not.
    sim.advance();
    sim.advance();
    sim.advance();
    expect(sim.currentEpoch).toBe(1);
    expect(hookFaultSeen(sim).slice(0, 4)).toEqual([1n, 1n, 1n, 0n]);
    expect(sim.processTickTransaction(user, contractId(29), 5n, 2, new Uint8Array(0), "in-window")).toEqual({ moneyFlew: true });
    expect(hookFaultSeen(sim).slice(4)).toEqual([1n, 1n]);
});

test("a failed ipo takes a contract's epoch hooks away too", async () => {
    await initK12();
    const sim = new QubicSimulator({ epochLength: 2 });
    sim.deploy(29, await wasm("HookFault"));
    sim.ipo(29, 0n);

    for (let i = 0; i < 4; i++) {
        sim.advance();
    }
    expect(hookFaultSeen(sim).slice(0, 4)).toEqual([0n, 0n, 0n, 0n]);
});
