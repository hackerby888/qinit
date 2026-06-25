// Ergonomics: InProcessEngine.create() self-inits crypto (one await, no initK12 ceremony) and deploy()
// auto-assigns the slot by name (redeploy-by-name reuses it). This file deliberately never imports initK12 —
// every test drives crypto purely through create(), proving the engine sets it up behind the scenes.
import { test, expect } from "bun:test";
import { InProcessEngine } from "../src/transport";

const FIX = import.meta.dir + "/fixtures";
async function wasm(n: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${n}.wasm`).arrayBuffer());
}

test("create() self-inits crypto — deploy + advance run with no explicit initK12()", async () => {
  const eng = await InProcessEngine.create(); // the one await; no initK12 ceremony
  const w = await wasm("Counter");

  const c = eng.deploy(w, { name: "Counter" }); // k12 codeHash runs sync — crypto already resolved
  expect(c.slot).toBe(28);

  const tick = eng.advanceTick(1); // tick-vote signing runs sync — crypto resolved
  expect(typeof tick).toBe("number");
});

test("auto-assign: distinct names get ascending slots from slotBase (28)", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  expect(eng.deploy(w, { name: "A" }).slot).toBe(28);
  expect(eng.deploy(w, { name: "B" }).slot).toBe(29);
  expect(eng.deploy(w, { name: "C" }).slot).toBe(30);
});

test("the assigned slot is knowable after deploy — Contract.slot now, slotOf(name) later", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  const c = eng.deploy(w, { name: "Counter" });
  expect(c.slot).toBe(28); // at deploy time
  expect(eng.slotOf("Counter")).toBe(28); // later, by name, without the Contract
  expect(eng.slotOf("Nope")).toBeUndefined();
});

test("redeploy by name reuses the same slot (routes into the migrate/preserve path)", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  const first = eng.deploy(w, { name: "Counter" }).slot;
  eng.deploy(w, { name: "Other" }); // takes the next slot
  expect(eng.deploy(w, { name: "Counter" }).slot).toBe(first); // back to Counter's slot
});

test("unnamed deploys never collide — each gets a fresh slot", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  expect(eng.deploy(w).slot).not.toBe(eng.deploy(w).slot);
});

test("explicit slot pins (escape hatch); auto-assign skips taken slots", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  expect(eng.deploy(w, { name: "Sys", slot: 5 }).slot).toBe(5); // pin below slotBase (system-contract style)
  expect(eng.deploy(w, { name: "Pin28", slot: 28 }).slot).toBe(28);
  expect(eng.deploy(w, { name: "Auto" }).slot).toBe(29); // auto skips the taken 28
});

test("legacy positional deploy(slot, wasm, name) still works", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  expect(eng.deploy(40, w, "Legacy").slot).toBe(40);
});

test("undeploy frees the name -> next deploy of that name re-allocates the slot", async () => {
  const eng = await InProcessEngine.create();
  const w = await wasm("Counter");
  const s = eng.deploy(w, { name: "Tmp" }).slot;
  expect(eng.undeploy(s)).toBe(true);
  expect(eng.deploy(w, { name: "Tmp" }).slot).toBe(s);
});
