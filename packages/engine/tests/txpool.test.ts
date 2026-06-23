// TxPool (txs.ts) in isolation — no Sim. The per-tick tx history + tx-by-id index + the mempool scheduling
// extracted from the Sim god object. Pure storage: no money/contract logic.
import { test, expect } from "bun:test";
import { TxPool, type TxRecord, type QueuedTx } from "../src/txs";

function rec(txId: string, tick: number): TxRecord {
  return { txId, tick, source: "aa", dest: "bb", amount: 5n, inputType: 0, moneyFlew: true, digest: new Uint8Array(32) };
}

function qtx(txId: string): QueuedTx {
  return { source: new Uint8Array(32), dest: new Uint8Array(32), amount: 1n, inputType: 0, payload: new Uint8Array(0), txId, digest: new Uint8Array(32) };
}

test("record indexes a tx under its tick and by id; size counts unique txs", () => {
  const p = new TxPool();
  p.record(rec("t1", 5));
  p.record(rec("t2", 5));
  p.record(rec("t3", 6));

  expect(p.size).toBe(3);
  expect(p.tickTransactions(5).map((r) => r.txId)).toEqual(["t1", "t2"]);
  expect(p.tickTransactions(6).map((r) => r.txId)).toEqual(["t3"]);
  expect(p.tickTransactions(9)).toEqual([]); // empty tick
  expect(p.txByHash("t2")?.tick).toBe(5);
  expect(p.txByHash("nope")).toBeUndefined();
});

test("mempool: queue holds txs per scheduled tick; takeDue removes + returns them once", () => {
  const p = new TxPool();
  p.queue(10, qtx("a"));
  p.queue(10, qtx("b"));
  p.queue(11, qtx("c"));

  expect(p.takeDue(9)).toEqual([]); // nothing scheduled
  const due = p.takeDue(10);
  expect(due.map((t) => t.txId)).toEqual(["a", "b"]);
  expect(p.takeDue(10)).toEqual([]); // drained — taking again yields nothing
  expect(p.takeDue(11).map((t) => t.txId)).toEqual(["c"]);
});
