// Inter-contract calls — Proxy (slot 29) calls Counter (slot 28, lower index) via liteCallFunction (CALL
// function) and liteInvokeProcedure (INVOKE procedure). Routing is by contract index to whatever Contract is
// deployed at the callee slot (a user contract here; a system contract would be its wasm deployed the same way).
import { test, expect } from "bun:test";
import { initK12 } from "../src/k12";
import { Sim } from "../src/sim";

const FIX = import.meta.dir + "/fixtures";

async function wasm(n: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${n}.wasm`).arrayBuffer());
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

test("Proxy calls Counter: CALL function + INVOKE procedure cross the contract boundary", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(28, await wasm("Counter")); // callee (lower index)
  sim.deploy(29, await wasm("Proxy")); // caller, built --callee Counter=...@28

  // Proxy.ReadCounter (fn 1) -> Counter.Get
  expect(u64(sim.query(29, 1))).toBe(0n);
  expect(u64(sim.query(28, 1))).toBe(0n);

  // Proxy.BumpCounter (proc 1) -> Counter.Inc
  sim.procedure(29, 1);
  expect(u64(sim.query(28, 1))).toBe(1n); // Counter incremented through Proxy
  expect(u64(sim.query(29, 1))).toBe(1n); // Proxy reads Counter == 1

  sim.procedure(29, 1);
  expect(u64(sim.query(28, 1))).toBe(2n);
});

test("inter-contract guards: missing callee + lower-index rule -> CallErrorContractInactive", async () => {
  await initK12();

  const sim = new Sim();
  sim.deploy(29, await wasm("Proxy"));
  const ORIG = new Uint8Array(32);

  // callee 28 not deployed
  expect(sim.doCallFunction(29, 28, 1, new Uint8Array(0), ORIG).error).toBe(4);

  // lower-index rule: callee index >= caller index is rejected
  sim.deploy(28, await wasm("Counter"));
  expect(sim.doCallFunction(28, 29, 1, new Uint8Array(0), ORIG).error).toBe(4);
});
