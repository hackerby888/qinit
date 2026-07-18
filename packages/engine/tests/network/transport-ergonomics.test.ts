// Ergonomics: VirtualNode.create() self-inits crypto (one await, no initK12 ceremony) and deploy()
// auto-assigns the slot by name (redeploy-by-name reuses it). This file deliberately never imports initK12 —
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { VirtualNode } from "../../src/transport";

test("create() self-inits crypto — deploy + advance run with no explicit initK12()", async () => {
  const eng = await VirtualNode.create(); // the one await; no initK12 ceremony
  const w = await wasm("Counter29");

  const c = eng.deploy(w, { name: "Counter" }); // k12 codeHash runs sync — crypto already resolved
  expect(c.slot).toBe(29);

  const tick = eng.advanceTick(1); // tick-vote signing runs sync — crypto resolved
  expect(typeof tick).toBe("number");
});

test("auto-assign: distinct names get ascending slots from the derived slot base", async () => {
  const eng = await VirtualNode.create();
  expect(eng.deploy(await wasm("Counter29"), { name: "A" }).slot).toBe(29);
  expect(eng.deploy(await wasm("Counter30"), { name: "B" }).slot).toBe(30);
  expect(eng.deploy(await wasm("Counter31"), { name: "C" }).slot).toBe(31);
});

test("the assigned slot is knowable after deploy — Contract.slot now, slotOf(name) later", async () => {
  const eng = await VirtualNode.create();
  const w = await wasm("Counter29");
  const c = eng.deploy(w, { name: "Counter" });
  expect(c.slot).toBe(29); // at deploy time
  expect(eng.slotOf("Counter")).toBe(29); // later, by name, without the Contract
  expect(eng.slotOf("Nope")).toBeUndefined();
});

test("redeploy by name reuses the same slot (routes into the migrate/preserve path)", async () => {
  const eng = await VirtualNode.create();
  const w = await wasm("Counter29");
  const first = eng.deploy(w, { name: "Counter" }).slot;
  eng.deploy(await wasm("Counter30"), { name: "Other" }); // takes the next slot
  expect(eng.deploy(w, { name: "Counter" }).slot).toBe(first); // back to Counter's slot
});

test("unnamed deploys never collide — each gets a fresh slot", async () => {
  const eng = await VirtualNode.create();
  expect(eng.deploy(await wasm("Counter29")).slot).not.toBe(
    eng.deploy(await wasm("Counter30")).slot,
  );
});

test("explicit slot pins (escape hatch); auto-assign skips taken slots", async () => {
  const eng = await VirtualNode.create();
  expect(eng.deploy(await wasm("Counter5"), { name: "Sys", slot: 5 }).slot).toBe(5);
  expect(eng.deploy(await wasm("Counter"), { name: "Pin28", slot: 28 }).slot).toBe(28);
  expect(eng.deploy(await wasm("Counter29"), { name: "Auto" }).slot).toBe(29);
});

test("legacy positional deploy(slot, wasm, name) still works", async () => {
  const eng = await VirtualNode.create();
  const w = await wasm("Counter40");
  expect(eng.deploy(40, w, "Legacy").slot).toBe(40);
});

test("undeploy frees the name -> next deploy of that name re-allocates the slot", async () => {
  const eng = await VirtualNode.create();
  const w = await wasm("Counter29");
  const s = eng.deploy(w, { name: "Tmp" }).slot;
  expect(eng.undeploy(s)).toBe(true);
  expect(eng.deploy(w, { name: "Tmp" }).slot).toBe(s);
});
