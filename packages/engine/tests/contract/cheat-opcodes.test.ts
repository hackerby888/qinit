// The mutating opcodes, driven from inside a contract rather than by calling the host directly, so the
// whole path — macro, import, entry-kind check, host — is what is under test.
import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import type { Id } from "../../src/support/bytes";

const FUND = 1;
const JUMP = 2;
const ALICE = new Uint8Array(32).fill(0x22) as Id;

function fundInput(who: Uint8Array, amount: bigint): Uint8Array {
    const input = new Uint8Array(40);
    input.set(who, 0);
    new DataView(input.buffer).setBigUint64(32, amount, true);

    return input;
}

async function deployed(): Promise<QubicSimulator> {
    await initK12();
    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("CheatOps"));

    return sim;
}

test("CC_DEAL sets a balance outright, upward and downward", async () => {
    const sim = await deployed();

    sim.procedure(28, FUND, fundInput(ALICE, 1000n));
    expect(sim.balance(ALICE)).toBe(1000n);

    // A deal is not a transfer: dealing less than the current balance lowers it.
    sim.procedure(28, FUND, fundInput(ALICE, 250n));
    expect(sim.balance(ALICE)).toBe(250n);
});

test("CC_WARP_TICK shifts what the contract observes, not the chain's own tick", async () => {
    const sim = await deployed();
    const before = sim.currentTick;

    sim.procedure(28, JUMP, new Uint8Array(new BigUint64Array([10n]).buffer));

    expect(sim.currentTick).toBe(before);
});
