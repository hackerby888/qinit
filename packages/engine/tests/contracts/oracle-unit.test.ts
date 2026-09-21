import { expect, test } from "bun:test";
import { OracleManager, ORACLE_STATUS, type OracleHost } from "../../src/chain/oracle";
import { packDateAndTime } from "../../src/contract/runtime";
import {
    OracleQuery as DogeShareValidationOracleQuery,
    OracleReply as DogeShareValidationOracleReply,
} from "../../src/oracle-interfaces/doge-share-validation";
import { OracleQuery as MockOracleQuery, OracleReply as MockOracleReply } from "../../src/oracle-interfaces/mock";
import { OracleQuery as PriceOracleQuery, OracleReply as PriceOracleReply } from "../../src/oracle-interfaces/price";

interface Notification {
    slot: number;
    procId: number;
    input: Uint8Array;
}

function fakeHost(): OracleHost & {
    balances: Map<number, bigint>;
    notifications: Notification[];
    // every balance move and notification in the order it happened, e.g. ["decrease 10", "refund 10", "notify"].
    calls: string[];
    clock: number;
} {
    const balances = new Map<number, bigint>();
    const notifications: Notification[] = [];
    const calls: string[] = [];
    const host = {
        balances,
        notifications,
        calls,
        clock: Date.UTC(2026, 0, 1),
        energyOf: (slot: number) => balances.get(slot) ?? 0n,
        decreaseEnergyOf: (slot: number, amount: bigint) => {
            calls.push(`decrease ${amount}`);
            balances.set(slot, (balances.get(slot) ?? 0n) - amount);
        },
        refundEnergyOf: (slot: number, amount: bigint) => {
            calls.push(`refund ${amount}`);
            balances.set(slot, (balances.get(slot) ?? 0n) + amount);
        },
        notify: (slot: number, procId: number, input: Uint8Array) => {
            calls.push("notify");
            notifications.push({ slot, procId, input: input.slice() });
        },
        nowMs: () => host.clock,
    };
    return host;
}

function priceQuery(tag = 1): Uint8Array {
    const query = new Uint8Array(PriceOracleQuery.SIZE);
    query[0] = tag;
    return query;
}

test("one-time query charges once and delivers the typed reply", () => {
    const host = fakeHost();
    host.balances.set(7, 100n);
    const oracle = new OracleManager(host);

    const queryId = oracle.startContractQuery(7, 0, priceQuery(), PriceOracleReply.SIZE, 99, 1_000, 0n);
    expect(queryId).toBe(1n);
    expect(host.balances.get(7)).toBe(90n);
    expect(oracle.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.PENDING);
    expect(oracle.resolve(queryId, new Uint8Array(PriceOracleReply.SIZE).fill(9))).toBe(true);

    // a reply is committed when it arrives and revealed on the next tick, so nothing is notified yet.
    expect(oracle.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.COMMITTED);
    expect(host.notifications).toEqual([]);
    oracle.pump();
    expect(oracle.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.SUCCESS);

    const notification = host.notifications[0];
    const view = new DataView(notification.input.buffer, notification.input.byteOffset, notification.input.byteLength);
    expect(notification.slot).toBe(7);
    expect(notification.procId).toBe(99);
    expect(view.getBigInt64(0, true)).toBe(queryId);
    expect(view.getInt32(8, true)).toBe(-1);
    expect(notification.input[12]).toBe(ORACLE_STATUS.SUCCESS);
    expect(notification.input.subarray(16)).toEqual(new Uint8Array(PriceOracleReply.SIZE).fill(9));
});

test("query validates Core interface metadata before charging", () => {
    const host = fakeHost();
    host.balances.set(7, 2_000n);
    const oracle = new OracleManager(host);

    expect(oracle.startContractQuery(7, 3, priceQuery(), PriceOracleReply.SIZE, 1, 1_000, 10n)).toBe(-1n);
    expect(oracle.startContractQuery(7, 0, new Uint8Array(PriceOracleQuery.SIZE - 1), PriceOracleReply.SIZE, 1, 1_000, 10n)).toBe(-1n);
    expect(oracle.startContractQuery(7, 0, priceQuery(), PriceOracleReply.SIZE - 1, 1, 1_000, 10n)).toBe(-1n);
    expect(host.balances.get(7)).toBe(2_000n);

    expect(oracle.startContractQuery(7, 1, new Uint8Array(MockOracleQuery.SIZE), MockOracleReply.SIZE, 1, 1_000, 0n)).toBe(1n);
    expect(oracle.startContractQuery(7, 2, new Uint8Array(DogeShareValidationOracleQuery.SIZE), DogeShareValidationOracleReply.SIZE, 1, 1_000, 99_999n)).toBe(
        2n,
    );
    expect(host.balances.get(7)).toBe(990n);
});

// core's engine sees the timeout, the period and a repeated subscription only once the fee is gone, so those refusals burn and refund it.
test("a request the engine refuses is charged, refunded, then notified", () => {
    const host = fakeHost();
    host.balances.set(5, 50_000n);
    const oracle = new OracleManager(host);
    const query = priceQuery();
    const subscribe = (period: number) =>
        oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 7, period, false, 10_000n);

    expect(oracle.startContractQuery(5, 0, query, PriceOracleReply.SIZE, 7, 3_600_001, 0n)).toBe(-1n);
    expect(host.calls).toEqual(["decrease 10", "refund 10", "notify"]);

    for (const period of [59_000, 60_001, 24 * 60 * 60_000 + 60_000]) {
        host.calls.length = 0;
        expect(subscribe(period)).toBe(-1);
        expect(host.calls).toEqual(["decrease 10000", "refund 10000", "notify"]);
    }

    expect(subscribe(60_000)).toBe(0);
    host.calls.length = 0;
    expect(subscribe(60_000)).toBe(-1);
    expect(host.calls).toEqual(["decrease 10000", "refund 10000", "notify"]);
    expect(host.balances.get(5)).toBe(40_000n);
});

test("a request that never reaches the engine moves no balance", () => {
    const host = fakeHost();
    host.balances.set(5, 9n);
    const oracle = new OracleManager(host);
    const query = priceQuery();

    // cannot pay the 10 QU query fee, cannot pay the subscription fee, and an interface that does not exist.
    expect(oracle.startContractQuery(5, 0, query, PriceOracleReply.SIZE, 7, 1_000, 0n)).toBe(-1n);
    expect(oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 7, 59_000, false, 10_000n)).toBe(-1);
    expect(oracle.startContractQuery(5, 3, query, PriceOracleReply.SIZE, 7, 3_600_001, 0n)).toBe(-1n);
    expect(host.calls).toEqual(["notify", "notify", "notify"]);
    expect(host.balances.get(5)).toBe(9n);
});

test("subscription requires whole minutes and charges only the SUBSCRIBE call", () => {
    const host = fakeHost();
    host.balances.set(5, 20_000n);
    const oracle = new OracleManager(host);
    const query = priceQuery();

    expect(oracle.startContractSubscription(5, 3, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 7, 60_000, false, 10_000n)).toBe(-1);
    expect(
        oracle.startContractSubscription(
            5,
            0,
            new Uint8Array(PriceOracleQuery.SIZE - 1),
            PriceOracleReply.SIZE,
            PriceOracleQuery.OFFSETS.timestamp,
            7,
            60_000,
            false,
            10_000n,
        ),
    ).toBe(-1);
    expect(oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE - 1, PriceOracleQuery.OFFSETS.timestamp, 7, 60_000, false, 10_000n)).toBe(-1);
    expect(host.balances.get(5)).toBe(20_000n);

    const subscriptionId = oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 7, 60_000, false, 10_000n);
    expect(subscriptionId).toBe(0);
    expect(host.balances.get(5)).toBe(10_000n);
    expect(oracle.pending()).toHaveLength(1);
    expect(new DataView(oracle.pending()[0].query.buffer).getBigUint64(PriceOracleQuery.OFFSETS.timestamp, true)).toBe(packDateAndTime(host.clock));

    oracle.setProvider(() => new Uint8Array(PriceOracleReply.SIZE));
    oracle.pump();
    host.clock += 60_000;
    oracle.pump();
    oracle.pump();
    expect(host.balances.get(5)).toBe(10_000n);

    expect(oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 8, 59_000, false, 10_000n)).toBe(-1);
    expect(oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 8, 60_001, false, 10_000n)).toBe(-1);
    expect(host.balances.get(5)).toBe(10_000n);
    expect(oracle.stopContractSubscription(5, subscriptionId)).toBe(1);
});

test("subscribers share a channel, can receive its previous reply, and expire at epoch change", () => {
    const host = fakeHost();
    host.balances.set(5, 1_000n);
    host.balances.set(6, 1_000n);
    const oracle = new OracleManager(host);
    const query = priceQuery(3);

    const first = oracle.startContractSubscription(5, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 11, 60_000, false, 100n);
    expect(oracle.resolve(1n, new Uint8Array(PriceOracleReply.SIZE).fill(7))).toBe(true);
    // the channel remembers a reply once it is revealed, which is the tick after it was committed.
    oracle.pump();
    const second = oracle.startContractSubscription(6, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 12, 120_000, true, 100n);

    expect(second).toBe(first);
    expect(host.balances.get(5)).toBe(900n);
    expect(host.balances.get(6)).toBe(900n);
    const previous = host.notifications.at(-1)!;
    expect(previous.slot).toBe(6);
    expect(previous.input[12]).toBe(ORACLE_STATUS.SUCCESS);
    expect(previous.input.subarray(16)).toEqual(new Uint8Array(PriceOracleReply.SIZE).fill(7));
    expect(oracle.startContractSubscription(6, 0, query, PriceOracleReply.SIZE, PriceOracleQuery.OFFSETS.timestamp, 12, 120_000, false, 100n)).toBe(-1);
    expect(host.balances.get(6)).toBe(900n);

    oracle.beginEpoch();
    expect(oracle.getOracleQueryStatus(1n)).toBe(ORACLE_STATUS.UNKNOWN);
    expect(oracle.stopContractSubscription(5, first)).toBe(0);
});

test("expired queries notify TIMEOUT", () => {
    const host = fakeHost();
    host.balances.set(2, 10n);
    const oracle = new OracleManager(host);
    const queryId = oracle.startContractQuery(2, 0, priceQuery(), PriceOracleReply.SIZE, 3, 1_000, 10n);

    host.clock += 1_000;
    oracle.pump();
    expect(oracle.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.TIMEOUT);
    expect(host.notifications[0].input[12]).toBe(ORACLE_STATUS.TIMEOUT);
});
