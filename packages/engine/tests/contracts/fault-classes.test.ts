// The three failure classes a contract can hit, each with the trace it must leave behind: a function
// failure fails only its query, a procedure trap halts with the trap text, a migration abort halts too.
import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { CONTRACT_ENTRY_KIND, ContractExecutionError } from "../../src/contract/runtime";
import { EngineFaultedError, QubicSimulator } from "../../src/qubic-simulator";
import { initK12 } from "../../src/support/k12";
import { readUint64LE } from "../support/helpers";

const ASSERT_FN = 1;
const CALLS = 2;
const ASSERT = 1;
const OVERFLOW = 2;

function uint64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function sint64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigInt64(0, value, true);
    return bytes;
}

test("a function abort fails only its query, keeps its frame, and the node keeps ticking", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("FaultZoo"));
    sim.setDebug(true);

    expect(() => sim.query(28, ASSERT_FN, uint64(50n))).toThrow(ContractExecutionError);
    expect(() => sim.query(28, ASSERT_FN, uint64(50n))).toThrow(/abort\(/);
    expect(sim.isFaulted()).toBe(false);
    expect(sim.faultInfo()).toBeNull();

    const frames = sim.getTrace().entries.filter((entry) => entry.index === 28 && entry.kind === CONTRACT_ENTRY_KIND.FUNCTION && entry.entry === ASSERT_FN);
    expect(frames.length).toBe(2);
    expect(frames[0]).toMatchObject({ ok: false });
    expect(frames[0]?.trap).toMatch(/abort\(/);

    sim.advance();
    expect(readUint64LE(sim.query(28, ASSERT_FN, uint64(5n)))).toBe(5n);
    expect(readUint64LE(sim.query(28, CALLS))).toBe(0n);
});

test("a procedure trap halts the engine with the trap text and keeps the frame with its partial write", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("FaultZoo"));
    sim.setDebug(true);

    expect(() => sim.procedure(28, OVERFLOW, sint64(-1n))).toThrow(EngineFaultedError);
    expect(sim.faultInfo()).toMatchObject({
        phase: "contract-procedure",
        slot: 28,
        kind: CONTRACT_ENTRY_KIND.PROCEDURE,
        entry: OVERFLOW,
    });
    expect(sim.faultInfo()?.message).toMatch(/overflow/i);

    const frame = sim.getTrace().entries.find((entry) => entry.index === 28 && entry.kind === CONTRACT_ENTRY_KIND.PROCEDURE && entry.entry === OVERFLOW);
    expect(frame).toMatchObject({ ok: false });
    expect(frame?.trap).toMatch(/overflow/i);
    // calls += 1 landed before the division, and nothing rolls it back.
    expect(frame?.stateDiff.length).toBeGreaterThan(0);
    expect(() => sim.advance()).toThrow(EngineFaultedError);
});

test("a procedure abort halts the engine and keeps the frame", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("FaultZoo"));
    sim.setDebug(true);

    expect(() => sim.procedure(28, ASSERT, uint64(50n))).toThrow(EngineFaultedError);
    expect(sim.faultInfo()).toMatchObject({ phase: "contract-procedure", slot: 28, kind: CONTRACT_ENTRY_KIND.PROCEDURE, entry: ASSERT });
    expect(sim.faultInfo()?.message).toMatch(/^abort\(/);

    const frame = sim.getTrace().entries.find((entry) => entry.index === 28 && entry.kind === CONTRACT_ENTRY_KIND.PROCEDURE && entry.entry === ASSERT);
    expect(frame).toMatchObject({ ok: false });
    expect(frame?.trap).toMatch(/^abort\(/);
});

test("a migration that aborts halts the engine and leaves a migrate frame", async () => {
    await initK12();
    const sim = new QubicSimulator();
    const v2 = await wasm("MigrateTrap");
    sim.deploy(28, await wasm("MigrateTrapV1"));
    sim.procedure(28, 1);
    sim.setDebug(true);

    expect(() => sim.deploy(28, v2)).toThrow(EngineFaultedError);
    expect(sim.faultInfo()).toMatchObject({ phase: "deploy", slot: 28, kind: CONTRACT_ENTRY_KIND.MIGRATE, entry: 0 });
    expect(sim.faultInfo()?.message).toMatch(/^abort\(/);

    const frame = sim.getTrace().entries.find((entry) => entry.index === 28 && entry.kind === CONTRACT_ENTRY_KIND.MIGRATE);
    expect(frame).toMatchObject({ ok: false });
    expect(frame?.trap).toMatch(/^abort\(/);
});
