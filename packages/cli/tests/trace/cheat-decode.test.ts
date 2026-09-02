// The wire carries only (line, part, bytes); the words and the types live in the IDL. This is where
// the two are put back together into the line a dev actually reads.
import { expect, test } from "bun:test";
import { AbiScalarKind, AbiTypeKind, QINIT_IDL_VERSION, type ContractIdl } from "@qinit/proto/contract-idl";
import type { DebugEntry } from "@qinit/core";
import { describeTrace } from "../../src/trace/format";

const UINT64 = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT64, size: 8, align: 8, format: "uint64" } as const;

const idl: ContractIdl = {
    version: QINIT_IDL_VERSION,
    name: "Cheats",
    slot: 28,
    functions: [],
    procedures: [],
    state: { kind: AbiTypeKind.STRUCT, name: "StateData", fields: [], size: 1, align: 1, format: "" },
    sysprocMask: 0,
    enums: [],
    logs: [],
    cheats: [
        { id: 33, line: 33, parts: [{ lit: "adding" }, { type: UINT64, expr: "input.amount" }] },
        { id: 41, line: 41, parts: [{ lit: "reading total" }] },
    ],
    dependencies: [],
};

function entryWith(cheats: DebugEntry["cheats"]): DebugEntry {
    return {
        seq: 1,
        tick: 1,
        index: 28,
        entry: 1,
        kind: 1,
        ok: true,
        execNs: 0,
        inSize: 0,
        outSize: 0,
        stateSize: 0,
        stateTruncated: false,
        invocator: "00".repeat(32),
        invocationReward: 0,
        inHex: "",
        outHex: "",
        stateDiff: [],
        hostCalls: [],
        logs: [],
        cheats,
    };
}

test("a literal and a value are rejoined into one printed line", async () => {
    const view = await describeTrace(
        entryWith([{ id: (33 << 8) | 1, part: 1, size: 8, value: "0", hex: "0700000000000000" }]),
        undefined,
        "Cheats",
        undefined,
        idl,
    );

    expect(view.cheats).toHaveLength(1);
    expect(view.cheats[0].line).toBe(33);
    expect(view.cheats[0].text).toBe("adding 7");
});

test("an all-literal print still reads back, though it carries no bytes", async () => {
    const view = await describeTrace(entryWith([{ id: 41 << 8, part: 0, size: 0, value: "0", hex: "" }]), undefined, "Cheats", undefined, idl);

    expect(view.cheats[0].text).toBe("reading total");
});

test("a value with no literal in front is labelled with its own source text", async () => {
    const bare: ContractIdl = { ...idl, cheats: [{ id: 33, line: 33, parts: [{ type: UINT64, expr: "input.amount" }] }] };
    const view = await describeTrace(entryWith([{ id: 33 << 8, part: 0, size: 8, value: "0", hex: "0700000000000000" }]), undefined, "Cheats", undefined, bare);

    expect(view.cheats[0].text).toBe("input.amount=7");
});
