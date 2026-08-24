import { expect, test } from "bun:test";
import { bigintText, callJsonResult } from "../../src/commands/deploy-interact/call";

const TRACE = {
    e: { tick: 4738, execNs: 521030 },
    name: "Counter",
    entry: "proc#1 (Inc)",
    view: {
        caller: "BZBQFLL",
        inDecoded: "{}",
        outDecoded: "{}",
        stateDiff: [
            { label: "counter", detail: "counter", text: "15 → 16", filled: true, internal: false },
            { label: "abc_map._occupationFlags[167]", detail: "abc_map._occupationFlags[167]", text: "0 → 1", filled: true, internal: true },
        ],
        logs: [{ severity: "INFO", type: 6, name: "Log1", fields: { _scindex: 29, counter: 16n }, hex: "0x1d" }],
    },
} as any;

test("call JSON reports a traced procedure with its state rows and logs", () => {
    const facts = { contract: "Counter", slot: 29, entry: "Inc", tick: 4738, tx: "iugijpcz" };
    const result = callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, TRACE);

    expect(result).toEqual({
        ok: true,
        contract: "Counter",
        slot: 29,
        entry: "Inc",
        kind: "procedure",
        tick: 4738,
        tx: "iugijpcz",
        out: "{}",
        error: null,
        execNs: 521030,
        caller: "BZBQFLL",
        in: "{}",
        state: [
            { label: "counter", detail: "counter", text: "15 → 16", internal: false },
            { label: "abc_map._occupationFlags[167]", detail: "abc_map._occupationFlags[167]", text: "0 → 1", internal: true },
        ],
        logs: [{ severity: "INFO", type: 6, name: "Log1", fields: { _scindex: 29, counter: 16n }, hex: "0x1d" }],
    });

    // A uint64 decodes to a bigint, which JSON.stringify refuses without the replacer.
    expect(JSON.stringify(result, bigintText)).toContain('"counter":"16"');
});

test("call JSON without a trace omits the trace keys and falls back to the requested names", () => {
    const result = callJsonResult("fn", "Counter", "Get", { ok: false, label: "call", err: "no contract 'Counter'" }, null, null);

    expect(result).toEqual({
        ok: false,
        contract: "Counter",
        slot: null,
        entry: "Get",
        kind: "function",
        tick: null,
        tx: null,
        out: null,
        error: "no contract 'Counter'",
    });
    expect(Object.keys(result)).not.toContain("state");
});
