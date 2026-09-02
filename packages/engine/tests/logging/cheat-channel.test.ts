// The cheat channel is the point of the design: CC_PRINT has to be readable from a function, and it
// must never appear as a protocol log. These tests pin both halves.
import { expect, test } from "bun:test";
import { AbiTypeKind } from "@qinit/proto/contract-idl";
import { loadWasmFixture as wasm, loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { QubicLogStore } from "../../src/logging/qubic-log-store";

const ADD = 1;
const TOTAL = 1;
const GET = 1;
const PUT = 1;

async function deployCheats(): Promise<{ sim: QubicSimulator; logStore: QubicLogStore }> {
    await initK12();
    const logStore = new QubicLogStore();
    const sim = new QubicSimulator({ logStore });
    sim.setDebug(true);
    sim.deploy(28, await wasm("Cheats"));

    return { sim, logStore };
}

test("a CC_PRINT from a procedure lands on the cheat channel, not the log channel", async () => {
    const { sim, logStore } = await deployCheats();

    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    const entry = sim.getTrace().entries.at(-1)!;

    expect(entry.cheats.length).toBeGreaterThan(0);
    expect(entry.logs).toHaveLength(0);
    expect(logStore.recordsBetween(0n, 0n)).toBeNull();
});

test("CC_PRINT works inside a function, where a protocol log cannot go", async () => {
    const { sim } = await deployCheats();

    sim.query(28, TOTAL);

    const entry = sim.getTrace().entries.at(-1)!;

    expect(entry.cheats.length).toBeGreaterThan(0);
    expect(entry.logs).toHaveLength(0);
});

test("each printed value carries its own ordinal, and a literal contributes none", async () => {
    const { sim } = await deployCheats();

    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    const entry = sim.getTrace().entries.at(-1)!;
    // `CC_PRINT("adding", input.amount)` and `CC_PRINT("total is now", state.get().total)`: the two
    // literals emit nothing, so only the two values reach the wire, each at ordinal 1 of its call.
    expect(entry.cheats).toHaveLength(2);
    expect(entry.cheats.map((cheat) => cheat.part)).toEqual([1, 1]);
    expect(new Set(entry.cheats.map((cheat) => cheat.id)).size).toBe(2);

    // Assert the bytes, not just their length. A payload dropped on the way to the host still reports
    // the size it was asked for, so size alone cannot tell a real read from a lost one — which is how
    // a native-side bug reading state at guest offset 0 survived every simulator test.
    expect(entry.cheats.map((cheat) => cheat.hex)).toEqual(["0700000000000000", "0700000000000000"]);
});

// The trace leaves the node as JSON on /live/v1/debug-trace, so a bigint anywhere in an entry is a 500
// for every caller of that route — and cheats are the only part of an entry a plain contract can't reach.
test("a trace carrying a CC_PRINT survives the JSON the debug-trace route sends", async () => {
    const { sim } = await deployCheats();

    sim.procedure(28, ADD, new Uint8Array(new BigUint64Array([7n]).buffer));

    expect(() => JSON.stringify(sim.getTrace())).not.toThrow();
});

// Put_input { ABC abc; sint32 neg; bit flag; }: a = 5, b = 7, neg = -3, flag set.
function putInput(): Uint8Array {
    const input = new Uint8Array(24);
    const view = new DataView(input.buffer);

    view.setBigUint64(0, 5n, true);
    view.setUint16(8, 7, true);
    view.setInt32(16, -3, true);
    input[20] = 1;

    return input;
}

async function runShapes(): Promise<QubicSimulator> {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, await wasm("CheatShapes"));
    sim.query(28, GET);
    sim.procedure(28, PUT, putInput());

    return sim;
}

// The reader decodes a record by the type the IDL holds for its part, so the two must agree on the size
// for every shape a contract can print. This is the arbiter for the IDL typer: an argument it fails to
// type ships its real bytes against a uint64 and lands here.
test("every record is exactly its IDL type's size, or a register-borne scalar", async () => {
    const sim = await runShapes();
    const sites = new Map((await loadWasmFixtureIdl("CheatShapes")).cheats.map((cheat) => [cheat.id, cheat]));
    const records = sim.getTrace().entries.flatMap((entry) => entry.cheats);

    // Fifteen values across the two entries, plus the marker of the all-literal print the flag selects.
    expect(records).toHaveLength(17);

    for (const record of records) {
        const part = sites.get(record.id)?.parts[record.part];

        expect(part, `line ${record.id} part ${record.part}`).toBeDefined();

        if (part!.lit !== undefined) {
            expect(record.size).toBe(0);
        } else if (record.size === 0) {
            expect(part!.type?.kind, `line ${record.id} part ${record.part}`).toBe(AbiTypeKind.SCALAR);
        } else {
            expect(record.size, `line ${record.id} part ${record.part} (${part!.expr})`).toBe(part!.type!.size);
        }
    }
});

test("a struct, a sub-word field, and an empty struct ship their exact bytes", async () => {
    const sim = await runShapes();
    const [get, put] = sim.getTrace().entries;
    const bytes = (entry: typeof get, part: number, id: number) => entry.cheats.find((cheat) => cheat.id === id && cheat.part === part)?.hex;

    const [emptyInput] = get.cheats.filter((cheat) => cheat.size === 1);
    expect(emptyInput.hex).toBe("00");

    const [wholeStruct, narrowField, signedField, flag] = put.cheats.slice(0, 4);
    expect([wholeStruct.hex, narrowField.hex, signedField.hex, flag.hex]).toEqual(["05000000000000000700000000000000", "0700", "fdffffff", "01"]);
    expect(bytes(put, 0, wholeStruct.id)).toBe(wholeStruct.hex);
});

test("a scalar temporary rides in the register, sign-extended, with no bytes", async () => {
    const sim = await runShapes();
    const registers = sim.getTrace().entries.flatMap((entry) => entry.cheats.filter((cheat) => cheat.size === 0 && cheat.part > 0));

    // `output.value + 2` from Get, then `input.neg + 1` from Put: -3 + 1 as the i64 the wasm computed.
    expect(registers.map((cheat) => cheat.value)).toEqual(["2", "-2"]);
});
