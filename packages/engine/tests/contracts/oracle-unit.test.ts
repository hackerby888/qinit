import { expect, test } from "bun:test";
import { OracleManager, ORACLE_STATUS, type OracleHost } from "../../src/oracle";
import { packDateAndTime } from "../../src/runtime";

interface Notification {
  slot: number;
  procId: number;
  input: Uint8Array;
}

function fakeHost(): OracleHost & {
  balances: Map<number, bigint>;
  notifications: Notification[];
  clock: number;
} {
  const balances = new Map<number, bigint>();
  const notifications: Notification[] = [];
  const host = {
    balances,
    notifications,
    clock: Date.UTC(2026, 0, 1),
    contractBalance: (slot: number) => balances.get(slot) ?? 0n,
    debitContract: (slot: number, amount: bigint) =>
      balances.set(slot, (balances.get(slot) ?? 0n) - amount),
    notify: (slot: number, procId: number, input: Uint8Array) =>
      notifications.push({ slot, procId, input: input.slice() }),
    nowMs: () => host.clock,
  };
  return host;
}

function subscriptionQuery(tag = 1): Uint8Array {
  const query = new Uint8Array(16);
  query[0] = tag;
  return query;
}

test("one-time query charges once and delivers the typed reply", () => {
  const host = fakeHost();
  host.balances.set(7, 100n);
  const oracle = new OracleManager(host);

  const queryId = oracle.query(7, 0, new Uint8Array([1, 2, 3]), 2, 99, 1_000, 10n);
  expect(queryId).toBe(1n);
  expect(host.balances.get(7)).toBe(90n);
  expect(oracle.queryStatus(queryId)).toBe(ORACLE_STATUS.PENDING);
  expect(oracle.resolve(queryId, new Uint8Array([9, 8]))).toBe(true);

  const notification = host.notifications[0];
  const view = new DataView(
    notification.input.buffer,
    notification.input.byteOffset,
    notification.input.byteLength,
  );
  expect(notification.slot).toBe(7);
  expect(notification.procId).toBe(99);
  expect(view.getBigInt64(0, true)).toBe(queryId);
  expect(view.getInt32(8, true)).toBe(-1);
  expect(notification.input[12]).toBe(ORACLE_STATUS.SUCCESS);
  expect(Array.from(notification.input.subarray(16))).toEqual([9, 8]);
});

test("subscription requires whole minutes and charges only the SUBSCRIBE call", () => {
  const host = fakeHost();
  host.balances.set(5, 20_000n);
  const oracle = new OracleManager(host);
  const query = subscriptionQuery();

  const subscriptionId = oracle.subscribe(5, 0, query, 2, 8, 7, 60_000, false, 10_000n);
  expect(subscriptionId).toBe(0);
  expect(host.balances.get(5)).toBe(10_000n);
  expect(oracle.pending()).toHaveLength(1);
  expect(new DataView(oracle.pending()[0].query.buffer).getBigUint64(8, true)).toBe(
    packDateAndTime(host.clock),
  );

  oracle.setProvider(() => new Uint8Array([4, 2]));
  oracle.pump();
  host.clock += 60_000;
  oracle.pump();
  oracle.pump();
  expect(host.balances.get(5)).toBe(10_000n);

  expect(oracle.subscribe(5, 0, query, 2, 8, 8, 59_000, false, 10_000n)).toBe(-1);
  expect(oracle.subscribe(5, 0, query, 2, 8, 8, 60_001, false, 10_000n)).toBe(-1);
  expect(host.balances.get(5)).toBe(10_000n);
  expect(oracle.unsubscribe(5, subscriptionId)).toBe(1);
});

test("subscribers share a channel, can receive its previous reply, and expire at epoch change", () => {
  const host = fakeHost();
  host.balances.set(5, 1_000n);
  host.balances.set(6, 1_000n);
  const oracle = new OracleManager(host);
  const query = subscriptionQuery(3);

  const first = oracle.subscribe(5, 0, query, 2, 8, 11, 60_000, false, 100n);
  expect(oracle.resolve(1n, new Uint8Array([7, 9]))).toBe(true);
  const second = oracle.subscribe(6, 0, query, 2, 8, 12, 120_000, true, 100n);

  expect(second).toBe(first);
  expect(host.balances.get(5)).toBe(900n);
  expect(host.balances.get(6)).toBe(900n);
  const previous = host.notifications.at(-1)!;
  expect(previous.slot).toBe(6);
  expect(previous.input[12]).toBe(ORACLE_STATUS.SUCCESS);
  expect(Array.from(previous.input.subarray(16))).toEqual([7, 9]);
  expect(oracle.subscribe(6, 0, query, 2, 8, 12, 120_000, false, 100n)).toBe(-1);
  expect(host.balances.get(6)).toBe(900n);

  oracle.beginEpoch();
  expect(oracle.queryStatus(1n)).toBe(ORACLE_STATUS.UNKNOWN);
  expect(oracle.unsubscribe(5, first)).toBe(0);
});

test("expired queries notify TIMEOUT", () => {
  const host = fakeHost();
  host.balances.set(2, 10n);
  const oracle = new OracleManager(host);
  const queryId = oracle.query(2, 0, new Uint8Array([1]), 2, 3, 1_000, 10n);

  host.clock += 1_000;
  oracle.pump();
  expect(oracle.queryStatus(queryId)).toBe(ORACLE_STATUS.TIMEOUT);
  expect(host.notifications[0].input[12]).toBe(ORACLE_STATUS.TIMEOUT);
});
