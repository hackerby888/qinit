import { test, expect } from "bun:test";
import { AbiScalarKind, AbiTypeKind, type AbiType } from "@qinit/proto/contract-idl";
import {
    describeTrace,
    keyLabel,
    LARGE_STATE_CONTAINER_BYTES,
    loadStateContainer,
    readState,
    type StateReader,
    type StateContainer,
} from "../../src/trace/format";

// A block's rows in the one-line form, for assertions where the label/text split adds nothing.
const flatLines = (container: StateContainer) =>
    container.lines.map((line) => `${line.label} ${line.text}`);

// LE bytes / hex helpers
const le = (n: bigint | number, w: number) => {
    let v = BigInt.asUintN(64, BigInt(n));
    const b: number[] = [];
    for (let i = 0; i < w; i++) {
        b.push(Number(v & 0xffn));
        v >>= 8n;
    }
    return b;
};
const hx = (b: number[]) => b.map((x) => (x & 0xff).toString(16).padStart(2, "0")).join("");
// HashMap<id,uint64,4> with slot0 -> value (key = all-zero id): element stride 40, value@32, flags@160
const hashmapBuf = (value: number) => {
    const buf = new Array(184).fill(0);
    le(value, 8).forEach((x, i) => (buf[32 + i] = x));
    buf[160] = 1;
    le(1, 8).forEach((x, i) => (buf[168 + i] = x));
    return buf;
};

const SRC = `
using namespace QPI;
enum Kind { Started = 0, Bumped = 1 };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; HashMap<id, uint64, 4> bal; };
  struct LogMsg { uint32 _contractIndex; uint32 _type; uint64 value; sint8 _terminator; };
  struct Inc_input { uint64 by; }; struct Inc_output {};
  PUBLIC_PROCEDURE(Inc) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Inc, 1); }
  INITIALIZE() {}
};`;

type StateReadCall = { slot: number; off: number; len: number };

// Range-aware state image: callers receive exactly the requested bytes or a short read.
const fakeRpc = (state: Uint8Array | number[], calls: StateReadCall[] = []): StateReader => {
    const bytes = Uint8Array.from(state);
    return {
        stateRead: async (slot, off, len) => {
            calls.push({ slot, off, len });
            return { hex: hx(Array.from(bytes.subarray(off, off + len))) };
        },
    };
};

test("describeTrace: decodes proc input, caller, log enum, and captured state diff", async () => {
    const before = new Array(184).fill(0);
    const after = hashmapBuf(42);
    const entry: any = {
        seq: 1,
        tick: 10,
        index: 7,
        entry: 1,
        kind: 1,
        ok: true,
        execNs: 1000,
        invocator: "11".repeat(32),
        invocationReward: 0,
        inHex: hx(le(5, 8)), // by = 5
        outHex: "",
        stateDiff: [{ off: 8, before: hx(before), after: hx(after) }],
        hostCalls: [],
        logs: [{ type: 6, size: 16, hex: hx([...le(0, 4), ...le(1, 4), ...le(9, 8)]) }], // _type=1, value=9
    };
    const v = await describeTrace(entry, SRC, "Counter");
    expect(v.inDecoded).toBe("5"); // single-field input -> its bare scalar
    expect(v.caller.length).toBe(60); // proc -> 60-char identity
    expect(v.logs).toHaveLength(1);
    expect(v.logs[0].typeName).toBe("Bumped"); // enum Kind: 1 -> Bumped
    expect(v.logs[0].fields).toEqual({ _contractIndex: 0, _type: 1, value: 9n });
    expect(v.stateDiff.map(({ label, text, internal }) => ({ label, text, internal }))).toEqual([
        { label: "bal.slot[0].value", text: "0 → 42", internal: false },
        {
            label: "bal._occupationFlags[0]",
            text: "0 → 1",
            internal: true,
        },
        { label: "bal", text: "0 → 1 entries", internal: false },
    ]);
});

test("describeTrace: no source -> raw hex passthrough, no decode", async () => {
    const entry: any = {
        seq: 2,
        tick: 1,
        index: 0,
        entry: 1,
        kind: 0,
        ok: true,
        execNs: 0,
        invocator: "0".repeat(64),
        invocationReward: 0,
        inHex: "abcd",
        outHex: "",
        stateDiff: [],
        hostCalls: [],
        logs: [],
    };
    const v = await describeTrace(entry, undefined, "X");
    expect(v.inDecoded).toBe("0xabcd");
    expect(v.caller).toBe("(none)");
});

test("readState: scalar fields decoded + container entries", async () => {
    const state = await readState(fakeRpc([...le(7, 8), ...hashmapBuf(42)]), 7, SRC, "Counter");
    expect(state.fields).toEqual([{ name: "counter", value: "7" }]); // bal is a container -> not a scalar
    expect(state.complete).toBe(true);
    expect(state.containers).toHaveLength(1);
    expect(state.containers[0].name).toBe("bal");
    expect(state.containers[0].lines[0].text).toContain("42");
});

test("readState: rejects a short field-scoped RPC read", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { uint64 value; }; INITIALIZE() {} };`;
    const state = await readState(fakeRpc(new Uint8Array(4)), 7, source, "ShortRead");

    expect(state.complete).toBe(false);
    expect(state.fields).toEqual([
        {
            name: "value",
            value: "(read failed: short state read at 0: expected 8 bytes, got 4)",
        },
    ]);
});

test("readState: reads a complete sparse array across the 4 MiB boundary", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData { SlowAnySizeArray<uint64, 524289> values; };
      INITIALIZE() {}
    };
  `;
    const bytes = new Uint8Array(524289 * 8);
    bytes.set(le(7, 8), 8);
    bytes.set(le(9, 8), 524288 * 8);
    const calls: StateReadCall[] = [];
    const progress: [string, number, number][] = [];

    const state = await readState(
        fakeRpc(bytes, calls),
        7,
        source,
        "Big",
        undefined,
        (field, completed, total) => progress.push([field, completed, total]),
    );

    expect(state.fields).toEqual([]); // an Array is a block of its own, not a scalar row
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "array",
            index: 1,
            size: 4194312,
            status: "loaded",
            capacity: 524289,
            occupiedSlots: 2,
            totalEntries: 2,
            lines: [
                { label: "[0]", text: "=0 (skipped)", filled: false },
                { label: "[1]", text: "7", filled: true },
                { label: "[2..524287]", text: "=0 ×524286 (skipped)", filled: false },
                { label: "[524288]", text: "9", filled: true },
            ],
        },
    ]);
    expect(state.complete).toBe(true);
    expect(calls).toEqual([
        { slot: 7, off: 0, len: 4194304 },
        { slot: 7, off: 4194304, len: 8 },
    ]);
    expect(progress).toEqual([
        ["values", 0, 4194312],
        ["values", 4194304, 4194312],
        ["values", 4194312, 4194312],
    ]);
});

test("readState: preserves an empty array as an empty block without an RPC read", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { uint64 values[0]; }; INITIALIZE() {} };`;
    const calls: StateReadCall[] = [];
    const state = await readState(fakeRpc([], calls), 7, source, "EmptyArray");

    expect(calls).toEqual([]);
    expect(state.fields).toEqual([]);
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "array",
            capacity: 0,
            occupiedSlots: 0,
            totalEntries: 0,
            lines: [],
        },
    ]);
    expect(state.complete).toBe(true);
});

test("readState: collapses a 10 MiB container without reading it", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData {
        SlowAnySizeArray<uint8, ${LARGE_STATE_CONTAINER_BYTES}> values;
      };
      INITIALIZE() {}
    };
  `;
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc([], calls), 7, source, "Huge", undefined, undefined, {
        collapseContainersAtBytes: LARGE_STATE_CONTAINER_BYTES,
    });

    expect(calls).toEqual([]);
    expect(state.complete).toBe(true);
    expect(state.containers[0]).toMatchObject({
        index: 1,
        name: "values",
        kind: "array",
        size: LARGE_STATE_CONTAINER_BYTES,
        status: "collapsed",
        lines: [],
    });
});

test("readState: direct container indexes follow declaration order", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData {
        BitArray<64> flags;
        HashMap<uint64, uint64, 4> values;
        Array<uint64, 4> recent;
        HashSet<uint64, 4> seen;
        Collection<uint64, 4> queue;
        LinkedList<uint64, 4> list;
      };
      INITIALIZE() {}
    };
  `;
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc([], calls), 7, source, "Indexed", undefined, undefined, {
        collapseContainersAtBytes: 1,
    });

    expect(calls).toEqual([]);
    expect(
        state.containers.map(({ index, name, kind, status }) => ({
            index,
            name,
            kind,
            status,
        })),
    ).toEqual([
        { index: 1, name: "flags", kind: "bitarray", status: "collapsed" },
        { index: 2, name: "values", kind: "hashmap", status: "collapsed" },
        { index: 3, name: "recent", kind: "array", status: "collapsed" },
        { index: 4, name: "seen", kind: "hashset", status: "collapsed" },
        { index: 5, name: "queue", kind: "collection", status: "collapsed" },
        { index: 6, name: "list", kind: "linkedlist", status: "collapsed" },
    ]);
});

test("readState: an explicitly selected large container is loaded", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData { Array<uint64, 4> values; };
      INITIALIZE() {}
    };
  `;
    const bytes = new Uint8Array(32);
    bytes.set(le(9, 8), 16);
    const calls: StateReadCall[] = [];

    const state = await readState(
        fakeRpc(bytes, calls),
        7,
        source,
        "Selected",
        undefined,
        undefined,
        {
            collapseContainersAtBytes: 1,
            containerIndexes: new Set([1]),
        },
    );

    expect(calls).toEqual([{ slot: 7, off: 0, len: 32 }]);
    expect(state.containers[0]).toMatchObject({
        index: 1,
        status: "loaded",
        occupiedSlots: 1,
    });
    expect(flatLines(state.containers[0])).toEqual([
        "[0..1] =0 ×2 (skipped)",
        "[2] 9",
        "[3] =0 (skipped)",
    ]);
});

test("readState: rejects an unknown container index before state reads", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData {
        uint64 count;
        Array<uint64, 4> values;
      };
      INITIALIZE() {}
    };
  `;
    const calls: StateReadCall[] = [];

    await expect(
        readState(
            fakeRpc(new Uint8Array(40), calls),
            7,
            source,
            "InvalidSelection",
            undefined,
            undefined,
            { containerIndexes: new Set([2]) },
        ),
    ).rejects.toThrow("container index 2 is outside 1..1");
    expect(calls).toEqual([]);
});

test("loadStateContainer reads only the collapsed block", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData { Array<uint64, 4> values; };
      INITIALIZE() {}
    };
  `;
    const initial = await readState(fakeRpc([]), 7, source, "Deferred", undefined, undefined, {
        collapseContainersAtBytes: 1,
    });
    const bytes = new Uint8Array(32);
    bytes.set(le(4, 8), 8);
    const calls: StateReadCall[] = [];

    const loaded = await loadStateContainer(fakeRpc(bytes, calls), 7, initial.containers[0]);

    expect(calls).toEqual([{ slot: 7, off: 0, len: 32 }]);
    expect(loaded).toMatchObject({
        index: 1,
        name: "values",
        status: "loaded",
        occupiedSlots: 1,
    });
});

test("readState: completes a 4 MiB request from shorter server chunks", async () => {
    const source = `
    using namespace QPI;
    struct CONTRACT_STATE_TYPE : public ContractBase {
      struct StateData { Array<uint64, 4> values; };
      INITIALIZE() {}
    };
  `;
    const bytes = new Uint8Array(32);
    bytes.set(le(5, 8), 24);
    const calls: StateReadCall[] = [];
    const rpc: StateReader = {
        stateRead: async (slot, off, len) => {
            calls.push({ slot, off, len });
            return {
                hex: hx(Array.from(bytes.subarray(off, off + Math.min(len, 8)))),
            };
        },
    };

    const state = await readState(rpc, 7, source, "ShortChunks");

    expect(calls).toEqual([
        { slot: 7, off: 0, len: 32 },
        { slot: 7, off: 8, len: 24 },
        { slot: 7, off: 16, len: 16 },
        { slot: 7, off: 24, len: 8 },
    ]);
    expect(state.complete).toBe(true);
    expect(state.containers[0].occupiedSlots).toBe(1);
});

test("readState: BitArray reads compact words and renders logical bits", async () => {
    const bitCount = 4_194_304;
    const bytes = new Uint8Array(bitCount / 8);
    bytes[262143] = 0x80;
    bytes[262144] = 0x01;
    const calls: StateReadCall[] = [];
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { BitArray<${bitCount}> bits; }; INITIALIZE() {} };`;

    const state = await readState(fakeRpc(bytes, calls), 9, source, "LargeBits");

    expect(calls).toEqual([{ slot: 9, off: 0, len: 524288 }]);
    expect(state.fields).toEqual([]);
    expect(state.containers[0]).toMatchObject({
        index: 1,
        name: "bits",
        kind: "bitarray",
        status: "loaded",
        capacity: bitCount,
        occupiedSlots: 2,
        totalEntries: 2,
    });
    expect(flatLines(state.containers[0])).toEqual([
        "[0..2097150] =0 ×2097151 (skipped)",
        "[2097151] =1",
        "[2097152] =1",
        "[2097153..4194303] =0 ×2097151 (skipped)",
    ]);
    expect(state.complete).toBe(true);
});

test("readState: BitArray ignores high padding bits", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { BitArray<2> bits; }; INITIALIZE() {} };`;
    const calls: StateReadCall[] = [];
    const bytes = new Uint8Array(8).fill(0xff);

    const state = await readState(fakeRpc(bytes, calls), 2, source, "SmallBits");

    expect(calls).toEqual([{ slot: 2, off: 0, len: 1 }]);
    expect(state.fields).toEqual([]);
    expect(state.containers[0]).toMatchObject({
        kind: "bitarray",
        occupiedSlots: 2,
        lines: [
            { label: "[0]", text: "=1", filled: true },
            { label: "[1]", text: "=1", filled: true },
        ],
    });
});

test("readState: nested BitArray keeps one-field struct boundaries", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct Bits { BitArray<128> value; }; struct Box { Bits bits; }; struct StateData { Box nested; }; INITIALIZE() {} };`;
    const bytes = new Uint8Array(16);
    bytes[7] = 0x80;

    const state = await readState(fakeRpc(bytes), 2, source, "NestedBits");

    expect(state.fields).toEqual([
        {
            name: "nested",
            value: "{value: [0..62]=0 ×63 (skipped), [63]=1, [64..127]=0 ×64 (skipped)}",
        },
    ]);
});

const HASHMAP_SOURCE = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, uint64, 8> values; }; INITIALIZE() {} };`;

test("readState: an empty HashMap only reads population", async () => {
    const calls: StateReadCall[] = [];
    const state = await readState(
        fakeRpc(new Uint8Array(152), calls),
        3,
        HASHMAP_SOURCE,
        "EmptyMap",
    );

    expect(calls).toEqual([{ slot: 3, off: 136, len: 8 }]);
    expect(state.complete).toBe(true);
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "hashmap",
            capacity: 8,
            occupiedSlots: 0,
            totalEntries: 0,
            lines: [{ label: "slots[0..7]", text: "(unoccupied ×8; skipped)", filled: false }],
        },
    ]);
});

test("readState: blocks keep the order their fields are declared in", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { uint64 first[2]; HashMap<uint64, uint64, 8> middle; uint64 last[2]; uint64 count; }; INITIALIZE() {} };`;
    const state = await readState(fakeRpc(new Uint8Array(216)), 3, source, "Mixed");

    expect(state.fields.map((field) => field.name)).toEqual(["count"]);
    expect(state.containers.map((container) => container.name)).toEqual([
        "first",
        "middle",
        "last",
    ]);
});

test("readState: does not retry an incomplete container read", async () => {
    const calls: StateReadCall[] = [];
    const state = await readState(fakeRpc([], calls), 3, HASHMAP_SOURCE, "ShortMap");

    expect(calls).toEqual([{ slot: 3, off: 136, len: 8 }]);
    expect(state.complete).toBe(false);
    expect(state.containers[0].error).toBe("short state read at 136: expected 8 bytes, got 0");
});

test("readState: a sparse HashMap fetches only occupied record ranges", async () => {
    const bytes = new Uint8Array(152);
    bytes.set(le((1n << 2n) | (1n << 4n) | (1n << 12n), 8), 128);
    bytes.set(le(3, 8), 136);
    for (const [slot, key, value] of [
        [1, 11, 101],
        [2, 22, 202],
        [6, 66, 606],
    ]) {
        bytes.set(le(key, 8), slot * 16);
        bytes.set(le(value, 8), slot * 16 + 8);
    }
    const calls: StateReadCall[] = [];
    const state = await readState(fakeRpc(bytes, calls), 4, HASHMAP_SOURCE, "SparseMap");

    expect(calls).toEqual([
        { slot: 4, off: 136, len: 8 },
        { slot: 4, off: 128, len: 8 },
        { slot: 4, off: 16, len: 32 },
        { slot: 4, off: 96, len: 16 },
    ]);
    expect(state.complete).toBe(true);
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "hashmap",
            capacity: 8,
            occupiedSlots: 3,
            totalEntries: 3,
            // `filled` is what the view highlights, so an occupied slot and a skipped range must never share it.
            lines: [
                { label: "slot[0]", text: "(unoccupied ×1; skipped)", filled: false },
                { label: "slot[1]", text: "11 = 101", filled: true },
                { label: "slot[2]", text: "22 = 202", filled: true },
                { label: "slots[3..5]", text: "(unoccupied ×3; skipped)", filled: false },
                { label: "slot[6]", text: "66 = 606", filled: true },
                { label: "slot[7]", text: "(unoccupied ×1; skipped)", filled: false },
            ],
        },
    ]);
});

test("readState: BitArray values inside HashMap use logical bit ranges", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, BitArray<128>, 4> values; }; INITIALIZE() {} };`;
    const bytes = new Uint8Array(120);
    bytes.set(le(7, 8), 48); // slot 2 key
    bytes[63] = 0x80; // slot 2 value bit 63
    bytes[96] = 1 << 4; // slot 2 occupied (two-bit flag)
    bytes.set(le(1, 8), 104);
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc(bytes, calls), 6, source, "MapBits");

    expect(calls).toEqual([
        { slot: 6, off: 104, len: 8 },
        { slot: 6, off: 96, len: 8 },
        { slot: 6, off: 48, len: 24 },
    ]);
    expect(flatLines(state.containers[0])).toEqual([
        "slots[0..1] (unoccupied ×2; skipped)",
        "slot[2] 7 = [0..62]=0 ×63 (skipped), [63]=1, [64..127]=0 ×64 (skipped)",
        "slot[3] (unoccupied ×1; skipped)",
    ]);
});

test("readState: one-field struct values inside HashMap keep their boundary", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct Value { uint64 number; }; struct StateData { HashMap<uint64, Value, 4> values; }; INITIALIZE() {} };`;
    const bytes = new Uint8Array(80);
    bytes.set(le(7, 8), 32); // slot 2 key
    bytes.set(le(9, 8), 40); // slot 2 value
    bytes[64] = 1 << 4; // slot 2 occupied (two-bit flag)
    bytes.set(le(1, 8), 72);

    const state = await readState(fakeRpc(bytes), 6, source, "MapStructs");

    expect(flatLines(state.containers[0])).toEqual([
        "slots[0..1] (unoccupied ×2; skipped)",
        "slot[2] 7 = {number: 9}",
        "slot[3] (unoccupied ×1; skipped)",
    ]);
});

test("readState: LinkedList values inside HashMap stay semantic", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashMap<uint64, LinkedList<uint64, 4>, 4> values; }; INITIALIZE() {} };`;
    const bytes = new Uint8Array(632);
    bytes.set(le(5, 8), 152); // outer slot 1 key
    bytes.set(le(9, 8), 208); // nested slot 2 value
    bytes.set(le(-1, 8), 216); // nested next
    bytes.set(le(-1, 8), 224); // nested previous
    bytes[256] = 1 << 2; // nested slot 2 occupied
    bytes.set(le(2, 8), 264); // nested head
    bytes.set(le(2, 8), 272); // nested tail
    bytes.set(le(1, 8), 296); // nested population
    bytes[608] = 1 << 2; // outer slot 1 occupied (two-bit flag)
    bytes.set(le(1, 8), 616); // outer population
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc(bytes, calls), 7, source, "MapLists");

    expect(calls).toEqual([
        { slot: 7, off: 616, len: 8 },
        { slot: 7, off: 608, len: 8 },
        { slot: 7, off: 152, len: 152 },
    ]);
    expect(flatLines(state.containers[0])).toEqual([
        "slot[0] (unoccupied ×1; skipped)",
        "slot[1] 5 = item[0] slot[2] = 9, slots[0..1] (unoccupied ×2; skipped), slot[3] (unoccupied ×1; skipped)",
        "slots[2..3] (unoccupied ×2; skipped)",
    ]);
});

const LINKED_LIST_SOURCE = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { LinkedList<uint64, 8> values; }; INITIALIZE() {} };`;

const linkedListState = () => {
    const bytes = new Uint8Array(240);
    bytes[192] = (1 << 1) | (1 << 2) | (1 << 6);
    bytes.set(le(6, 8), 200); // head
    bytes.set(le(2, 8), 208); // tail
    bytes.set(le(3, 8), 232); // population

    bytes.set(le(11, 8), 24);
    bytes.set(le(2, 8), 32);
    bytes.set(le(6, 8), 40);

    bytes.set(le(22, 8), 48);
    bytes.set(le(-1, 8), 56);
    bytes.set(le(1, 8), 64);

    bytes.set(le(66, 8), 144);
    bytes.set(le(1, 8), 152);
    bytes.set(le(-1, 8), 160);
    return bytes;
};

test("readState: an empty LinkedList only reads population", async () => {
    const calls: StateReadCall[] = [];
    const state = await readState(
        fakeRpc(new Uint8Array(240), calls),
        10,
        LINKED_LIST_SOURCE,
        "EmptyList",
    );

    expect(calls).toEqual([{ slot: 10, off: 232, len: 8 }]);
    expect(state.complete).toBe(true);
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "linkedlist",
            capacity: 8,
            occupiedSlots: 0,
            totalEntries: 0,
            lines: [{ label: "slots[0..7]", text: "(unoccupied ×8; skipped)", filled: false }],
        },
    ]);
});

test("readState: LinkedList reads occupied nodes and renders logical order", async () => {
    const calls: StateReadCall[] = [];
    const state = await readState(
        fakeRpc(linkedListState(), calls),
        11,
        LINKED_LIST_SOURCE,
        "SparseList",
    );

    expect(calls).toEqual([
        { slot: 11, off: 232, len: 8 },
        { slot: 11, off: 192, len: 8 },
        { slot: 11, off: 200, len: 16 },
        { slot: 11, off: 24, len: 48 },
        { slot: 11, off: 144, len: 24 },
    ]);
    expect(state.complete).toBe(true);
    expect(state.containers).toMatchObject([
        {
            name: "values",
            kind: "linkedlist",
            capacity: 8,
            occupiedSlots: 3,
            totalEntries: 3,
            lines: [
                { label: "item[0] slot[6]", text: "= 66", filled: true },
                { label: "item[1] slot[1]", text: "= 11", filled: true },
                { label: "item[2] slot[2]", text: "= 22", filled: true },
                { label: "slot[0]", text: "(unoccupied ×1; skipped)", filled: false },
                { label: "slots[3..5]", text: "(unoccupied ×3; skipped)", filled: false },
                { label: "slot[7]", text: "(unoccupied ×1; skipped)", filled: false },
            ],
        },
    ]);
});

test("readState: LinkedList retries a transient topology change", async () => {
    const bytes = new Uint8Array(240);
    bytes[192] = 1;
    bytes.set(le(0, 8), 200);
    bytes.set(le(0, 8), 208);
    bytes.set(le(9, 8), 0);
    bytes.set(le(-1, 8), 8);
    bytes.set(le(-1, 8), 16);
    bytes.set(le(1, 8), 232);
    const calls: StateReadCall[] = [];
    let flagReads = 0;
    const rpc: StateReader = {
        stateRead: async (slot, off, len) => {
            calls.push({ slot, off, len });
            if (off === 192 && flagReads++ === 0) {
                return { hex: hx([3, 0, 0, 0, 0, 0, 0, 0]) };
            }
            return { hex: hx(Array.from(bytes.subarray(off, off + len))) };
        },
    };

    const state = await readState(rpc, 12, LINKED_LIST_SOURCE, "ChangingList");

    expect(state.complete).toBe(true);
    expect(calls.slice(0, 4)).toEqual([
        { slot: 12, off: 232, len: 8 },
        { slot: 12, off: 192, len: 8 },
        { slot: 12, off: 232, len: 8 },
        { slot: 12, off: 192, len: 8 },
    ]);
    expect(flatLines(state.containers[0])[0]).toBe("item[0] slot[0] = 9");
});

test("readState: persistent LinkedList topology changes are incomplete", async () => {
    const bytes = new Uint8Array(240);
    bytes[192] = 3;
    bytes.set(le(1, 8), 232);
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc(bytes, calls), 13, LINKED_LIST_SOURCE, "BrokenList");

    expect(calls).toEqual([
        { slot: 13, off: 232, len: 8 },
        { slot: 13, off: 192, len: 8 },
        { slot: 13, off: 232, len: 8 },
        { slot: 13, off: 192, len: 8 },
    ]);
    expect(state.complete).toBe(false);
    expect(state.containers[0].error).toContain("2 occupied slots but population 1");
});

test("readState: a sparse Collection fetches occupied PoVs and live elements", async () => {
    const source = `using namespace QPI; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { Collection<uint64, 4> values; }; INITIALIZE() {} };`;
    const bytes = new Uint8Array(472);
    bytes.set(le(1, 8), 160); // PoV 2 population
    bytes.set(le(0, 8), 184); // PoV 2 root -> element 0
    bytes.set(le(1n << 4n, 8), 256); // PoV 2 occupied
    bytes.set(le(7, 8), 264); // element 0 value
    bytes.set(le(3, 8), 272); // priority
    bytes.set(le(2, 8), 280); // PoV index
    bytes.set(le(-1, 8), 288); // parent
    bytes.set(le(-1, 8), 296); // left
    bytes.set(le(-1, 8), 304); // right
    bytes.set(le(1, 8), 456); // total population
    const calls: StateReadCall[] = [];

    const state = await readState(fakeRpc(bytes, calls), 5, source, "SparseCollection");

    expect(calls).toEqual([
        { slot: 5, off: 456, len: 8 },
        { slot: 5, off: 256, len: 8 },
        { slot: 5, off: 128, len: 64 },
        { slot: 5, off: 264, len: 48 },
    ]);
    expect(state.complete).toBe(true);
    expect(state.containers[0]).toMatchObject({
        name: "values",
        kind: "collection",
        capacity: 4,
        occupiedSlots: 1,
        totalEntries: 1,
    });
    expect(state.containers[0].lines).toHaveLength(3);
    expect(state.containers[0].lines[1].text).toContain(": 7 (p3)");
});

const mkEntry = (o: Partial<any>): any => ({
    seq: 1,
    tick: 1,
    index: 0,
    entry: 1,
    kind: 1,
    ok: true,
    execNs: 0,
    invocator: "11".repeat(32),
    invocationReward: 0,
    inHex: "",
    outHex: "",
    stateDiff: [],
    hostCalls: [],
    logs: [],
    ...o,
});

test("describeTrace: multi-field input decodes to named fields", async () => {
    const SRC_MULTI = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Pair_input { uint64 a; uint64 b; }; struct Pair_output {}; PUBLIC_PROCEDURE(Pair) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Pair, 1); } INITIALIZE() {} };`;
    const v = await describeTrace(
        mkEntry({ inHex: hx([...le(5, 8), ...le(7, 8)]) }),
        SRC_MULTI,
        "M",
    );
    expect(v.inDecoded).toBe("{a: 5, b: 7}");
});

test("readState: a sparse HashSet fetches only occupied key ranges", async () => {
    const SRC_SET = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { HashSet<id, 4> seen; }; struct Mark_input { id who; }; struct Mark_output {}; PUBLIC_PROCEDURE(Mark) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Mark, 1); } INITIALIZE() {} };`;
    const b = new Array(4 * 32 + 8 + 16).fill(0);
    b[4 * 32] = 1; // slot0 (all-zero id) occupied
    const calls: StateReadCall[] = [];
    le(1, 8).forEach((x, i) => (b[4 * 32 + 8 + i] = x)); // population
    const state = await readState(fakeRpc(b, calls), 2, SRC_SET, "Set");

    expect(calls).toEqual([
        { slot: 2, off: 136, len: 8 },
        { slot: 2, off: 128, len: 8 },
        { slot: 2, off: 0, len: 32 },
    ]);
    expect(state.complete).toBe(true);
    expect(state.containers).toMatchObject([
        {
            name: "seen",
            kind: "hashset",
            capacity: 4,
            occupiedSlots: 1,
            totalEntries: 1,
            lines: [
                {
                    label: "slot[0]",
                    text: expect.stringMatching(/^[A-Z]{60}$/),
                    filled: true,
                },
                {
                    label: "slots[1..3]",
                    text: "(unoccupied ×3; skipped)",
                    filled: false,
                },
            ],
        },
    ]);
});

test("describeTrace: no StateData -> empty fields, io still decoded, fn caller (none)", async () => {
    const SRC_NS = `using namespace QPI; struct CONTRACT_STATE2_TYPE {}; struct CONTRACT_STATE_TYPE : public ContractBase { struct Foo_input { uint64 a; }; struct Foo_output { uint64 r; }; PUBLIC_FUNCTION(Foo) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Foo, 1); } INITIALIZE() {} };`;
    const v = await describeTrace(
        mkEntry({ kind: 0, inHex: hx(le(5, 8)), outHex: hx(le(9, 8)) }),
        SRC_NS,
        "NS",
    );
    expect(v.fields).toHaveLength(0);
    expect(v.inDecoded).toBe("5");
    expect(v.outDecoded).toBe("9");
    expect(v.caller).toBe("(none)"); // kind 0 (fn) carries no signer
});

test("readState reports incomplete scalar and container reads", async () => {
    const boom: StateReader = {
        stateRead: async () => {
            throw new Error("rpc down");
        },
    };
    const state = await readState(boom, 7, SRC, "Counter");
    expect(state.complete).toBe(false);
    expect(state.fields).toEqual([{ name: "counter", value: "(read failed: rpc down)" }]);
    expect(state.containers).toMatchObject([
        {
            name: "bal",
            kind: "hashmap",
            capacity: 4,
            occupiedSlots: 0,
            totalEntries: 0,
            lines: [],
            error: "rpc down",
        },
    ]);
});

import { fmtVal } from "../../src/trace/format";
test("fmtVal: run-length-group long runs, keep short literal, cap unless full", () => {
    expect(fmtVal([0, 0, 0])).toBe("[0, 0, 0]"); // short run kept literal
    expect(fmtVal(Array(100).fill(0))).toBe("[0 ×100]"); // long run collapsed
    expect(fmtVal([1, 2, 2, 2, 2, 2, 2, 3])).toBe("[1, 2 ×6, 3]"); // run >= 6 collapsed, rest literal
    expect(fmtVal([5n, 7n])).toBe("[5, 7]"); // bigint
    const varied = Array.from({ length: 50 }, (_, i) => i);
    expect(fmtVal(varied)).toContain("+18 more (--all)"); // 50 -> cap 32 + 18 more
    expect(fmtVal(varied, true)).not.toContain("more"); // full -> all 50
    expect(
        fmtVal([
            ["A", "0"],
            ["A", "0"],
            ["A", "0"],
            ["A", "0"],
            ["A", "0"],
            ["A", "0"],
        ]),
    ).toBe(`[["A", "0"] ×6]`); // nested struct run
});

// A container key is decoded positionally like any other value, so it needs its type to read as a record
// rather than as the tuple the ABI decoder hands back.
test("keyLabel names a struct key's fields", () => {
    const sint32: AbiType = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.SINT32,
        size: 4,
        align: 4,
        format: "sint32",
    };
    const point: AbiType = {
        kind: AbiTypeKind.STRUCT,
        name: "Point",
        fields: [
            { name: "x", offset: 0, size: 4, type: sint32 },
            { name: "y", offset: 4, size: 4, type: sint32 },
        ],
        size: 8,
        align: 4,
        format: "sint32, sint32",
    };

    expect(keyLabel([1, 2], point)).toBe("{x: 1, y: 2}");
    expect(keyLabel(7n, sint32)).toBe("7");
    expect(keyLabel("ICZREL")).toBe("ICZREL");
});
