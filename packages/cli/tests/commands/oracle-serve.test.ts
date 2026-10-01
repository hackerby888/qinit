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
