// Phase 3 — semantics breadth: invocationReward, qpi.transfer (+ balances), the POST_INCOMING_TRANSFER
// trigger (procedureTransaction + contract-to-contract), insufficient-funds, and the BEGIN_TICK lifecycle
import { test, expect } from "bun:test";
import { bytesToIdentity } from "@qinit/core";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

const USER = new Uint8Array(32).fill(0xab); // a non-contract id (high words != 0)
function cid(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}
function get(sim: Sim, slot: number) {
  const b = sim.query(slot, 1);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    totalReceived: dv.getBigUint64(0, true),
    incomingCount: dv.getBigUint64(8, true),
    lastIncoming: dv.getBigInt64(16, true),
    tickCount: dv.getBigUint64(24, true),
  };
}
function sendInput(dest: Uint8Array, amount: bigint): Uint8Array {
  const b = new Uint8Array(40); // Send_input { id dest(32); sint64 amount(8) }
  b.set(dest.subarray(0, 32), 0);
  new DataView(b.buffer).setBigInt64(32, amount, true);
  return b;
}
function send(sim: Sim, slot: number, dest: Uint8Array, amount: bigint): bigint {
  const b = sim.procedure(slot, 2, sendInput(dest, amount));
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true);
}

test("invocationReward credits the contract + fires POST_INCOMING_TRANSFER (procedureTransaction)", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Vault"));
  sim.procedure(28, 1, new Uint8Array(0), { invocator: USER, reward: 100n }); // Deposit, 100 Qu
  const g = get(sim, 28);
  expect(g.totalReceived).toBe(100n); // Deposit read qpi.invocationReward()
  expect(g.incomingCount).toBe(1n); // PIT fired before the procedure
  expect(g.lastIncoming).toBe(100n);
  expect(sim.balanceOf(28)).toBe(100n); // contract credited
});

test("transfer to a user moves balance, no PIT; insufficient transfer is a no-op", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Vault"));
  sim.procedure(28, 1, new Uint8Array(0), { invocator: USER, reward: 100n });
  expect(send(sim, 28, USER, 30n)).toBe(70n); // returns remaining balance
  expect(sim.balanceOf(28)).toBe(70n);
  expect(sim.balance(USER)).toBe(30n);
  expect(get(sim, 28).incomingCount).toBe(1n); // user dest -> no extra PIT
  expect(send(sim, 28, USER, 1000n)).toBe(-930n); // 70 - 1000 < 0 -> nothing moves
  expect(sim.balanceOf(28)).toBe(70n);
});

test("transfer host events show eight chars from both ends of a Qubic identity", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Vault"));
  sim.procedure(28, 1, new Uint8Array(0), { invocator: USER, reward: 100n });
  sim.setDebug(true);

  expect(send(sim, 28, USER, 30n)).toBe(70n);

  const identity = await bytesToIdentity(USER);
  const call = sim
    .getTrace()
    .entries.at(-1)
    ?.hostCalls.find((host) => host.name === "transfer");
  expect(call?.detail).toBe(`→ ${identity.slice(0, 8)}…${identity.slice(-8)} 30`);
});

test("contract-to-contract transfer fires the destination's POST_INCOMING_TRANSFER", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Vault"));
  sim.deploy(29, await wasm("Vault29"));
  sim.procedure(28, 1, new Uint8Array(0), { invocator: USER, reward: 100n });
  expect(send(sim, 28, cid(29), 50n)).toBe(50n);
  expect(sim.balanceOf(28)).toBe(50n);
  expect(sim.balanceOf(29)).toBe(50n);
  const g29 = get(sim, 29);
  expect(g29.incomingCount).toBe(1n); // slot 29's PIT fired (nested, synchronous)
  expect(g29.lastIncoming).toBe(50n);
  expect(g29.totalReceived).toBe(0n); // no Deposit on 29
});

test("BEGIN_TICK lifecycle sweep runs each tick, all contracts", async () => {
  await initK12();
  const sim = new Sim();
  sim.deploy(28, await wasm("Vault"));
  sim.deploy(29, await wasm("Vault29"));
  sim.beginTick();
  sim.beginTick();
  sim.beginTick();
  expect(get(sim, 28).tickCount).toBe(3n);
  expect(get(sim, 29).tickCount).toBe(3n);
});
