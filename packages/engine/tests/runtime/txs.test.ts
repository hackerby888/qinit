// Covers contract transactions, plain transfers, spectrum balances, TickData, and getEntity.
import { test, expect } from "bun:test";
import { buildSignedTx, deriveIdentity } from "@qinit/core";
import { contractAddress, encodeInput } from "@qinit/proto";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";
import { VirtualNode } from "../../src/transport";

const SEED = "a".repeat(55);

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function seedPubkey(): Promise<Uint8Array> {
  return hexToBytes((await deriveIdentity(SEED)).publicKeyHex);
}

// Vault Get output: { uint64 totalReceived; uint64 incomingCount; sint64 lastIncoming; uint64 tickCount }
function vaultGet(sim: Sim, slot: number) {
  const b = sim.query(slot, 1);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    totalReceived: dv.getBigUint64(0, true),
    incomingCount: dv.getBigUint64(8, true),
    lastIncoming: dv.getBigInt64(16, true),
  };
}

test("regular transfer moves spectrum balance + lands in the tick", async () => {
  await initK12();

  const sim = new Sim();
  const A = new Uint8Array(32).fill(0x11);
  const B = new Uint8Array(32).fill(0x22);
  sim.fund(A, 1000n);

  const r = sim.applyTx(A, B, 100n, 0, new Uint8Array(0), "tx-1");
  expect(r.moneyFlew).toBe(true);
  expect(sim.balance(A)).toBe(900n);
  expect(sim.balance(B)).toBe(100n);

  const txs = sim.tickTransactions(sim.tickN);
  expect(txs.length).toBe(1);
  expect(txs[0].txId).toBe("tx-1");
  expect(sim.txByHash("tx-1")?.amount).toBe(100n);
});

test("insufficient source: moneyFlew false, no balance change (tx still recorded)", async () => {
  await initK12();

  const sim = new Sim();
  const A = new Uint8Array(32).fill(0x11);
  const B = new Uint8Array(32).fill(0x22);
  sim.fund(A, 50n);

  const r = sim.applyTx(A, B, 100n, 0, new Uint8Array(0), "tx-2");
  expect(r.moneyFlew).toBe(false);
  expect(sim.balance(A)).toBe(50n);
  expect(sim.balance(B)).toBe(0n);
  expect(sim.tickTransactions(sim.tickN).length).toBe(1);
});

test("contract procedure tx (real signed): source debited, procedure runs with invocationReward", async () => {
  await initK12();

  const eng = new VirtualNode({ mempool: false }); // assert tx EFFECT immediately (not mempool scheduling)
  await eng.seedFaucet();
  eng.deploy(28, await wasm("Vault"), "Vault");
  const seed = await seedPubkey();
  const before = eng.sim.balance(seed);

  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(28),
    amount: 100,
    tick: 10,
    inputType: 1,
    payload: await encodeInput(""),
  });
  expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

  const g = vaultGet(eng.sim, 28);
  expect(g.totalReceived).toBe(100n); // Deposit read qpi.invocationReward()
  expect(g.incomingCount).toBe(1n); // POST_INCOMING_TRANSFER (procedureTransaction)
  expect(eng.sim.balanceOf(28)).toBe(100n);
  expect(eng.sim.balance(seed)).toBe(before - 100n);
});

test("plain transfer to a contract (inputType 0): POST_INCOMING_TRANSFER fires, no procedure", async () => {
  await initK12();

  const eng = new VirtualNode({ mempool: false }); // assert tx EFFECT immediately (not mempool scheduling)
  await eng.seedFaucet();
  eng.deploy(28, await wasm("Vault"), "Vault");

  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(28),
    amount: 50,
    tick: 10,
    inputType: 0,
    payload: new Uint8Array(0),
  });
  expect((await eng.broadcastTx(tx.bytes)).ok).toBe(true);

  const g = vaultGet(eng.sim, 28);
  expect(g.totalReceived).toBe(0n); // Deposit did NOT run (inputType 0 is not a procedure)
  expect(g.incomingCount).toBe(1n); // PIT (standardTransaction) fired
  expect(g.lastIncoming).toBe(50n);
  expect(eng.sim.balanceOf(28)).toBe(50n);
});

test("getEntity: a contract reads an account's balance from the spectrum", async () => {
  await initK12();

  const eng = new VirtualNode();
  eng.deploy(28, await wasm("Watcher"), "Watcher");
  const X = new Uint8Array(32).fill(0x33);
  eng.fund(X, 777n);

  const out = await eng.querySmartContract(28, 1, X); // Balance(who=X)
  expect(new DataView(out.buffer, out.byteOffset, out.byteLength).getBigInt64(0, true)).toBe(777n);
});
