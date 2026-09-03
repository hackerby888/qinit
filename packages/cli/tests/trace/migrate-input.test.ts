// A migration's input is the old state, and it has no entry number to look a type up by. Without the
// IDL's OldStateData the whole old buffer renders as hex, which on a real contract is hundreds of KB.
import { expect, test } from "bun:test";
import { QubicSimulator } from "@qinit/engine";
import { initK12 } from "@qinit/engine/support/k12";
import { loadWasmFixture, loadWasmFixtureIdl } from "../../../../test-utils/wasm-fixtures";
import { describeTrace } from "../../src/trace/format";
import { entryLabel } from "../../src/trace/entry-label";

const INC = 1;
const MIGRATE_KIND = 3;

test("a migration trace decodes the old state through the IDL's OldStateData", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.setDebug(true);
    sim.deploy(28, await loadWasmFixture("CounterV1"));
    sim.procedure(28, INC);
    sim.procedure(28, INC);
    sim.procedure(28, INC);

    for (let tick = 0; tick < 3; tick++) {
        sim.advance();
    }

    sim.deploy(28, await loadWasmFixture("CounterV2"));

    const entry = sim.getTrace(0, 100).entries.find((candidate) => candidate.kind === MIGRATE_KIND);
    expect(entry).toBeDefined();
    expect(entry!.ok).toBe(true);
    expect(entry!.inSize).toBe(8); // OldStateData is v1's StateData: one uint64
    expect(entryLabel(entry!.kind, entry!.entry)).toBe("migrate");

    const decoded = await describeTrace(entry!, undefined, "Counter", undefined, await loadWasmFixtureIdl("CounterV2"));

    // The three Inc calls, read back through the old layout rather than as raw bytes.
    expect(decoded.inDecoded).toBe("3");
    expect(decoded.stateDiff.map((line) => line.label)).toEqual(["counter", "lastMigratedTick"]);
    expect(decoded.stateDiff[0].text).toBe("0 → 3");
    expect(decoded.stateDiff[1].text).toBe(`0 → ${sim.currentTick}`);
});
