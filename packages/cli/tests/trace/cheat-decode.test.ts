// The wire carries only (line, part, bytes); the words and the types live in the IDL. This is where
// the two are put back together into the line a dev actually reads — and where a row the IDL cannot
// explain is shown raw rather than dropped.
import { expect, test } from "bun:test";
import { collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "@qinit/proto";
import {
    AbiScalarKind,
    AbiTypeKind,
    QINIT_IDL_VERSION,
    type AbiArray,
    type AbiCollection,
    type AbiHashMap,
    type AbiHashSet,
    type AbiLinkedList,
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
    // The fields stand on their own, so the state does not read as absent.
    expect(view.fields.map((field) => field.name)).toEqual(["total"]);
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

// A print that runs more than once — in a loop — shows once per run. The records of one run sit
// together, so a repeated part ordinal is where the next run starts, whatever order parts arrive in.
const LOOP = siteOf([{ lit: "i =" }, { type: UINT64, expr: "locals.i" }, { lit: "squared" }, { type: UINT64, expr: "locals.i * locals.i" }]);
const run = (i: number) => [
    { id: 60, part: 1, size: 8, value: "0", hex: words(i) },
    { id: 60, part: 3, size: 0, value: String(i * i), hex: "" },
];

test("a print inside a loop keeps every iteration in order", async () => {
    const view = await describeTrace(entryWith([...run(0), ...run(1), ...run(2)]), undefined, "Cheats", undefined, LOOP);

    expect(view.cheats.map((cheat) => [cheat.line, cheat.text])).toEqual([
        [60, "i = 0 squared 0"],
        [60, "i = 1 squared 1"],
        [60, "i = 2 squared 4"],
    ]);
});

test("parts arriving out of order still make one line", async () => {
    const [first, second] = run(3);
    const view = await describeTrace(entryWith([second, first]), undefined, "Cheats", undefined, LOOP);

    expect(view.cheats.map((cheat) => cheat.text)).toEqual(["i = 3 squared 9"]);
});

test("a missing part leaves a gap rather than an invented value", async () => {
    const view = await describeTrace(entryWith([run(4)[1]]), undefined, "Cheats", undefined, LOOP);

    expect(view.cheats.map((cheat) => cheat.text)).toEqual(["i = squared 16"]);
});

test("two prints of one line with an unknown site are two raw lines", async () => {
    const view = await describeTrace(entryWith([...run(1), ...run(2)].map((record) => ({ ...record, id: 77 }))), undefined, "Cheats", undefined, idl);

    expect(view.cheats.map((cheat) => cheat.text)).toEqual(["0x" + words(1) + " 1", "0x" + words(2) + " 4"]);
});

const BIT: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.BIT, size: 1, align: 1, format: "bit" };
const SINT64: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.SINT64, size: 8, align: 8, format: "sint64" };
const ID: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.ID, size: 32, align: 8, format: "id" };

test("a bit and a signed priority in the register print by their own type, whichever runtime sent them", async () => {
    const site = siteOf([
        { type: BIT, expr: "bits.get(3)" },
        { type: SINT64, expr: "orders.priority(i)" },
    ]);
    const engine = entryWith([
        { id: 60, part: 0, size: 0, value: "1", hex: "" },
        { id: 60, part: 1, size: 0, value: "-100", hex: "" },
    ]);
    const core = entryWith([
        { id: 60, part: 0, size: 0, value: "1", hex: "" },
        { id: 60, part: 1, size: 0, value: "18446744073709551516", hex: "" },
    ]);

    expect((await describeTrace(engine, undefined, "Cheats", undefined, site)).cheats[0].text).toBe("bits.get(3)=1 orders.priority(i)=-100");
    expect((await describeTrace(core, undefined, "Cheats", undefined, site)).cheats[0].text).toBe("bits.get(3)=1 orders.priority(i)=-100");
});

// { uint8 tag; uint64 wide; uint16 half; id who; bit flag; sint8 tiny; } — padding after tag, half and tiny.
const PACKED: AbiStruct = {
    kind: AbiTypeKind.STRUCT,
    name: "Packed",
    fields: [
        { name: "tag", offset: 0, size: 1, type: { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT8, size: 1, align: 1, format: "uint8" } },
        { name: "wide", offset: 8, size: 8, type: UINT64 },
        { name: "half", offset: 16, size: 2, type: { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT16, size: 2, align: 2, format: "uint16" } },
        { name: "who", offset: 24, size: 32, type: ID },
        { name: "flag", offset: 56, size: 1, type: BIT },
        { name: "tiny", offset: 57, size: 1, type: { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.SINT8, size: 1, align: 1, format: "sint8" } },
    ],
    size: 64,
    align: 8,
    format: "{ uint8, uint64, uint16, id, bit, sint8 }",
};

test("a padded struct with sub-word, signed and id members prints every member, an id bare only on its own", async () => {
    const bytes = new Uint8Array(64);
    bytes[0] = 7;
    bytes.set(hexToBytes(words(11)), 8);
    bytes[16] = 1;
    bytes[17] = 2;
    bytes[24] = 3;
    bytes[56] = 1;
    bytes[57] = 0xfb;
    const who = "DAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAANMIG";
    const site = siteOf([{ type: PACKED, expr: "input.packed" }, { lit: "who" }, { type: ID, expr: "input.packed.who" }]);
    const view = await describeTrace(
        entryWith([
            { id: 60, part: 0, size: 64, value: "0", hex: Buffer.from(bytes).toString("hex") },
            { id: 60, part: 2, size: 32, value: "0", hex: Buffer.from(bytes.subarray(24, 56)).toString("hex") },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(view.cheats[0].text).toBe(`input.packed={tag: 7, wide: 11, half: 513, who: "${who}", flag: 1, tiny: -5} who ${who}`);
});

test("an array of arrays prints inline with every element in place", async () => {
    const U16: AbiScalar = { kind: AbiTypeKind.SCALAR, scalar: AbiScalarKind.UINT16, size: 2, align: 2, format: "uint16" };
    const ROW: AbiArray = { kind: AbiTypeKind.ARRAY, element: U16, count: 4, size: 8, align: 2, format: "[4;uint16]" };
    const GRID: AbiArray = { kind: AbiTypeKind.ARRAY, element: ROW, count: 2, size: 16, align: 2, format: "[2;[4;uint16]]" };
    const bytes = new Uint8Array(16);
    bytes[12] = 9;
    const site = siteOf([{ lit: "grid" }, { type: GRID, expr: "state.get().grid" }, { lit: "n" }, { type: UINT64, expr: "n" }]);
    const view = await describeTrace(
        entryWith([
            { id: 60, part: 1, size: 16, value: "0", hex: Buffer.from(bytes).toString("hex") },
            { id: 60, part: 3, size: 8, value: "0", hex: words(1) },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(view.cheats[0].text).toBe("grid [[0, 0, 0, 0], [0, 0, 9, 0]] n 1");
});

const U64_LAYOUT = { size: 8, align: 8 };
const ZERO_ID = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFXIB";

test("a Collection prints its PoV rows highest priority first, and a LinkedList its items from the head", async () => {
    const collection = collectionGeometry(U64_LAYOUT, 4);
    const COLLECTION: AbiCollection = { kind: AbiTypeKind.COLLECTION, value: UINT64, capacity: 4, size: collection.size, align: 8, format: "" };
    const bytes = new Uint8Array(collection.size);
    const view = new DataView(bytes.buffer);
    // One PoV (the zero id) in slot 0 holding elements 0 (priority 10) and 1 (priority -3), 1 to the right of 0.
    view.setBigUint64(collection.povPopulationOffset, 2n, true);
    view.setBigInt64(collection.povHeadOffset, 0n, true);
    view.setBigInt64(collection.povTailOffset, 1n, true);
    view.setBigInt64(collection.povBstRootOffset, 0n, true);
    view.setBigUint64(collection.flagsOffset, 1n, true);
    for (const [index, value, priority, parent, right] of [
        [0, 5n, 10n, -1n, 1n],
        [1, 6n, -3n, 0n, -1n],
    ] as const) {
        const at = collection.elementsOffset + index * collection.elementStride;
        view.setBigUint64(at, value, true);
        view.setBigInt64(at + collection.elementPriorityOffset, priority, true);
        view.setBigInt64(at + collection.elementPovIndexOffset, 0n, true);
        view.setBigInt64(at + collection.elementBstParentOffset, parent, true);
        view.setBigInt64(at + collection.elementBstLeftOffset, -1n, true);
        view.setBigInt64(at + collection.elementBstRightOffset, right, true);
    }
    view.setBigUint64(collection.populationOffset, 2n, true);

    const list = linkedListGeometry(U64_LAYOUT, 4);
    const LIST: AbiLinkedList = { kind: AbiTypeKind.LINKED_LIST, value: UINT64, capacity: 4, size: list.size, align: 8, format: "" };
    const listBytes = new Uint8Array(list.size);
    const listView = new DataView(listBytes.buffer);
    // Node 2 is the head and points at node 0, the tail.
    for (const [slot, value, next, previous] of [
        [0, 8n, -1n, 2n],
        [2, 9n, 0n, -1n],
    ] as const) {
        listView.setBigUint64(slot * list.nodeStride, value, true);
        listView.setBigInt64(slot * list.nodeStride + list.nextOffset, next, true);
        listView.setBigInt64(slot * list.nodeStride + list.prevOffset, previous, true);
    }
    listView.setBigUint64(list.flagsOffset, 0b101n, true);
    listView.setBigInt64(list.headOffset, 2n, true);
    listView.setBigInt64(list.tailOffset, 0n, true);
    listView.setBigInt64(list.freeHeadOffset, -1n, true);
    listView.setBigUint64(list.nextUnusedOffset, 3n, true);
    listView.setBigUint64(list.populationOffset, 2n, true);

    const site: ContractIdl = {
        ...idl,
        cheats: [
            { id: 60, line: 60, parts: [{ type: COLLECTION, expr: "state.get().orders" }] },
            { id: 61, line: 61, parts: [{ type: LIST, expr: "state.get().list" }] },
        ],
    };
    const rendered = await describeTrace(
        entryWith([
            { id: 60, part: 0, size: bytes.length, value: "0", hex: Buffer.from(bytes).toString("hex") },
            { id: 61, part: 0, size: listBytes.length, value: "0", hex: Buffer.from(listBytes).toString("hex") },
        ]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(flat(rendered.cheats[0].blocks!.containers[0])).toEqual([
        `PoV[0] ${ZERO_ID}: 5 (p10)`,
        `PoV[0] ${ZERO_ID}: 6 (p-3)`,
        "PoV slots[1..3] (unoccupied ×3; skipped)",
    ]);
    expect(rendered.cheats[0].blocks!.containers[0].totalEntries).toBe(2);
    expect(flat(rendered.cheats[1].blocks!.containers[0])).toEqual([
        "item[0] slot[2] = 9",
        "item[1] slot[0] = 8",
        "slot[1] (unoccupied ×1; skipped)",
        "slot[3] (unoccupied ×1; skipped)",
    ]);
});

test("a HashSet prints its keys by slot", async () => {
    const set = hashSetGeometry(U64_LAYOUT, 4);
    const SET: AbiHashSet = { kind: AbiTypeKind.HASH_SET, key: UINT64, capacity: 4, size: set.size, align: 8, format: "" };
    const bytes = new Uint8Array(set.size);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(3 * set.recordStride, 42n, true);
    view.setBigUint64(set.flagsOffset, 1n << 6n, true);
    view.setBigUint64(set.populationOffset, 1n, true);
    const site = siteOf([{ type: SET, expr: "state.get().set" }]);
    const rendered = await describeTrace(
        entryWith([{ id: 60, part: 0, size: bytes.length, value: "0", hex: Buffer.from(bytes).toString("hex") }]),
        undefined,
        "Cheats",
        undefined,
        site,
    );

    expect(flat(rendered.cheats[0].blocks!.containers[0])).toEqual(["slots[0..2] (unoccupied ×3; skipped)", "slot[3] 42"]);
});
