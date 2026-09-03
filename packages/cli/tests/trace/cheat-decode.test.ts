// The wire carries only (line, part, bytes); the words and the types live in the IDL. This is where
// the two are put back together into the line a dev actually reads — and where a row the IDL cannot
// explain is shown raw rather than dropped.
import { expect, test } from "bun:test";
import { hashMapGeometry } from "@qinit/proto";
import {
    AbiScalarKind,
    AbiTypeKind,
    QINIT_IDL_VERSION,
    type AbiArray,
    type AbiHashMap,
    type AbiScalar,
    type AbiStruct,
    type ContractIdl,
} from "@qinit/proto/contract-idl";
import { hexToBytes, type DebugEntry } from "@qinit/core";
import type { StateContainer } from "../../src/trace/state-read";
import { describeTrace, type DecodedCheat } from "../../src/trace/format";

const UINT64: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT64, size: 8, align: 8, format: "uint64" };
const SINT32: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.SINT32, size: 4, align: 4, format: "sint32" };
const EMPTY: AbiStruct = { kind: AbiTypeKind.STRUCT, name: "Get_input", fields: [], size: 1, align: 1, format: "" };
const TOTAL: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    name: "StateData",
    fields: [{ name: "total", offset: 0, size: 8, type: UINT64 }],
    size: 8,
    align: 8,
    format: "uint64",
};
const MAP_GEOMETRY = hashMapGeometry({ size: 8, align: 8 }, { size: 8, align: 8 }, 4);
const MAP: AbiHashMap = {
    kind: AbiTypeKind.HASH_MAP,
    key: UINT64,
    value: UINT64,
    capacity: 4,
    size: MAP_GEOMETRY.size,
    align: 8,
    format: "{ [4;{ uint64, uint64 }], [1;uint64], uint64, uint64 }",
};
const WITH_INNER: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    name: "StateData",
    fields: [
        { name: "counter", offset: 0, size: 8, type: UINT64 },
        {
            name: "inner",
            offset: 8,
            size: 8 + MAP_GEOMETRY.size,
            type: {
                kind: AbiTypeKind.STRUCT,
                name: "Inner",
                fields: [
                    { name: "value", offset: 0, size: 8, type: UINT64 },
                    { name: "map", offset: 8, size: MAP_GEOMETRY.size, type: MAP },
                ],
                size: 8 + MAP_GEOMETRY.size,
                align: 8,
                format: "",
            },
        },
    ],
    size: 16 + MAP_GEOMETRY.size,
    align: 8,
    format: "",
};

// One live entry in a HashMap<uint64, uint64, 4>: qpi hashes the key to its slot, so pin the slot the view finds.
function mapBytes(key: number, value: number): Uint8Array {
    const bytes = new Uint8Array(8 + MAP_GEOMETRY.size);
    const view = new DataView(bytes.buffer);
    const slot = 2;

    view.setBigUint64(0, BigInt(key), true);
    view.setBigUint64(8 + slot * MAP_GEOMETRY.recordStride, BigInt(key), true);
    view.setBigUint64(8 + slot * MAP_GEOMETRY.recordStride + MAP_GEOMETRY.valueOffset, BigInt(value), true);
    view.setBigUint64(8 + MAP_GEOMETRY.flagsOffset, 1n << BigInt(slot * 2), true);
    view.setBigUint64(8 + MAP_GEOMETRY.populationOffset, 1n, true);

    return bytes;
}

const NUMS: AbiArray = { kind: AbiTypeKind.ARRAY, element: UINT64, count: 4, size: 32, align: 8, format: "[4;uint64]" };
const MANY: AbiArray = { kind: AbiTypeKind.ARRAY, element: UINT64, count: 40, size: 320, align: 8, format: "[40;uint64]" };
const WITH_NUMS: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    name: "StateData",
    fields: [
        { name: "counter", offset: 0, size: 8, type: UINT64 },
        { name: "nums", offset: 8, size: 32, type: NUMS },
    ],
    size: 40,
    align: 8,
    format: "{ uint64, [4;uint64] }",
};

const idl: ContractIdl = {
    version: QINIT_IDL_VERSION,
    name: "Cheats",
    slot: 28,
    functions: [],
    procedures: [],
    state: TOTAL,
    sysprocMask: 0,
    enums: [],
    logs: [],
    cheats: [
        { id: 33, line: 33, parts: [{ lit: "adding" }, { type: UINT64, expr: "input.amount" }] },
        { id: 41, line: 41, parts: [{ lit: "reading total" }] },
        {
            id: 50,
            line: 50,
            parts: [
                { type: EMPTY, expr: "input" },
                { type: SINT32, expr: "input.neg" },
            ],
        },
        { id: 300, line: 300, parts: [{ lit: "far down" }, { type: UINT64, expr: "input.amount" }] },
    ],
    dependencies: [],
};

// Records carry the line as their id and the argument ordinal as their part: the shape both runtimes emit.
function entryWith(cheats: DebugEntry["cheats"], stateDiff: DebugEntry["stateDiff"] = []): DebugEntry {
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
        stateDiff,
        hostCalls: [],
        logs: [],
        cheats,
    };
}

const SEVEN = "0700000000000000";

test("a literal and a value are rejoined into one printed line", async () => {
    const view = await describeTrace(entryWith([{ id: 33, part: 1, size: 8, value: "0", hex: SEVEN }]), undefined, "Cheats", undefined, idl);

    expect(view.cheats).toHaveLength(1);
    expect(view.cheats[0].line).toBe(33);
    expect(view.cheats[0].text).toBe("adding 7");
});

test("an all-literal print still reads back, though it carries no bytes", async () => {
    const view = await describeTrace(entryWith([{ id: 41, part: 0, size: 0, value: "0", hex: "" }]), undefined, "Cheats", undefined, idl);

    expect(view.cheats[0].text).toBe("reading total");
});

test("a value with no literal in front is labelled with its own source text", async () => {
    const bare: ContractIdl = { ...idl, cheats: [{ id: 33, line: 33, parts: [{ type: UINT64, expr: "input.amount" }] }] };
    const view = await describeTrace(entryWith([{ id: 33, part: 0, size: 8, value: "0", hex: SEVEN }]), undefined, "Cheats", undefined, bare);

    expect(view.cheats[0].text).toBe("input.amount=7");
});

test("a size mismatch prints raw bytes and leaves its siblings readable", async () => {
    const view = await describeTrace(
        entryWith([
            { id: 33, part: 1, size: 1, value: "0", hex: "00" },
            { id: 41, part: 0, size: 0, value: "0", hex: "" },
        ]),
        undefined,
        "Cheats",
        undefined,
        idl,
    );

    expect(view.cheats.map((cheat) => cheat.text)).toEqual(["adding 0x00 (1 bytes, expected 8)", "reading total"]);
});

test("an empty struct prints as {} and a narrow signed field keeps its sign", async () => {
    const view = await describeTrace(
        entryWith([
            { id: 50, part: 0, size: 1, value: "0", hex: "00" },
            { id: 50, part: 1, size: 4, value: "0", hex: "fdffffff" },
        ]),
        undefined,
        "Cheats",
        undefined,
        idl,
    );

    expect(view.cheats[0].text).toBe("input={} input.neg=-3");
});

test("a register-borne scalar decodes through its type, whichever sign the runtime sent", async () => {
    const signed: ContractIdl = {
        ...idl,
        cheats: [
            {
                id: 33,
                line: 33,
                parts: [
                    { type: SINT32, expr: "n" },
                    { type: UINT64, expr: "u" },
                ],
            },
        ],
    };
    const view = await describeTrace(
        entryWith([
            { id: 33, part: 0, size: 0, value: "-3", hex: "" },
            { id: 33, part: 1, size: 0, value: "-1", hex: "" },
        ]),
        undefined,
        "Cheats",
        undefined,
        signed,
    );

    expect(view.cheats[0].text).toBe("n=-3 u=18446744073709551615");
});

test("a record for an unknown site prints raw", async () => {
    const view = await describeTrace(entryWith([{ id: 77, part: 0, size: 2, value: "0", hex: "0102" }]), undefined, "Cheats", undefined, idl);

    expect(view.cheats).toEqual([{ line: 77, text: "0x0102" }]);
});

test("a print past line 255 still finds its site", async () => {
    const view = await describeTrace(entryWith([{ id: 300, part: 1, size: 8, value: "0", hex: SEVEN }]), undefined, "Cheats", undefined, idl);

    expect(view.cheats).toEqual([{ line: 300, text: "far down 7" }]);
});

test("a state diff that fails to decode does not take the cheats with it", async () => {
    const corrupt = [{ off: 0, before: "zz", after: "zz" }];
    const view = await describeTrace(entryWith([{ id: 33, part: 1, size: 8, value: "0", hex: SEVEN }], corrupt), undefined, "Cheats", undefined, idl);

    expect(view.stateDiff).toEqual([]);
    expect(view.cheats[0].text).toBe("adding 7");
});

test("no IDL still lists the raw rows", async () => {
    const view = await describeTrace(entryWith([{ id: 33, part: 1, size: 8, value: "0", hex: SEVEN }]), undefined, "Cheats");

    expect(view.cheats).toEqual([{ line: 33, text: "0x" + SEVEN }]);
});

// Little-endian uint64s below 256, as the hex a record carries.
const words = (...values: number[]) => values.map((value) => value.toString(16).padStart(2, "0") + "00".repeat(7)).join("");

const siteOf = (parts: ContractIdl["cheats"][number]["parts"]): ContractIdl => ({ ...idl, cheats: [{ id: 60, line: 60, parts }] });
// The rows of one block in their flat form, the way `qinit state` reads on screen.
const flat = (container: StateContainer | undefined) => container?.lines.map((line) => `${line.label} ${line.text}`.trim());
const blockNames = (cheat: DecodedCheat) => cheat.blocks?.containers.map((container) => container.name);
const scalars = (cheat: DecodedCheat) => cheat.blocks?.fields.map((field) => `${field.name} ${field.value}`);

test("a struct holding a container prints as the blocks qinit state draws", async () => {
    const site = siteOf([{ type: WITH_NUMS, expr: "state.get()" }]);
    const view = await describeTrace(entryWith([{ id: 60, part: 0, size: 40, value: "0", hex: words(7, 0, 0, 0, 9) }]), undefined, "Cheats", undefined, site);
    const [nums] = view.cheats[0].blocks!.containers;

    expect(view.cheats[0].text).toBe("state.get()");
    expect(scalars(view.cheats[0])).toEqual(["counter 7"]);
    expect(nums.name).toBe("nums");
    expect(flat(nums)).toEqual(["[0..2] =0 ×3 (skipped)", "[3] 9"]);
    expect(nums.lines.map((line) => line.filled)).toEqual([false, true]);
    // Counts drive the block's header, and nothing here can be loaded separately.
    expect([nums.index, nums.capacity, nums.occupiedSlots, nums.totalEntries]).toEqual([0, 4, 1, 1]);
});

test("a container nested under a struct field gets its own named block", async () => {
    const site = siteOf([{ type: WITH_INNER, expr: "state.get()" }]);
    const bytes = new Uint8Array(WITH_INNER.size);
    bytes.set(hexToBytes(words(4)), 0);
    bytes.set(mapBytes(5, 6), 8);
    const view = await describeTrace(
        entryWith([{ id: 60, part: 0, size: bytes.length, value: "0", hex: Buffer.from(bytes).toString("hex") }]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(scalars(view.cheats[0])).toEqual(["counter 4", "inner.value 5"]);
    expect(blockNames(view.cheats[0])).toEqual(["inner.map"]);
    expect(flat(view.cheats[0].blocks!.containers[0])).toEqual(["slots[0..1] (unoccupied ×2; skipped)", "slot[2] 5 = 6", "slot[3] (unoccupied ×1; skipped)"]);
});

test("a literal in front of a block is its head", async () => {
    const site = siteOf([{ lit: "state is" }, { type: WITH_NUMS, expr: "state.get()" }]);
    const view = await describeTrace(entryWith([{ id: 60, part: 1, size: 40, value: "0", hex: words(0, 0, 0, 0, 0) }]), undefined, "Cheats", undefined, site);

    expect(view.cheats[0].text).toBe("state is");
    expect(scalars(view.cheats[0])).toEqual(["counter 0"]);
    expect(flat(view.cheats[0].blocks!.containers[0])).toEqual(["[0..3] =0 ×4 (skipped)"]);
});

test("a bare container prints as one unnamed block", async () => {
    const site = siteOf([{ type: NUMS, expr: "state.get().nums" }]);
    const view = await describeTrace(entryWith([{ id: 60, part: 0, size: 32, value: "0", hex: words(0, 0, 0, 0) }]), undefined, "Cheats", undefined, site);

    expect(view.cheats[0].text).toBe("state.get().nums");
    expect(view.cheats[0].blocks!.fields).toEqual([]);
    expect(blockNames(view.cheats[0])).toEqual([""]);
    expect(flat(view.cheats[0].blocks!.containers[0])).toEqual(["[0..3] =0 ×4 (skipped)"]);
});

// A block per element would bury the container it lives in, so a struct below a container stays inline.
test("a container inside a container's element stays inline JSON", async () => {
    const elements: AbiArray = { kind: AbiTypeKind.ARRAY, element: WITH_NUMS, count: 2, size: 80, align: 8, format: "[2;{ uint64, [4;uint64] }]" };
    const site = siteOf([{ type: elements, expr: "state.get().rows" }]);
    const view = await describeTrace(
        entryWith([{ id: 60, part: 0, size: 80, value: "0", hex: words(...new Array(10).fill(0)) }]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(blockNames(view.cheats[0])).toEqual([""]);
    expect(flat(view.cheats[0].blocks!.containers[0])).toEqual(["[0..1] =0 ×2 (skipped)"]);
});

test("a container beside other values stays inline", async () => {
    const site = siteOf([
        { type: NUMS, expr: "state.get().nums" },
        { type: UINT64, expr: "x" },
    ]);
    const view = await describeTrace(
        entryWith([
            { id: 60, part: 0, size: 32, value: "0", hex: words(0, 0, 0, 0) },
            { id: 60, part: 1, size: 8, value: "0", hex: words(7) },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(view.cheats[0]).toEqual({ line: 60, text: "state.get().nums=[0, 0, 0, 0] x=7" });
});

// Short bytes cannot decode; long bytes could, from a prefix, and that would show a block of the wrong thing.
test("a container-bearing value at the wrong size prints raw, not as a block", async () => {
    const site = siteOf([{ type: WITH_NUMS, expr: "state.get()" }]);
    const short = await describeTrace(entryWith([{ id: 60, part: 0, size: 4, value: "0", hex: "01020304" }]), undefined, "Cheats", undefined, site);
    const long = await describeTrace(
        entryWith([{ id: 60, part: 0, size: 48, value: "0", hex: words(7, 0, 0, 0, 9, 1) }]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(short.cheats[0]).toEqual({ line: 60, text: "state.get()=0x01020304 (4 bytes, expected 40)" });
    expect(long.cheats[0]).toEqual({ line: 60, text: `state.get()=0x${words(7, 0, 0, 0, 9, 1)} (48 bytes, expected 40)` });
});

test("an inline value is never capped", async () => {
    const site = siteOf([{ lit: "all" }, { type: MANY, expr: "nums" }, { type: UINT64, expr: "n" }]);
    const view = await describeTrace(
        entryWith([
            { id: 60, part: 1, size: 320, value: "0", hex: words(...Array.from({ length: 40 }, (_, index) => index)) },
            { id: 60, part: 2, size: 8, value: "0", hex: words(7) },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(view.cheats[0].text).not.toContain("--all");
    expect(view.cheats[0].text).toEndWith(", 38, 39] n=7");
});

// The container view refuses bytes that contradict themselves, and a refusal must stay inside the row.
test("a block whose bytes do not add up prints raw and keeps its siblings", async () => {
    const geometry = hashMapGeometry(UINT64, UINT64, 4);
    const map: AbiHashMap = { kind: AbiTypeKind.HASH_MAP, key: UINT64, value: UINT64, capacity: 4, size: geometry.size, align: 8, format: "" };
    const bytes = new Uint8Array(geometry.size);
    bytes[geometry.populationOffset] = 99;
    const hex = Buffer.from(bytes).toString("hex");
    const site: ContractIdl = {
        ...idl,
        cheats: [
            { id: 60, line: 60, parts: [{ type: map, expr: "state.get().m" }] },
            { id: 61, line: 61, parts: [{ lit: "after" }] },
        ],
    };
    const view = await describeTrace(
        entryWith([
            { id: 60, part: 0, size: geometry.size, value: "0", hex },
            { id: 61, part: 0, size: 0, value: "0", hex: "" },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(view.cheats).toEqual([
        { line: 60, text: `state.get().m=0x${hex} (${geometry.size} bytes, undecodable)` },
        { line: 61, text: "after" },
    ]);
});
