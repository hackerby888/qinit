import { expect, test } from "bun:test";
import { bigintText, callJsonResult, overlayArgs } from "../../src/commands/deploy-interact/call";
import { parseArgs } from "../../src/args";

const TRACE = {
    e: { tick: 4738, execNs: 521030 },
    name: "Counter",
    entry: "proc#1 (Inc)",
    view: {
        caller: "BZBQFLL",
        inDecoded: "{}",
        outDecoded: "{}",
        stateDiff: [
            { label: "counter", detail: "counter", text: "15 → 16", filled: true, internal: false, before: 15n, after: 16n },
            { label: "abc_map._occupationFlags[167]", detail: "abc_map._occupationFlags[167]", text: "0 → 1", filled: true, internal: true, before: 0, after: 1 },
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
        address: null,
        balance: null,
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
            { label: "counter", detail: "counter", text: "15 → 16", internal: false, before: 15n, after: 16n },
            { label: "abc_map._occupationFlags[167]", detail: "abc_map._occupationFlags[167]", text: "0 → 1", internal: true, before: 0, after: 1 },
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
        address: null,
        balance: null,
        entry: "Get",
        kind: "function",
        tick: null,
        tx: null,
        out: null,
        error: "no contract 'Counter'",
    });
    expect(Object.keys(result)).not.toContain("state");
});

test("wizard answers override the typed flags and mask the ones its prompts replaced", () => {
    const base = parseArgs(["--fn", "Counter", "Get", "--args", '{"a":1}', "--out", "uint32", "--trace", "--rpc", "http://node"], {
        strings: ["args", "in", "out", "amount", "rpc"],
        booleans: ["fn", "trace"],
    });
    const merged = overlayArgs(base, ["Counter", "Inc"], { args: undefined, in: "5uint64", out: undefined, amount: "10" });

    expect(merged.positionals).toEqual(["Counter", "Inc"]);
    expect(merged.get("in")).toBe("5uint64");
    expect(merged.get("amount")).toBe("10");
    // A prompt the wizard skipped masks the flag rather than letting it through.
    expect(merged.has("args")).toBe(false);
    expect(merged.get("out")).toBeUndefined();
    // Anything the wizard never asks about still comes from the original invocation.
    expect(merged.has("trace")).toBe(true);
    expect(merged.get("rpc")).toBe("http://node");
});

test("call JSON fails a call whose traced frame trapped and names the trap", () => {
    const trapped = { ...TRACE, e: { ...TRACE.e, ok: false, trap: "abort(3422552174)" } };
    const facts = { contract: "Probe", slot: 30, entry: "Assert", tick: 3111, tx: "abc" };
    const result = callJsonResult("proc", "Probe", "Assert", { ok: true, label: "Probe.Assert" }, facts, trapped);

    expect(result.ok).toBe(false);
    expect(result.trap).toBe("abort(3422552174)");
    // A healthy frame carries no trap key, so a consumer can tell "no trap" from "unknown".
    expect(Object.keys(callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, null, TRACE))).not.toContain("trap");
});

test("call JSON carries warnings only when there are some", () => {
    const facts = { contract: "Counter", slot: 29, entry: "Inc", tick: 1, tx: "abc" };
    const warned = callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, null, ["⚠ signer X has no balance on this node"]);

    expect(warned.warnings).toEqual(["⚠ signer X has no balance on this node"]);
    expect(Object.keys(callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, null))).not.toContain("warnings");
});
