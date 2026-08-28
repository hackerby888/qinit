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
        sim.advance(); // 10 ticks, no epoch boundary (epochLength defaults to 3000)
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

    for (let i = 0; i < 9; i++) {
        sim.advance(); // ticks 1..9 — still inside epoch 0
    }
    expect(sim.currentTick).toBe(9);
    expect(sim.currentEpoch).toBe(0);
    expect(counters(sim)).toEqual([9n, 9n, 0n, 0n]);

    sim.advance(); // tick 10 == boundary -> END_EPOCH, epoch++, BEGIN_EPOCH, then BEGIN_TICK/END_TICK
    expect(sim.currentTick).toBe(10);
    expect(sim.currentEpoch).toBe(1);
    expect(counters(sim)).toEqual([10n, 10n, 1n, 1n]);

    for (let i = 0; i < 10; i++) {
        sim.advance(); // a whole second epoch
    }
    expect(sim.currentEpoch).toBe(2);
    const [ticks, endticks, epochs, endepochs] = counters(sim);
    expect(ticks).toBe(20n);
    expect(endticks).toBe(20n);
    expect(epochs).toBe(2n); // BEGIN_EPOCH fired at tick 10 and tick 20
    expect(endepochs).toBe(2n); // END_EPOCH likewise
});

// epochLength was only reachable by assigning the field after construction, which a caller that rebuilds
// the node — the IDE's reset does — silently loses. These pin it as an option on both entry points.
test("epochLength is a constructor option on the simulator and the node", async () => {
    await initK12();
    expect(new QubicSimulator().epochLength).toBe(DEFAULT_EPOCH_LENGTH);
    expect(new QubicSimulator({ epochLength: 25 }).epochLength).toBe(25);
    expect((await VirtualNode.create({ epochLength: 25 })).sim.epochLength).toBe(25);

    // 0 keeps its existing meaning — the rollover never fires — and a fractional or negative value
    // would put the modulo check at line 1002 into a state no tick could satisfy.
    expect(new QubicSimulator({ epochLength: 0 }).epochLength).toBe(0);
    expect(new QubicSimulator({ epochLength: -5 }).epochLength).toBe(0);
    expect(new QubicSimulator({ epochLength: 7.9 }).epochLength).toBe(7);
});

test("a node built with a short epoch rolls over at that length", async () => {
    await initK12();
    const sim = new QubicSimulator({ epochLength: 4 });
    sim.deploy(28, await wasm("Hooks"));

    for (let i = 0; i < 8; i++) {
        sim.advance();
    }
    expect(sim.currentTick).toBe(8);
    expect(sim.currentEpoch).toBe(2); // boundaries at ticks 4 and 8
    const [, , epochs, endepochs] = counters(sim);
    expect(epochs).toBe(2n);
    expect(endepochs).toBe(2n);
});
