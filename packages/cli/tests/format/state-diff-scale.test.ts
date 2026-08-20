// The resolver had only ever met containers small enough to fit in one or two 256-byte windows. Real
// contracts run to hundreds of megabytes, where the occupation flags alone span thousands of them.
import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import type { DebugStateRegion } from "@qinit/core";
import { hashMapGeometry } from "@qinit/proto/qpi-layout";
import { stateFieldsOf, type StateField } from "../../src/trace/state-format";
import { stateDiffLines } from "../../src/trace/state-diff";

const U64 = { size: 8, align: 8 };

const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function writeLe(bytes: Uint8Array, offset: number, value: number, width = 8) {
    let rest = BigInt(value);
    for (let index = 0; index < width; index++) {
        bytes[offset + index] = Number(rest & 0xffn);
        rest >>= 8n;
    }
}

// A window carries its own bytes, so a case can sit anywhere in a 545 MB state without allocating one.
// `seed` fills the before image and `write` the after image, both at offsets relative to the window.
function diffWindow(off: number, length: number, seed?: (bytes: Uint8Array) => void, write?: (bytes: Uint8Array) => void): DebugStateRegion {
    const before = new Uint8Array(length);
    seed?.(before);

    const after = before.slice();
    write?.(after);

    return { off, before: hex(before), after: hex(after) };
}

function fieldsOf(name: string, members: string): StateField[] {
    const source = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { ${members} };
  INITIALIZE() {}
};`;

    return stateFieldsOf(extractIdl(source, name, { slot: 7 }));
}

const offsetOf = (fields: StateField[], name: string) => fields.find((field) => field.name === name)!.off;

const rowsFor = async (fields: StateField[], regions: DebugStateRegion[]) =>
    (await stateDiffLines(fields, regions)).map((line) => `${line.label} ${line.text}`);

// 0b00 free, 0b01 occupied, 0b10 occupied but marked for removal — two bits per slot, as core packs them.
const flagByte = (flagsOff: number, slot: number) => flagsOff + ((slot * 2) >> 3);
const flagBits = (slot: number, value: number) => value << ((slot * 2) & 7);

const HUGE_CAPACITY = 1 << 25; // 33.5M slots — 536 MB of records, then 8 MiB of occupation flags
const HUGE = hashMapGeometry(U64, U64, HUGE_CAPACITY);
const HUGE_FIELDS = fieldsOf("Huge", `HashMap<uint64, uint64, ${HUGE_CAPACITY}> m;`);
const HUGE_FLAGS = offsetOf(HUGE_FIELDS, "m") + HUGE.flagsOffset;

// At this capacity the flags start 512 MB into the state and span 32768 windows, so a slot's flag almost
// never lands in the window the run begins in — the shape every container in the old suite was too small
// to produce.
test("a flag deep inside a 545 MB map still reports its slot", async () => {
    for (const slot of [9822, 1_000_000, HUGE_CAPACITY - 1]) {
        const window = diffWindow(flagByte(HUGE_FLAGS, slot), 1, undefined, (bytes) => (bytes[0] = flagBits(slot, 1)));

        expect(await rowsFor(HUGE_FIELDS, [window])).toEqual([`m._occupationFlags[${slot}] 0 → 1`]);
    }
});

// Reporting a window used to cost a walk of the whole capacity, since only the bounds check inside
// `valueAt` stopped it. These same 64 rows took about 11 seconds at this size.
test("resolving 64 flag windows does not walk the whole capacity", async () => {
    const windows = Array.from({ length: 64 }, (_, index) => diffWindow(HUGE_FLAGS + 4096 + index * 512, 256, undefined, (bytes) => (bytes[0] = 1)));

    const started = performance.now();
    const rows = await rowsFor(HUGE_FIELDS, windows);

    expect(rows).toHaveLength(64);
    expect(performance.now() - started).toBeLessThan(3000);
});

// A uint32 value under a uint64 key leaves four pad bytes at the end of every record. They used to
// resolve back to the record base — the key — and report it once per pad byte, four rows of noise.
const NARROW_CAPACITY = 8;
const NARROW = hashMapGeometry(U64, { size: 4, align: 4 }, NARROW_CAPACITY);
const NARROW_FIELDS = fieldsOf("Narrow", `HashMap<uint64, uint32, ${NARROW_CAPACITY}> narrow;`);

test("a record's trailing pad reports nothing instead of re-reading its key", async () => {
    const base = offsetOf(NARROW_FIELDS, "narrow");
    const slot = 4;
    const record = slot * NARROW.recordStride;

    const window = diffWindow(base, NARROW.populationOffset + 8, undefined, (bytes) => {
        writeLe(bytes, record, 11);
        writeLe(bytes, record + NARROW.valueOffset, 5, 4);
        bytes[flagByte(NARROW.flagsOffset, slot)] = flagBits(slot, 1);
        writeLe(bytes, NARROW.populationOffset, 1);
    });

    expect(await rowsFor(NARROW_FIELDS, [window])).toEqual([
        "narrow.slot[4].key 0 → 11",
        "narrow[11] = 5 (new)",
        "narrow._occupationFlags[4] 0 → 1",
        "narrow 0 → 1 entries",
    ]);
});
