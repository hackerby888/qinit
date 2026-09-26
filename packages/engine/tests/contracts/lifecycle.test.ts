// Verifies tick and epoch lifecycle hooks, including boundary ordering.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { DEFAULT_EPOCH_LENGTH, QubicSimulator } from "../../src/qubic-simulator";
import { VirtualNode } from "../../src/transport";

const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)

// Get_output is { ticks, endticks, epochs, endepochs } — four uint64 LE, read by field index.
function field(b: Uint8Array, i: number): bigint {
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(i * 8, true);
}
function counters(sim: QubicSimulator): [bigint, bigint, bigint, bigint] {
    const s = sim.query(28, GET);
    return [field(s, 0), field(s, 1), field(s, 2), field(s, 3)];
}
test("BEGIN_TICK / END_TICK fire on every advanced tick", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.deploy(28, await wasm("Hooks"));

    // Deploy runs INITIALIZE only — no tick/epoch hook has fired yet.
    expect(counters(sim)).toEqual([0n, 0n, 0n, 0n]);

    for (let i = 0; i < 10; i++) {
        sim.advance(); // 10 ticks, no epoch boundary (the default epoch is thousands of ticks long)
    }

    const [ticks, endticks, epochs, endepochs] = counters(sim);
    expect(ticks).toBe(10n); // BEGIN_TICK x10
    expect(endticks).toBe(10n); // END_TICK x10
    expect(epochs).toBe(0n); // no boundary crossed -> no BEGIN_EPOCH
    expect(endepochs).toBe(0n);
    expect(sim.currentEpoch).toBe(0);
});

test("crossing an epoch boundary fires END_EPOCH then BEGIN_EPOCH", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.epochLength = 10; // short epoch so the test crosses a boundary quickly
    sim.deploy(28, await wasm("Hooks"));

    for (let i = 0; i < 10; i++) {
        sim.advance(); // ticks 1..10 — tick 10 is a full length past tick 0, and still epoch 0
    }
    expect(sim.currentTick).toBe(10);
    expect(sim.currentEpoch).toBe(0);
    expect(counters(sim)).toEqual([10n, 10n, 0n, 0n]);

    sim.advance(); // tick 11 -> END_EPOCH, epoch++, BEGIN_EPOCH, then BEGIN_TICK/END_TICK
    expect(sim.currentTick).toBe(11);
    expect(sim.currentEpoch).toBe(1);
    expect(counters(sim)).toEqual([11n, 11n, 1n, 1n]);

    for (let i = 0; i < 11; i++) {
        sim.advance(); // a whole second epoch
    }
    expect(sim.currentEpoch).toBe(2);
    const [ticks, endticks, epochs, endepochs] = counters(sim);
    expect(ticks).toBe(22n);
    expect(endticks).toBe(22n);
    expect(epochs).toBe(2n); // BEGIN_EPOCH fired at tick 11 and tick 22
    expect(endepochs).toBe(2n); // END_EPOCH likewise
});

// epochLength was only reachable by assigning the field after construction, which a caller rebuilding the node silently loses — pinned as an option here.
test("epochLength is a constructor option on the simulator and the node", async () => {
    await initK12();
    expect(new QubicSimulator().epochLength).toBe(DEFAULT_EPOCH_LENGTH);
    expect(new QubicSimulator({ epochLength: 25 }).epochLength).toBe(25);
    expect((await VirtualNode.create({ epochLength: 25 })).sim.epochLength).toBe(25);

    // 0 keeps its meaning — the rollover never fires — and a fractional or negative value would put the modulo check into a state no tick could satisfy.
    expect(new QubicSimulator({ epochLength: 0 }).epochLength).toBe(0);
    expect(new QubicSimulator({ epochLength: -5 }).epochLength).toBe(0);
    expect(new QubicSimulator({ epochLength: 7.9 }).epochLength).toBe(7);
});

test("a node built with a short epoch rolls over at that length", async () => {
    await initK12();
    const sim = new QubicSimulator({ epochLength: 4 });
    sim.deploy(28, await wasm("Hooks"));

    for (let i = 0; i < 10; i++) {
        sim.advance();
    }
    expect(sim.currentTick).toBe(10);
    expect(sim.currentEpoch).toBe(2); // switches at ticks 5 and 10
    const [, , epochs, endepochs] = counters(sim);
    expect(epochs).toBe(2n);
    expect(endepochs).toBe(2n);
});

// core measures the epoch on the tick it just finished, then moves the tick number, runs END_EPOCH under it in the old epoch, makes that tick
// the new epoch's first and runs BEGIN_EPOCH and BEGIN_TICK under it. Each reading is [tick, epoch, initialTick].
test("the epoch switches after the tick a full length past its own first tick, under core's tick numbers", async () => {
    await initK12();
    const sim = new QubicSimulator({ epochLength: 10 });
    sim.bootstrapEpoch(3);
    const firstTick = sim.initialTick;
    sim.deploy(28, await wasm("EpochWitness"));

    const seen = () => {
        const output = sim.query(28, 1);
        const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
        return Array.from({ length: 10 }, (_, index) => Number(view.getBigUint64(index * 8, true)));
    };

    for (let i = 0; i < 10; i++) {
        sim.advance();
    }
    expect(seen()[9]).toBe(0);

    sim.advance();
    const switchTick = firstTick + 11;
    expect(seen()).toEqual([switchTick, 3, firstTick, switchTick, 4, switchTick, switchTick, 4, switchTick, 1]);
    expect(sim.currentTick).toBe(switchTick);
    expect(sim.initialTick).toBe(switchTick);

    // a length changed mid-epoch moves the next switch, never the epoch's first tick.
    sim.epochLength = 4;
    for (let i = 0; i < 5; i++) {
        sim.advance();
    }
    expect(seen().slice(3, 6)).toEqual([switchTick + 5, 5, switchTick + 5]);
});

test("a node reports the epoch's stored first tick and core's last tick", async () => {
    const node = await VirtualNode.create({ epochLength: 10 });
    node.sim.bootstrapEpoch(2);
    const firstTick = node.sim.initialTick;

    expect(node.epochInfo()).toMatchObject({ epoch: 2, initialTick: firstTick, epochLastTick: firstTick + 9, duration: 10 });
    expect(node.advanceEpoch()).toMatchObject({ fromEpoch: 2, toEpoch: 3, tick: firstTick + 11, initialTick: firstTick + 11, switched: true });
    expect(node.epochInfo()).toMatchObject({ epoch: 3, initialTick: firstTick + 11, epochLastTick: firstTick + 20 });
});
