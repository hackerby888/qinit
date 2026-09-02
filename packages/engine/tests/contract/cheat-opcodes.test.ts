// The mutating opcodes, driven from inside a contract rather than by calling the host directly, so the
// whole path — macro, import, entry-kind check, host — is what is under test.
import { expect, test } from "bun:test";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import type { Id } from "../../src/support/bytes";
import { contractId } from "../support/helpers";

const FUND = 1;
const JUMP = 2;
const PAY = 3;
const EPOCH = 4;
const PRANK = 5;
const CHECK = 6;
const ASSERT_LINE = 99;
const ALICE = new Uint8Array(32).fill(0x22) as Id;
const BOB = new Uint8Array(32).fill(0x33) as Id;

function idAndAmount(who: Uint8Array, amount: bigint): Uint8Array {
    const input = new Uint8Array(40);
    input.set(who, 0);
    new DataView(input.buffer).setBigUint64(32, amount, true);

    return input;
}

function word(value: bigint): Uint8Array {
    return new Uint8Array(new BigUint64Array([value]).buffer);
}

async function deployed(): Promise<QubicSimulator> {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, await wasm("CheatOps"));

    return sim;
}

// A contract abort surfaces as an error naming the code the contract passed, and the trace entry
// carries the same text, so a dev reading either sees which cheat refused and where.
function abortOf(code: number): RegExp {
    return new RegExp(`abort\\(${code >>> 0}\\)`);
}

test("CC_DEAL sets a balance outright, upward and downward", async () => {
    const sim = await deployed();

    sim.procedure(28, FUND, idAndAmount(ALICE, 1000n));
    expect(sim.balance(ALICE)).toBe(1000n);

    // A deal is not a transfer: dealing less than the current balance lowers it.
    sim.procedure(28, FUND, idAndAmount(ALICE, 250n));
    expect(sim.balance(ALICE)).toBe(250n);
});

test("CC_WARP_TICK shifts what the contract observes, not the chain's own tick", async () => {
    const sim = await deployed();
    const before = sim.currentTick;

    sim.procedure(28, JUMP, word(10n));

    expect(sim.currentTick).toBe(before);
});

test("CC_PAY moves qus out of the contract's own balance", async () => {
    const sim = await deployed();
    const self = contractId(28) as Id;
    sim.fund(self, 1000n);

    sim.procedure(28, PAY, idAndAmount(ALICE, 400n));

    expect(sim.balance(ALICE)).toBe(400n);
    expect(sim.balance(self)).toBe(600n);
});

test("CC_WARP_EPOCH shifts the epoch the contract observes", async () => {
    const sim = await deployed();
    const epochOf = (output: Uint8Array) => new DataView(output.buffer, output.byteOffset).getUint16(0, true);

    const before = epochOf(sim.procedure(28, EPOCH, word(0n)));
    const after = epochOf(sim.procedure(28, EPOCH, word(5n)));

    expect(after - before).toBe(5);
});

test("CC_PRANK rewrites the caller the contract sees until CC_UNPRANK", async () => {
    const sim = await deployed();

    const output = sim.procedure(28, PRANK, ALICE, { invocator: BOB });

    expect(output.subarray(0, 32)).toEqual(ALICE);
    expect(output.subarray(32, 64)).toEqual(BOB);
});

test("CC_ASSERT aborts with the line it stands on, and a passing assert costs nothing", async () => {
    const sim = await deployed();

    sim.procedure(28, CHECK, word(1n));
    expect(sim.getTrace().entries.at(-1)?.trap).toBeUndefined();

    expect(() => sim.procedure(28, CHECK, word(0n))).toThrow(abortOf(0xcc000000 | ASSERT_LINE));
    expect(sim.getTrace().entries.at(-1)?.trap).toMatch(abortOf(0xcc000000 | ASSERT_LINE));
});

// The scanner refuses this shape in a project, so it is compiled here directly: the host's own refusal
// must still reach the dev as an abort naming the opcode, not vanish into a dropped return value.
test("a mutator called from a function aborts with its opcode", async () => {
    const source = `
using namespace QPI;
struct Sneak2 {};
struct Sneak : public ContractBase {
    struct StateData { uint64 n; };
    struct Peek_input {};
    struct Peek_output { uint64 tick; };
    PUBLIC_FUNCTION(Peek) {
        CC_WARP_TICK(1);
        output.tick = qpi.tick();
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
        REGISTER_USER_FUNCTION(Peek, 1);
    }
};`;
    const compiled = await compileContractWithTypeScript({ source, contractName: "Sneak", slot: 28 });

    expect(compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);

    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, compiled.wasm);

    expect(() => sim.query(28, 1)).toThrow(abortOf(0xcc1e0003));
});
