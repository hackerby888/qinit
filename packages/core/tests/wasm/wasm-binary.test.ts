// LEB128, vector and section primitives: every form the writer emits reads back, and malformed bytes fail naming where.
import { expect, test } from "bun:test";
import { ByteReader, ByteWriter, WASM_MAGIC, WasmBinaryError, WasmSectionId, decodeVector, encodeVector, joinSections, splitSections } from "../../src/wasm/wasm-binary";

const U32: [value: number, bytes: number[]][] = [
    [0, [0x00]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [0x80000000, [0x80, 0x80, 0x80, 0x80, 0x08]],
    [0xffffffff, [0xff, 0xff, 0xff, 0xff, 0x0f]],
];

const I32: [value: number, bytes: number[]][] = [
    [0, [0x00]],
    [-1, [0x7f]],
    [63, [0x3f]],
    [64, [0xc0, 0x00]],
    [-64, [0x40]],
    [-65, [0xbf, 0x7f]],
    [0x7fffffff, [0xff, 0xff, 0xff, 0xff, 0x07]],
    [-0x80000000, [0x80, 0x80, 0x80, 0x80, 0x78]],
];

function failure(run: () => unknown): { message: string; offset: number | undefined } {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(WasmBinaryError);
        return { message: (error as WasmBinaryError).message, offset: (error as WasmBinaryError).offset };
    }
    throw new Error("expected a WasmBinaryError");
}

test.each(U32)("u32 %d is written in the fewest bytes and read back", (value, bytes) => {
    const written = new ByteWriter().u32(value).toBytes();
    expect([...written]).toEqual(bytes);

    const reader = new ByteReader(written);
    expect(reader.u32("value")).toBe(value);
    expect(reader.done).toBe(true);
});

test.each(I32)("i32 %d is written in the fewest bytes and read back", (value, bytes) => {
    const written = new ByteWriter().i32(value).toBytes();
    expect([...written]).toEqual(bytes);

    const reader = new ByteReader(written);
    expect(reader.i32("value")).toBe(value);
    expect(reader.done).toBe(true);
});

test("a spread of 32-bit values reads back through both LEB forms", () => {
    for (let step = 0; step < 2000; step++) {
        const unsigned = Math.imul(step, 0x9e3779b1) >>> 0;
        const signed = unsigned | 0;
        const reader = new ByteReader(new ByteWriter().u32(unsigned).i32(signed).toBytes());
        expect({ step, unsigned: reader.u32("unsigned"), signed: reader.i32("signed"), done: reader.done }).toEqual({ step, unsigned, signed, done: true });
    }
});

test("names read back, empty and multi-byte included", () => {
    const names = ["", "state_addr", "ключ→値"];
    const writer = new ByteWriter();
    for (const name of names) {
        writer.name(name);
    }

    const reader = new ByteReader(writer.toBytes());
    expect(names.map(() => reader.name("name"))).toEqual(names);
    expect(reader.done).toBe(true);
});

test("a reader names what ran out and where", () => {
    expect(failure(() => new ByteReader(Uint8Array.of(0x80)).u32("count"))).toEqual({ message: "count ran past the end", offset: 1 });
    expect(failure(() => new ByteReader(Uint8Array.of(1, 2)).take(3, "payload"))).toEqual({ message: "payload ran past the end", offset: 0 });
    expect(failure(() => new ByteReader(Uint8Array.of(5, 0x61)).name("export"))).toEqual({ message: "export ran past the end", offset: 1 });

    const overlong = new Uint8Array(11).fill(0x80);
    expect(failure(() => new ByteReader(overlong).u32("count"))).toEqual({ message: "count is not a 32-bit LEB", offset: 5 });
    expect(failure(() => new ByteReader(overlong).i32("offset"))).toEqual({ message: "offset is not a signed 32-bit LEB", offset: 5 });
    expect(failure(() => new ByteReader(overlong).skipI64("init"))).toEqual({ message: "init is not a signed 64-bit LEB", offset: 10 });
});

test("skipI64 stops after the byte that ends the number", () => {
    const reader = new ByteReader(Uint8Array.of(0x80, 0x80, 0x01, 0x2a));
    reader.skipI64("init");
    expect(reader.position).toBe(3);
    expect(reader.remaining).toBe(1);
    expect(reader.peek()).toBe(0x2a);

    reader.skip(1, "tail");
    expect(reader.peek()).toBe(-1);
});

test("a vector splits back into the elements it was built from", () => {
    const elements = ["", "a", "state_addr"].map((name) => new ByteWriter().name(name).toBytes());
    const payload = encodeVector(elements);

    expect(decodeVector(payload, (reader) => reader.name("entry")).map((element) => [...element])).toEqual(elements.map((element) => [...element]));
    expect(decodeVector(encodeVector([]), () => undefined)).toEqual([]);
    // a count the payload cannot back fails rather than returning fewer elements.
    expect(failure(() => decodeVector(Uint8Array.of(2, 1, 0x61), (reader) => reader.name("entry")))).toEqual({ message: "entry length ran past the end", offset: 3 });
});

test("a module survives split then join byte for byte, custom sections and order included", () => {
    const sections = [
        { id: WasmSectionId.CUSTOM, payload: new ByteWriter().name("name").bytes([1, 2, 3]).toBytes() },
        { id: WasmSectionId.TYPE, payload: encodeVector([Uint8Array.of(0x60, 0, 0)]) },
        // 200 bytes puts the section size in a two-byte LEB.
        { id: WasmSectionId.CUSTOM, payload: new Uint8Array(200).fill(7) },
        { id: WasmSectionId.CODE, payload: new Uint8Array(0) },
    ];
    const wasm = joinSections(sections);
    expect([...wasm.subarray(0, WASM_MAGIC.length)]).toEqual([...WASM_MAGIC]);

    const split = splitSections(wasm);
    expect(split.map((section) => [section.id, [...section.payload]])).toEqual(sections.map((section) => [section.id, [...section.payload]]));
    expect(joinSections(split)).toEqual(wasm);
    expect(splitSections(Uint8Array.from(WASM_MAGIC))).toEqual([]);
});

test("splitting refuses a bad header and a section longer than the file", () => {
    const wrongVersion = Uint8Array.from(WASM_MAGIC);
    wrongVersion[4] = 2;
    expect(failure(() => splitSections(wrongVersion))).toEqual({ message: "not a wasm module (bad magic or version)", offset: 4 });
    expect(failure(() => splitSections(new Uint8Array(0)))).toEqual({ message: "not a wasm module (bad magic or version)", offset: 0 });

    const truncated = Uint8Array.of(...WASM_MAGIC, WasmSectionId.TYPE, 5, 0xaa);
    expect(failure(() => splitSections(truncated))).toEqual({ message: "section payload ran past the end", offset: 10 });
});
