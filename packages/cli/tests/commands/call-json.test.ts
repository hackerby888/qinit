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
            {
                label: "abc_map._occupationFlags[167]",
                detail: "abc_map._occupationFlags[167]",
                text: "0 → 1",
                filled: true,
                internal: true,
                before: 0,
                after: 1,
            },
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

// an undecoded log names the structs it could still be, and only then, so the named shape above stays as it is
test("call JSON carries the candidates of a log the decoder could not name", () => {
    const facts = { contract: "Counter", slot: 29, entry: "Inc", tick: 4738, tx: "iugijpcz" };
    const trace = { ...TRACE, view: { ...TRACE.view, logs: [{ severity: "INFO", type: 6, size: 24, candidates: ["OrderLog", "TokensLog"], hex: "0x1d" }] } } as any;
    const result = callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, trace) as any;

    expect(result.logs).toEqual([{ severity: "INFO", type: 6, name: null, candidates: ["OrderLog", "TokensLog"], fields: null, hex: "0x1d" }]);
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

test("call JSON marks a state row written past a BitArray's capacity", () => {
    const facts = { contract: "Counter", slot: 29, entry: "Inc", tick: 1, tx: "abc" };
    const past = {
        label: "flags[20]",
        detail: "flags[20]",
        text: "0 → 1 (past capacity 16)",
        filled: true,
        internal: false,
        before: 0,
        after: 1,
        pastCapacity: 16,
    };
    const trace = { ...TRACE, view: { ...TRACE.view, stateDiff: [TRACE.view.stateDiff[0], past] } };
    const result = callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, trace);

    expect(result.state).toEqual([
        { label: "counter", detail: "counter", text: "15 → 16", internal: false, before: 15n, after: 16n },
        { label: "flags[20]", detail: "flags[20]", text: "0 → 1 (past capacity 16)", internal: false, before: 0, after: 1, pastCapacity: 16 },
    ]);
});

const CALLEE = {
    e: { seq: 3, tick: 4738, index: 28, kind: 1, entry: 1, ok: true, execNs: 1200, hostCalls: [] },
    name: "Counter",
    entry: "proc#1 (Inc)",
    depth: 0,
    view: {
        caller: "PROXYID",
        inDecoded: "{}",
        outDecoded: "{}",
        stateDiff: [{ label: "counter", detail: "counter", text: "0 → 1", filled: true, internal: false, before: 0n, after: 1n }],
        logs: [],
    },
} as any;

test("call JSON lists each callee frame with the state rows of its own slot", () => {
    const facts = { contract: "Proxy", slot: 29, entry: "BumpCounter", tick: 4738, tx: "abc" };
    const trace = { ...TRACE, name: "Proxy", entry: "proc#1 (BumpCounter)", view: { ...TRACE.view, stateDiff: [], logs: [] }, callees: [CALLEE] };
    const result = callJsonResult("proc", "Proxy", "BumpCounter", { ok: true, label: "Proxy.BumpCounter" }, facts, trace);

    // the caller's own rows stay its own; the callee's write shows under the callee.
    expect(result.state).toEqual([]);
    expect(result.callees).toEqual([
        {
            contract: "Counter",
            slot: 28,
            entry: "proc#1 (Inc)",
            kind: "procedure",
            depth: 0,
            ok: true,
            execNs: 1200,
            caller: "PROXYID",
            in: "{}",
            state: [{ label: "counter", detail: "counter", text: "0 → 1", internal: false, before: 0n, after: 1n }],
            logs: [],
        },
    ]);
    expect(Object.keys(callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, TRACE))).not.toContain("callees");
});

test("call JSON names the trap of a callee that failed inside the call", () => {
    const facts = { contract: "Proxy", slot: 29, entry: "BumpCounter", tick: 4738, tx: "abc" };
    const trapped = { ...CALLEE, e: { ...CALLEE.e, ok: false, trap: "abort(3422552174)" } };
    const result = callJsonResult("proc", "Proxy", "BumpCounter", { ok: true, label: "Proxy.BumpCounter" }, facts, { ...TRACE, callees: [trapped] });

    expect(result.callees?.[0]).toMatchObject({ contract: "Counter", ok: false, trap: "abort(3422552174)" });
    // a nested trap recovers in the caller, so the call itself still passes.
    expect(result.ok).toBe(true);
});

// the host row is the only record of a nested call the runtime refused: the frame itself passed and the callee never ran.
test("call JSON names the reason a nested call was refused", () => {
    const facts = { contract: "Sysprobe", slot: 30, entry: "Burn", tick: 1, tx: "abc" };
    const refused = {
        ...TRACE,
        e: {
            ...TRACE.e,
            hostCalls: [
                { name: "invokeProcedure", detail: "→ @4 proc #2 reward=300 ✗ err 4" },
                { name: "burn", detail: "300" },
            ],
        },
    };
    const result = callJsonResult("proc", "Sysprobe", "Burn", { ok: true, label: "Sysprobe.Burn" }, facts, refused);

    expect(result.calls).toEqual([
        {
            name: "invokeProcedure",
            detail: "→ @4 proc #2 reward=300 ✗ err 4",
            error: "contract inactive — not deployed, or its slot is not below the caller's",
        },
        { name: "burn", detail: "300" },
    ]);
});

test("call JSON carries warnings only when there are some", () => {
    const facts = { contract: "Counter", slot: 29, entry: "Inc", tick: 1, tx: "abc" };
    const warned = callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, null, ["⚠ signer X has no balance on this node"]);

    expect(warned.warnings).toEqual(["⚠ signer X has no balance on this node"]);
    expect(Object.keys(callJsonResult("proc", "Counter", "Inc", { ok: true, label: "Counter.Inc" }, facts, null))).not.toContain("warnings");
});
