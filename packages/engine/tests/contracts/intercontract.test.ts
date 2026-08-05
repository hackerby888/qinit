// Proxy exercises function and procedure calls into a lower-index Counter contract.
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { readUint64LE } from "../support/helpers";

test("Proxy calls Counter: CALL function + INVOKE procedure cross the contract boundary", async () => {
  await initK12();

  const sim = new QubicSimulator();
  sim.deploy(28, await wasm("Counter")); // callee (lower index)
  sim.deploy(29, await wasm("Proxy")); // caller, built --callee Counter=...@28

  // Proxy.ReadCounter (fn 1) -> Counter.Get
  expect(readUint64LE(sim.query(29, 1))).toBe(0n);
  expect(readUint64LE(sim.query(28, 1))).toBe(0n);

  // Proxy.BumpCounter (proc 1) -> Counter.Inc
  sim.procedure(29, 1);
  expect(readUint64LE(sim.query(28, 1))).toBe(1n); // Counter incremented through Proxy
  expect(readUint64LE(sim.query(29, 1))).toBe(1n); // Proxy reads Counter == 1

  sim.procedure(29, 1);
  expect(readUint64LE(sim.query(28, 1))).toBe(2n);
});

test("inter-contract guards: missing callee + lower-index rule -> CallErrorContractInactive", async () => {
  await initK12();

  const sim = new QubicSimulator();
  sim.deploy(29, await wasm("Proxy"));
  const ORIG = new Uint8Array(32);

  // callee 28 not deployed
  expect(sim.doCallFunction(29, 28, 1, new Uint8Array(0), ORIG).error).toBe(4);

  // lower-index rule: callee index >= caller index is rejected
  sim.deploy(28, await wasm("Counter"));
  expect(sim.doCallFunction(28, 29, 1, new Uint8Array(0), ORIG).error).toBe(4);
});
