// Verifies crypto self-initialization and stable automatic slot assignment.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { TEST_SLOT_LAYOUT } from "../../../../test-utils/slot-layout";
import { VirtualNode } from "../../src/transport";

// The node takes its dynamic window from the live core headers; auto-assign starts at its base.
const base = TEST_SLOT_LAYOUT.slotBase;
const node = () => VirtualNode.create(TEST_SLOT_LAYOUT);

test("create() self-inits crypto — deploy + advance run with no explicit initK12()", async () => {
    const eng = await node(); // the one await; no initK12 ceremony
    const w = await wasm("CounterDyn0");

    const c = eng.deploy(w, { name: "Counter" }); // k12 codeHash runs sync — crypto already resolved
    expect(c.slot).toBe(base);

    const tick = eng.advanceTick(1); // tick-vote signing runs sync — crypto resolved
    expect(typeof tick).toBe("number");
});

test("auto-assign: distinct names get ascending slots from the derived slot base", async () => {
    const eng = await node();
    expect(eng.deploy(await wasm("CounterDyn0"), { name: "A" }).slot).toBe(base);
    expect(eng.deploy(await wasm("CounterDyn1"), { name: "B" }).slot).toBe(base + 1);
    expect(eng.deploy(await wasm("CounterDyn2"), { name: "C" }).slot).toBe(base + 2);
});

test("the assigned slot is knowable after deploy — Contract.slot now, slotOf(name) later", async () => {
    const eng = await node();
    const w = await wasm("CounterDyn0");
    const c = eng.deploy(w, { name: "Counter" });
    expect(c.slot).toBe(base); // at deploy time
    expect(eng.slotOf("Counter")).toBe(base); // later, by name, without the Contract
    expect(eng.slotOf("Nope")).toBeUndefined();
});

test("redeploy by name reuses the same slot (routes into the migrate/preserve path)", async () => {
    const eng = await node();
    const w = await wasm("CounterDyn0");
    const first = eng.deploy(w, { name: "Counter" }).slot;
    eng.deploy(await wasm("CounterDyn1"), { name: "Other" }); // takes the next slot
    expect(eng.deploy(w, { name: "Counter" }).slot).toBe(first); // back to Counter's slot
});

test("unnamed deploys never collide — each gets a fresh slot", async () => {
    const eng = await node();
    expect(eng.deploy(await wasm("CounterDyn0")).slot).not.toBe(eng.deploy(await wasm("CounterDyn1")).slot);
});

test("explicit slot pins (escape hatch); auto-assign skips taken slots", async () => {
    const eng = await node();
    expect(eng.deploy(await wasm("Counter5"), { name: "Sys", slot: 5 }).slot).toBe(5);
    expect(eng.deploy(await wasm("Counter"), { name: "Pin28", slot: 28 }).slot).toBe(28);
    expect(eng.deploy(await wasm("CounterDyn0"), { name: "Auto" }).slot).toBe(base);
});

test("legacy positional deploy(slot, wasm, name) still works", async () => {
    const eng = await node();
    const w = await wasm("Counter40");
    expect(eng.deploy(40, w, "Legacy").slot).toBe(40);
});

test("undeploy frees the name -> next deploy of that name re-allocates the slot", async () => {
    const eng = await node();
    const w = await wasm("CounterDyn0");
    const s = eng.deploy(w, { name: "Tmp" }).slot;
    expect(eng.undeploy(s)).toBe(true);
    expect(eng.deploy(w, { name: "Tmp" }).slot).toBe(s);
});
