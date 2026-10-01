// `oracle serve --reply` used to end at the first query its reply could not encode; now that query is reported once and the others are answered.
import { expect, test } from "bun:test";
import { servePending } from "../../src/commands/node/oracle";

const PRICE = 0;
const MOCK = 1;

test("a query the reply does not fit is skipped once, and the others are still answered", async () => {
    const pending = [
        { queryId: 11n, slot: 31, interfaceIndex: PRICE, query: new Uint8Array(104) },
        { queryId: 12n, slot: 31, interfaceIndex: MOCK, query: new Uint8Array(8) },
        { queryId: 13n, slot: 31, interfaceIndex: PRICE, query: new Uint8Array(104) },
    ];
    const resolved: bigint[] = [];
    const rpc = {
        oraclePending: async () => pending,
        oracleResolve: async (queryId: bigint) => {
            resolved.push(queryId);
            return { ok: true };
        },
    } as any;
    const skipped = new Set<bigint>();

    const first = await servePending(rpc, { rules: null, reply: "123456sint64, 1000sint64", replyHex: undefined }, skipped);
    expect(resolved).toEqual([11n, 13n]);
    expect(first[0]).toBe("#11 Price answered");
    expect(first[1]).toStartWith("#12 Mock skipped: ");
    expect(first[2]).toBe("#13 Price answered");

    // the next poll leaves the skipped query alone instead of failing on it again
    const second = await servePending(rpc, { rules: null, reply: "123456sint64, 1000sint64", replyHex: undefined }, skipped);
    expect(second.some((line) => line.startsWith("#12"))).toBe(false);
});

const price = (queryId: bigint) => ({ queryId, slot: 31, interfaceIndex: PRICE, query: new Uint8Array(104) });
const answering = (pending: unknown[], oracleResolve: (queryId: bigint) => Promise<{ ok: boolean }>) => ({ oraclePending: async () => pending, oracleResolve }) as any;

// a request that fails says nothing about the query: it surfaces, and the query is still there for the next run
test("a failed resolve request is not remembered as a skipped query", async () => {
    const skipped = new Set<bigint>();
    const failing = answering([price(11n)], async () => {
        throw new Error("fetch failed");
    });
    await expect(servePending(failing, { rules: null, reply: "123456sint64, 1000sint64", replyHex: undefined }, skipped)).rejects.toThrow("fetch failed");
    expect(skipped.size).toBe(0);
});

test("a query on an interface the registry lacks is skipped by number, and the others are still answered", async () => {
    const resolved: bigint[] = [];
    const rpc = answering([{ queryId: 21n, slot: 31, interfaceIndex: 99, query: new Uint8Array(8) }, price(22n)], async (queryId) => {
        resolved.push(queryId);
        return { ok: true };
    });
    const skipped = new Set<bigint>();

    const lines = await servePending(rpc, { rules: null, reply: "123456sint64, 1000sint64", replyHex: undefined }, skipped);
    expect(lines).toEqual(["#21 interface 99 skipped: unknown oracle interface 99", "#22 Price answered"]);
    expect(resolved).toEqual([22n]);
    // rules name interfaces, so one without a rule is left waiting rather than refused
    expect(await servePending(rpc, { rules: { Mock: "1uint64" }, reply: "", replyHex: undefined }, new Set())).toEqual([]);
});

test("an empty --reply-hex is an answer to encode, as it is for resolve", async () => {
    const skipped = new Set<bigint>();
    const lines = await servePending(answering([price(31n)], async () => ({ ok: true })), { rules: null, reply: "", replyHex: "" }, skipped);
    expect(lines.length).toBe(1);
    expect(lines[0]).toStartWith("#31 Price skipped: ");
    expect(skipped.has(31n)).toBe(true);
});
