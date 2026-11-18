import { expect, test } from "bun:test";

import { array, blob, defineStruct, i16, i32, i64, pad, sub, u16, u24, u32, u56, u64, u8, type Codec } from "../../src/codec/struct";

const SevenByteValue = defineStruct("SevenByteValue", {
    value: u56,
});

test("u56 reads and writes the low 56 bits in little-endian order", () => {
    const value = SevenByteValue.alloc();

    value.value = 0x01020304050607n;
    expect(value.bytes).toEqual(Uint8Array.of(0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01));
    expect(value.value).toBe(0x01020304050607n);

    value.value = 0xab01020304050607n;
    expect(value.bytes).toEqual(Uint8Array.of(0x07, 0x06, 0x05, 0x04, 0x03, 0x02, 0x01));
    expect(value.value).toBe(0x01020304050607n);
});

const SCALARS: [name: string, codec: Codec<any>, value: number | bigint, bytes: number[]][] = [
    ["u8 max", u8, 0xff, [0xff]],
    ["u16", u16, 0x1234, [0x34, 0x12]],
    ["u16 max", u16, 0xffff, [0xff, 0xff]],
    ["u24", u24, 0x123456, [0x56, 0x34, 0x12]],
    ["u24 max", u24, 0xffffff, [0xff, 0xff, 0xff]],
    ["u32", u32, 0x12345678, [0x78, 0x56, 0x34, 0x12]],
    ["u32 max", u32, 0xffffffff, [0xff, 0xff, 0xff, 0xff]],
    ["i16 min", i16, -0x8000, [0x00, 0x80]],
    ["i16 -2", i16, -2, [0xfe, 0xff]],
    ["i32 min", i32, -0x80000000, [0x00, 0x00, 0x00, 0x80]],
    ["i32 -2", i32, -2, [0xfe, 0xff, 0xff, 0xff]],
    ["u64", u64, 0x0102030405060708n, [8, 7, 6, 5, 4, 3, 2, 1]],
    ["u64 max", u64, 0xffffffffffffffffn, [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
    ["i64 min", i64, -(1n << 63n), [0, 0, 0, 0, 0, 0, 0, 0x80]],
    ["i64 -2", i64, -2n, [0xfe, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]],
];

test.each(SCALARS)("%s writes little-endian bytes and reads the value back", (_name, codec, value, bytes) => {
    const One = defineStruct("One", { value: codec });
    const one = One.alloc();
    one.value = value;
    expect([...one.bytes]).toEqual(bytes);
    expect(One.wrap(Uint8Array.from(bytes)).value).toBe(value);

    // a view at an offset reads its own window, not the start of the buffer.
    const shifted = new Uint8Array(3 + bytes.length);
    shifted.set(bytes, 3);
    expect(One.wrap(shifted, 3).value).toBe(value);
});

test("blob, pad, array and sub fields sit where the layout puts them", () => {
    const Inner = defineStruct("Inner", { a: u16, b: u16 });
    const Outer = defineStruct("Outer", { tag: u8, gap: pad(3), name: blob(4), items: array(u16, 3), inner: sub(Inner, 2) });
    expect(Outer.SIZE).toBe(18);
    expect(Outer.OFFSETS).toEqual({ tag: 0, gap: 1, name: 4, items: 8, inner: 14 });

    const outer = Outer.alloc();
    outer.tag = 7;
    outer.gap = undefined;
    expect(outer.gap).toBeUndefined();

    // a blob takes the first n bytes it is given, and reads back as a live window.
    outer.name = Uint8Array.of(1, 2, 3, 4, 5);
    outer.name[0] = 9;

    outer.items.set(0, 0x0102);
    outer.items.set(2, 0xffff);
    expect(outer.items.length).toBe(3);
    expect([outer.items.at(0), outer.items.at(1), outer.items.at(2)]).toEqual([0x0102, 0, 0xffff]);
    expect(() => {
        outer.items = outer.items;
    }).toThrow("assign array elements via .set(i, value)");

    const inner = Inner.alloc();
    inner.a = 0x1111;
    inner.b = 0x2222;
    outer.inner = inner;
    outer.inner.a = 5;
    expect(inner.a).toBe(0x1111);

    expect([...outer.bytes]).toEqual([7, 0, 0, 0, 9, 2, 3, 4, 0x02, 0x01, 0, 0, 0xff, 0xff, 5, 0, 0x22, 0x22]);

    const copy = outer.clone();
    copy.tag = 1;
    expect(outer.tag).toBe(7);
});

test("a packed struct drops the alignment gaps a natural one keeps", () => {
    const fields = { flag: u8, count: u32, total: u64 };
    const Natural = defineStruct("Natural", fields);
    const Packed = defineStruct("Packed", fields, { packed: true });

    expect([Natural.SIZE, Natural.OFFSETS]).toEqual([16, { flag: 0, count: 4, total: 8 }]);
    expect([Packed.SIZE, Packed.OFFSETS]).toEqual([13, { flag: 0, count: 1, total: 5 }]);
});
