// a live node gives a tick one timestamp, so two time reads inside the same tick can never straddle a second or a day.
import { afterEach, expect, test } from "bun:test";
import { QubicSimulator } from "../../src/qubic-simulator";

const realNow = Date.now;

afterEach(() => {
    Date.now = realNow;
});

test("the wall clock is read once per tick", () => {
    let wallClockMs = Date.UTC(2026, 0, 1, 23, 59, 59, 500);
    // every read moves the wall clock across a second boundary.
    Date.now = () => (wallClockMs += 600);

    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.clockMode = "real";

    const beforeAnyTick = sim.nowMs();
    expect(sim.nowMs()).toBe(beforeAnyTick);

    sim.advance();
    const firstTick = sim.nowMs();
    expect(sim.nowMs()).toBe(firstTick);
    expect(firstTick).toBeGreaterThan(beforeAnyTick);

    sim.advance();
    expect(sim.nowMs()).toBeGreaterThan(firstTick);
});

test("the deterministic clock still follows the tick number", () => {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });

    sim.advance();

    expect(sim.nowMs()).toBe(sim.timeBaseMs + sim.currentTick * sim.tickDuration);
});
