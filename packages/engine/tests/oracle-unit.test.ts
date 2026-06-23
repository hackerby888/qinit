// OracleManager (oracle.ts) in isolation — no Sim. A fake OracleHost stands in for the spectrum (fee charge)
// and contract execution (notification), so the query/subscription/resolve logic is exercised directly.
import { test, expect } from "bun:test";
import { OracleManager, ORACLE_STATUS, type OracleHost } from "../src/oracle";

interface Notification {
  slot: number;
  procId: number;
  input: Uint8Array;
}

// A fake host: per-slot balances, a debit log, captured notifications, and a settable clock.
function fakeHost(): OracleHost & { balances: Map<number, bigint>; notifications: Notification[]; clock: number } {
  const balances = new Map<number, bigint>();
  const notifications: Notification[] = [];
  const h = {
    balances,
    notifications,
    clock: 0,
    contractBalance: (slot: number) => balances.get(slot) ?? 0n,
    debitContract: (slot: number, amount: bigint) => balances.set(slot, (balances.get(slot) ?? 0n) - amount),
    notify: (slot: number, procId: number, input: Uint8Array) => notifications.push({ slot, procId, input: input.slice() }),
    nowMs: () => h.clock,
  };
  return h;
}

test("query: charges the fee, records PENDING, returns the id; rejects when unaffordable", () => {
  const h = fakeHost();
  h.balances.set(7, 100n);
  const om = new OracleManager(h);

  const id = om.query(7, 1, new Uint8Array([1, 2, 3]), 99, 0, 30n, -1);
  expect(id).toBe(1n);
  expect(h.balances.get(7)).toBe(70n); // fee burned
  expect(om.queryStatus(id)).toBe(ORACLE_STATUS.PENDING);
  expect(Array.from(om.getQuery(id)!)).toEqual([1, 2, 3]);
  expect(om.getReply(id)).toBeNull(); // not resolved yet

  expect(om.query(7, 1, new Uint8Array(0), 99, 0, 1000n, -1)).toBe(-1n); // can't afford
  expect(om.query(7, 1, new Uint8Array(0), 99, 0, -5n, -1)).toBe(-1n); // negative fee
});

test("resolve: sets SUCCESS, exposes the reply, fires the notification with the OracleNotificationInput header", () => {
  const h = fakeHost();
  h.balances.set(3, 50n);
  const om = new OracleManager(h);
  const id = om.query(3, 0, new Uint8Array(0), 42, 0, 0n, -1);

  expect(om.resolve(id, new Uint8Array([9, 9]))).toBe(true);
  expect(om.queryStatus(id)).toBe(ORACLE_STATUS.SUCCESS);
  expect(Array.from(om.getReply(id)!)).toEqual([9, 9]);

  expect(h.notifications.length).toBe(1);
  const n = h.notifications[0];
  expect(n.slot).toBe(3);
  expect(n.procId).toBe(42);
  const dv = new DataView(n.input.buffer, n.input.byteOffset, n.input.byteLength);
  expect(dv.getBigInt64(0, true)).toBe(id); // queryId
  expect(dv.getInt32(8, true)).toBe(-1); // subscriptionId (one-time)
  expect(n.input[12]).toBe(ORACLE_STATUS.SUCCESS); // status
  expect(Array.from(n.input.subarray(16))).toEqual([9, 9]); // reply after the 16-byte header

  expect(om.resolve(999n, new Uint8Array(0))).toBe(false); // unknown queryId
});

test("subscribe: emits the first query now and re-emits when due via pump", () => {
  const h = fakeHost();
  h.balances.set(5, 1000n);
  const om = new OracleManager(h);

  const sub = om.subscribe(5, 0, new Uint8Array([1]), 7, 100, false, 10n);
  expect(sub).toBe(0);
  expect(h.balances.get(5)).toBe(990n); // first query charged immediately

  h.clock = 50; // before the period elapses
  om.pump();
  expect(h.balances.get(5)).toBe(990n); // not due yet

  h.clock = 100; // period reached
  om.pump();
  expect(h.balances.get(5)).toBe(980n); // re-emitted

  expect(om.unsubscribe(sub)).toBe(1);
  h.clock = 300;
  om.pump();
  expect(h.balances.get(5)).toBe(980n); // unsubscribed -> no more queries
});

test("pump with a provider auto-resolves PENDING queries", () => {
  const h = fakeHost();
  h.balances.set(2, 10n);
  const om = new OracleManager(h);
  const id = om.query(2, 1, new Uint8Array([0xaa]), 5, 0, 0n, -1);

  om.setProvider((iface, q) => (iface === 1 && q[0] === 0xaa ? new Uint8Array([0xbb]) : null));
  om.pump();

  expect(om.queryStatus(id)).toBe(ORACLE_STATUS.SUCCESS);
  expect(Array.from(om.getReply(id)!)).toEqual([0xbb]);
  expect(h.notifications.length).toBe(1);
});

test("queryStatus is UNKNOWN for an unseen id", () => {
  const om = new OracleManager(fakeHost());
  expect(om.queryStatus(123n)).toBe(ORACLE_STATUS.UNKNOWN);
});
