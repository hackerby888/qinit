// Runs contract flows in the TS engine and compares state against canonical K12 digests.
import { test, expect } from "bun:test";
import { k12Hex } from "@qinit/core";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { contractId, readUint64LE } from "../support/helpers";

const GET = 1; // REGISTER_USER_FUNCTION(Get, 1)
const INC = 1; // REGISTER_USER_PROCEDURE(Inc, 1)

test("Counter: deploy -> Get=0 -> Inc -> Get=1, digest = K12(state)", async () => {
  await initK12();
  const sim = new QubicSimulator();
  sim.deploy(28, await wasm("Counter"));
  expect(readUint64LE(sim.query(28, GET))).toBe(0n);
  sim.procedure(28, INC);
  expect(readUint64LE(sim.query(28, GET))).toBe(1n);
  // After one Inc the 8-byte state is uint64 LE 1; the digest must equal K12 of exactly those bytes.
  expect(sim.digest(28)).toBe(await k12Hex(new Uint8Array([1, 0, 0, 0, 0, 0, 0, 0])));
});

test("DigestProbe: reproduces the cross-platform digest oracle", async () => {
  await initK12();
  const sim = new QubicSimulator();
  const c = sim.deploy(29, await wasm("DigestProbe"));
  expect(c.stateSize).toBe(64); // rich mixed-width StateData (uint8/16/32/64, sint64, Array<uint64,4>, Array<uint8,8>)
  expect(readUint64LE(sim.query(29, GET))).toBe(0n);
  sim.procedure(29, INC); // deploy -> Get -> Inc -> Get, matching `qinit test`
  expect(readUint64LE(sim.query(29, GET))).toBe(1n);
  // The node's canonical post-Inc state digest — the cross-platform digest-check oracle. A wrong marshalling
  // of the 64-byte layout (or wrong K12) diverges this.
  expect(sim.digest(29)).toBe("4b31b54f2213f1396cec4a1bd633b9409112d5969592c2c5fa66ddc1656f63c9");
});

test("applyTx isolates a faulting procedure — no throw, the node survives, the fault rolls back", async () => {
  await initK12();
  const sim = new QubicSimulator();
  sim.deploy(28, await wasm("Trap"));
  const dest = contractId(28);
  const src = new Uint8Array(32).fill(0x11);
  const BUMP = 1,
    DIV = 2; // Trap: REGISTER_USER_PROCEDURE(Bump,1) / (Div,2)

  sim.applyTx(src, dest, 0n, BUMP, new Uint8Array(0), "t1"); // n -> 1
  expect(readUint64LE(sim.query(28, GET))).toBe(1n);

  const divIn = new Uint8Array(16); // Div_input { a, b }: a=7, b=0 -> wasm i64.div traps
  new DataView(divIn.buffer).setBigUint64(0, 7n, true);
  new DataView(divIn.buffer).setBigUint64(8, 0n, true);
  expect(() => sim.applyTx(src, dest, 0n, DIV, divIn, "t2")).not.toThrow(); // isolated, not a process crash

  sim.applyTx(src, dest, 0n, BUMP, new Uint8Array(0), "t3"); // node survived -> Bump still applies
  expect(readUint64LE(sim.query(28, GET))).toBe(2n); // Div left n untouched (rolled back); only the two Bumps counted
});
