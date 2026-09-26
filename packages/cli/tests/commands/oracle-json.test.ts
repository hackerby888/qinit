// `oracle --json` used to print the display rows; it now returns the data behind them.
import { expect, test } from "bun:test";
import { oracleJsonResult, pendingFacts } from "../../src/commands/node/oracle";

const PRICE = 0;

test("pending lists each query with its id as a decimal string and the full query hex", () => {
    const query = new Uint8Array(104);
    query.set([0x6d, 0x6f, 0x63, 0x6b]);
    const result = oracleJsonResult("pending", { pending: pendingFacts([{ queryId: 29781303234560n, slot: 31, interfaceIndex: PRICE, query }]) }, "");

    expect(result).toEqual({
        ok: true,
        action: "pending",
        pending: [{ queryId: "29781303234560", interface: "Price", interfaceIndex: PRICE, slot: 31, query: "6d6f636b" + "00".repeat(100) }],
        resolved: null,
        error: null,
    });
    expect(oracleJsonResult("pending", { pending: pendingFacts([]) }, "").pending).toEqual([]);
});

test("resolve reports the reply it sent, or null when reported unavailable", () => {
    const resolved = { queryId: "6058051375104", interface: "Price", status: "success", reply: "d95e6300000000006400000000000000" };
    expect(oracleJsonResult("resolve", { resolved }, "")).toEqual({ ok: true, action: "resolve", pending: null, resolved, error: null });
    expect(oracleJsonResult("resolve", { resolved: { ...resolved, status: "unavailable", reply: null } }, "").resolved?.reply).toBeNull();
});

test("a failure keeps every key, with the error set", () => {
    expect(oracleJsonResult("resolve", null, "query 1 is not waiting for a reply")).toEqual({
        ok: false,
        action: "resolve",
        pending: null,
        resolved: null,
        error: "query 1 is not waiting for a reply",
    });
});
