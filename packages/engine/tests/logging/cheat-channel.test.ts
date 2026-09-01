// The cheat channel is the point of the design: CC_PRINT has to be readable from a function, and it
// must never appear as a protocol log. These tests pin both halves.
import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { QubicLogStore } from "../../src/logging/qubic-log-store";

const ADD = 1;
const TOTAL = 1;

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
