import { test, expect } from "bun:test";
import { jsonToInputFormat, encodeInputJson, encodeInput, decodeOutput, hasOverlappingAbiType, zeroInputFormat } from "../../src/abi-fmt";
import { callFunction } from "../../src/call";
import { linkedListGeometry } from "../../src/qpi-layout";
import { AbiScalarKind, AbiTypeKind, type AbiStruct, type AbiType } from "../../src/contract-idl";

test("jsonToInputFormat: flat scalars by field name", () => {
    expect(jsonToInputFormat([{ name: "value", type: "uint64" }], { value: 3 })).toBe("3uint64");
    expect(
        jsonToInputFormat(
            [
                { name: "a", type: "uint32" },
                { name: "b", type: "sint64" },
            ],
            { a: 5, b: -7 },
        ),
    ).toBe("5uint32, -7sint64");
});

test("jsonToInputFormat: positional array form (order = field order)", () => {
    expect(
        jsonToInputFormat(
            [
                { name: "a", type: "uint8" },
                { name: "b", type: "uint16" },
            ],
            [1, 2],
        ),
    ).toBe("1uint8, 2uint16");
});

test("jsonToInputFormat: id field passes the identity through", () => {
    const id = "A".repeat(60);
    expect(jsonToInputFormat([{ name: "dst", type: "id" }], { dst: id })).toBe(`${id}id`);
});

test("encodeInputJson: the 60-A zero identity hint encodes to the zero id", async () => {
    const b = await encodeInputJson([{ name: "dst", type: "id" }], { dst: "A".repeat(60) });
    expect(b).toEqual(new Uint8Array(32));
});

test("jsonToInputFormat: nested struct (positional) + fixed array", () => {
    expect(jsonToInputFormat([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1, 2] })).toBe("{ 1uint64, 2uint32 }");
    expect(jsonToInputFormat([{ name: "xs", type: "[3;uint64]" }], { xs: [1, 2, 3] })).toBe("[3; 1uint64, 2uint64, 3uint64]");
});

test("jsonToInputFormat: bool -> bit, big numeric string preserved", () => {
    expect(jsonToInputFormat([{ name: "f", type: "bit" }], { f: true })).toBe("1bit");
    expect(jsonToInputFormat([{ name: "n", type: "uint64" }], { n: "18446744073709551615" })).toBe("18446744073709551615uint64");
});

test("jsonToInputFormat: uint128 decimal string remains lossless", async () => {
    const max = (1n << 128n) - 1n;
    expect(jsonToInputFormat([{ name: "n", type: "uint128" }], { n: max.toString() })).toBe(`${max}uint128`);
    const b = await encodeInputJson([{ name: "n", type: "uint128" }], { n: max.toString() });
    expect(await decodeOutput(b, "uint128")).toBe(max);
});

test("jsonToInputFormat: missing field + arity mismatch throw", () => {
    expect(() => jsonToInputFormat([{ name: "value", type: "uint64" }], {})).toThrow(/missing input field 'value'/);
    expect(() => jsonToInputFormat([{ name: "xs", type: "[2;uint64]" }], { xs: [1] })).toThrow(/expects 2 elements/);
    expect(() => jsonToInputFormat([{ name: "p", type: "{ uint64, uint32 }" }], { p: [1] })).toThrow(/expects 2 values/);
});

test("encodeInputJson === encodeInput of the equivalent fmt (incl alignment)", async () => {
    const a = await encodeInputJson([{ name: "value", type: "uint64" }], { value: 3 });
    expect([...a]).toEqual([...(await encodeInput("3uint64"))]);
    // {uint8, uint64}: 1B + 7B pad + 8B
    const b = await encodeInputJson([{ name: "s", type: "{ uint8, uint64 }" }], { s: [5, 9] });
    expect([...b]).toEqual([...(await encodeInput("{ 5uint8, 9uint64 }"))]);
    expect(b.length).toBe(16);
});

test("jsonToInputFormat: float value is rejected (BigInt refuses non-integers)", () => {
    expect(() => jsonToInputFormat([{ name: "n", type: "uint64" }], { n: 3.5 })).toThrow();
});

test("jsonToInputFormat: null/undefined value throws", () => {
    expect(() => jsonToInputFormat([{ name: "v", type: "uint64" }], { v: null })).toThrow(/missing value/);
});

test("jsonToInputFormat: extra JSON keys are ignored (only declared fields used)", () => {
    expect(jsonToInputFormat([{ name: "a", type: "uint64" }], { a: 1, unrelated: 99 })).toBe("1uint64");
});

test("encodeInputJson: a bad id surfaces the encode-time validation error", async () => {
    await expect(encodeInputJson([{ name: "dst", type: "id" }], { dst: "tooshort" })).rejects.toThrow(/id must be/);
});

test("encodeInputJson: m256i field round-trips (64-hex -> 32 bytes)", async () => {
    const dg = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const b = await encodeInputJson([{ name: "d", type: "m256i" }], { d: dg });
    expect(b.length).toBe(32);
    expect(await decodeOutput(b, "m256i")).toBe(dg);
});

test("encodeInputJson: deep nested array-of-structs (positional) round-trips", async () => {
    const fields = [{ name: "xs", type: "[2;{ uint32, uint32 }]" }];
    const b = await encodeInputJson(fields, {
        xs: [
            [1, 2],
            [3, 4],
        ],
    });
    expect(await decodeOutput(b, "[2;{ uint32, uint32 }]")).toEqual([
        [1, 2],
        [3, 4],
    ]);
});

test("typed codec honors explicit field offsets", async () => {
    const padded: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 24,
        align: 8,
        format: "wrong",
        fields: [
            {
                name: "tag",
                offset: 0,
                size: 1,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT8,
                    size: 1,
                    align: 1,
                    format: "wrong",
                },
            },
            {
                name: "value",
                offset: 16,
                size: 8,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT64,
                    size: 8,
                    align: 8,
                    format: "wrong",
                },
            },
        ],
    };

    const bytes = await encodeInputJson(padded, { tag: 7, value: 99n });
    expect(bytes.length).toBe(24);
    expect(bytes[0]).toBe(7);
    expect(bytes.slice(1, 16)).toEqual(new Uint8Array(15));
    expect(new DataView(bytes.buffer).getBigUint64(16, true)).toBe(99n);
    expect(await decodeOutput(bytes, padded)).toEqual([7, 99n]);
});

test("typed codec accepts direct scalar and array roots", async () => {
    const scalar: AbiType = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "uint64",
    };
    const array: AbiType = {
        kind: AbiTypeKind.ARRAY,
        count: 3,
        size: 6,
        align: 2,
        format: "[3;uint16]",
        element: {
            kind: AbiTypeKind.SCALAR,
            scalar: AbiScalarKind.UINT16,
            size: 2,
            align: 2,
            format: "uint16",
        },
    };

    const scalarBytes = await encodeInputJson(scalar, 42n);
    expect(await decodeOutput(scalarBytes, scalar)).toBe(42n);
    expect(jsonToInputFormat(scalar, 42n)).toBe("42uint64");
    let captured: number[] = [];
    const rpc = {
        querySmartContract: async (_contractIndex: number, _inputType: number, input: Uint8Array) => {
            captured = [...input];
            return input;
        },
    };
    expect(await callFunction(rpc as any, 28, 1, { type: scalar, value: 42n }, scalar)).toBe(42n);
    expect(captured).toEqual([...scalarBytes]);

    const arrayBytes = await encodeInputJson(array, [3, 5, 8]);
    expect(await decodeOutput(arrayBytes, array)).toEqual([3, 5, 8]);
    expect(jsonToInputFormat(array, [3, 5, 8])).toBe("[3; 3uint16, 5uint16, 8uint16]");
});

test("typed array preserves nested one-field structs", async () => {
    const value: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 2,
        align: 2,
        format: "{ uint16 }",
        fields: [
            {
                name: "value",
                offset: 0,
                size: 2,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT16,
                    size: 2,
                    align: 2,
                    format: "uint16",
                },
            },
        ],
    };
    const array: AbiType = {
        kind: AbiTypeKind.ARRAY,
        count: 2,
        element: value,
        size: 4,
        align: 2,
        format: "[2;{ uint16 }]",
    };

    const bytes = await encodeInputJson(array, [[7], [9]]);
    expect(await decodeOutput(bytes, array)).toEqual([[7], [9]]);
});

test("typed codec encodes an empty struct as one zero byte", async () => {
    const schema: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 1,
        align: 1,
        format: "",
        fields: [],
    };

    expect(await encodeInputJson(schema, {})).toEqual(Uint8Array.of(0));
    expect(await decodeOutput(Uint8Array.of(0), schema)).toEqual([]);
    await expect(decodeOutput(new Uint8Array(0), schema)).rejects.toThrow(RangeError);
});

test("typed codec accepts a zero-length array", async () => {
    const schema: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 0,
        align: 1,
        format: "wrong",
        fields: [
            {
                name: "values",
                offset: 0,
                size: 0,
                type: {
                    kind: AbiTypeKind.ARRAY,
                    count: 0,
                    size: 0,
                    align: 1,
                    format: "wrong",
                    element: {
                        kind: AbiTypeKind.SCALAR,
                        scalar: AbiScalarKind.UINT8,
                        size: 1,
                        align: 1,
                        format: "wrong",
                    },
                },
            },
        ],
    };

    const bytes = await encodeInputJson(schema, { values: [] });
    expect(bytes).toEqual(new Uint8Array());
    expect(await decodeOutput(bytes, schema)).toEqual([]);
});

test("overlapping input fields require one raw union view", async () => {
    const union: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 8,
        align: 8,
        format: "wrong",
        fields: [
            {
                name: "wide",
                offset: 0,
                size: 8,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT64,
                    size: 8,
                    align: 8,
                    format: "wrong",
                },
            },
            {
                name: "narrow",
                offset: 0,
                size: 4,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT32,
                    size: 4,
                    align: 4,
                    format: "wrong",
                },
            },
        ],
    };

    await expect(encodeInputJson(union, { wide: 1n, narrow: 2 })).rejects.toThrow(/raw bytes/);

    const raw = new Uint8Array([5, 0, 0, 0, 0, 0, 0, 0]);
    expect(await encodeInputJson(union, raw)).toEqual(raw);
    expect(await encodeInputJson(union, [...raw])).toEqual(raw);
    await expect(encodeInputJson(union, [256, 0, 0, 0, 0, 0, 0, 0])).rejects.toThrow(/0 to 255/);
    expect(await decodeOutput(raw, union)).toEqual([5n, 5]);
});

test("typed container decode keeps nested field offsets", async () => {
    const value: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 24,
        align: 8,
        format: "wrong",
        fields: [
            {
                name: "tag",
                offset: 0,
                size: 1,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT8,
                    size: 1,
                    align: 1,
                    format: "wrong",
                },
            },
            {
                name: "amount",
                offset: 16,
                size: 8,
                type: {
                    kind: AbiTypeKind.SCALAR,
                    scalar: AbiScalarKind.UINT64,
                    size: 8,
                    align: 8,
                    format: "wrong",
                },
            },
        ],
    };
    const map: AbiType = {
        kind: AbiTypeKind.HASH_MAP,
        capacity: 1,
        key: {
            kind: AbiTypeKind.SCALAR,
            scalar: AbiScalarKind.UINT8,
            size: 1,
            align: 1,
            format: "wrong",
        },
        value,
        size: 56,
        align: 8,
        format: "wrong",
    };
    const bytes = new Uint8Array(map.size);
    const view = new DataView(bytes.buffer);
    view.setUint8(0, 3);
    view.setUint8(8, 7);
    view.setBigUint64(24, 99n, true);
    view.setBigUint64(32, 1n, true);
    view.setBigUint64(40, 1n, true);

    expect(await decodeOutput(bytes, map)).toEqual([{ slot: 0, key: 3, value: [7, 99n] }]);
});

test("typed BitArray encodes logical bits LSB-first and ignores padding", async () => {
    const bitArray: AbiType = {
        kind: AbiTypeKind.BIT_ARRAY,
        bitCount: 128,
        size: 16,
        align: 8,
        format: "wrong",
    };
    const bits = Array.from({ length: 128 }, () => 0);
    bits[0] = 1;
    bits[63] = 1;
    bits[64] = 1;
    bits[127] = 1;

    const bytes = await encodeInputJson(bitArray, bits);
    expect(new DataView(bytes.buffer).getBigUint64(0, true)).toBe((1n << 63n) | 1n);
    expect(new DataView(bytes.buffer).getBigUint64(8, true)).toBe((1n << 63n) | 1n);
    expect(await decodeOutput(bytes, bitArray)).toEqual(bits);
    expect(jsonToInputFormat(bitArray, bits)).toBe("[2; 9223372036854775809uint64, 9223372036854775809uint64]");
    expect(zeroInputFormat(bitArray)).toBe("[2; 0uint64 ×2]");
    expect(hasOverlappingAbiType(bitArray)).toBe(false);

    expect(
        await decodeOutput(new Uint8Array(8).fill(0xff), {
            ...bitArray,
            bitCount: 2,
            size: 8,
        }),
    ).toEqual([1, 1]);

    await expect(encodeInputJson(bitArray, bits.slice(1))).rejects.toThrow(/expects 128 bits/);
    const invalid = [...bits];
    invalid[3] = 2;
    await expect(encodeInputJson(bitArray, invalid)).rejects.toThrow(/bit 3 must be 0 or 1/);
    const booleanBits: unknown[] = [...bits];
    booleanBits[3] = true;
    await expect(encodeInputJson(bitArray, booleanBits)).rejects.toThrow(/bit 3 must be 0 or 1/);
});

test("typed LinkedList decodes logical order and rejects public input", async () => {
    const value: AbiType = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "uint64",
    };
    const geometry = linkedListGeometry(value, 8);
    const linkedList: AbiType = {
        kind: AbiTypeKind.LINKED_LIST,
        capacity: 8,
        value,
        size: geometry.size,
        align: geometry.align,
        format: "wrong",
    };
    const bytes = new Uint8Array(geometry.size);
    const view = new DataView(bytes.buffer);
    const setNode = (slot: number, item: bigint, next: bigint, previous: bigint) => {
        const offset = slot * geometry.nodeStride;
        view.setBigUint64(offset, item, true);
        view.setBigInt64(offset + geometry.nextOffset, next, true);
        view.setBigInt64(offset + geometry.prevOffset, previous, true);
    };
    setNode(5, 50n, 1n, -1n);
    setNode(1, 10n, -1n, 5n);
    bytes[geometry.flagsOffset] = (1 << 5) | (1 << 1);
    view.setBigInt64(geometry.headOffset, 5n, true);
    view.setBigInt64(geometry.tailOffset, 1n, true);
    view.setBigUint64(geometry.populationOffset, 2n, true);

    expect(await decodeOutput(bytes, linkedList)).toEqual([
        { slot: 5, value: 50n },
        { slot: 1, value: 10n },
    ]);
    await expect(encodeInputJson(linkedList, bytes)).rejects.toThrow(/linked_list input is not supported/);
    expect(() => jsonToInputFormat(linkedList, [])).toThrow(/linked_list input is not supported/);
});

test("nested LinkedList cannot bypass an overlapping struct raw input", async () => {
    const value: AbiType = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "uint64",
    };
    const geometry = linkedListGeometry(value, 8);
    const linkedList: AbiType = {
        kind: AbiTypeKind.LINKED_LIST,
        capacity: 8,
        value,
        size: geometry.size,
        align: geometry.align,
        format: "wrong",
    };
    const overlapping: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: geometry.size,
        align: 8,
        format: "wrong",
        fields: [
            {
                name: "items",
                offset: 0,
                size: geometry.size,
                type: linkedList,
            },
            {
                name: "raw",
                offset: 0,
                size: geometry.size,
                type: {
                    kind: AbiTypeKind.ARRAY,
                    count: geometry.size,
                    size: geometry.size,
                    align: 1,
                    format: "wrong",
                    element: {
                        kind: AbiTypeKind.SCALAR,
                        scalar: AbiScalarKind.UINT8,
                        size: 1,
                        align: 1,
                        format: "uint8",
                    },
                },
            },
        ],
    };
    const raw = new Uint8Array(overlapping.size);

    expect(hasOverlappingAbiType(overlapping)).toBe(true);
    await expect(encodeInputJson(overlapping, raw)).rejects.toThrow(/linked_list input is not supported/);
    expect(() => jsonToInputFormat(overlapping, raw)).toThrow(/linked_list input is not supported/);
});

test("nested LinkedList cannot bypass opaque container raw inputs", async () => {
    const scalar: AbiType = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "uint64",
    };
    const geometry = linkedListGeometry(scalar, 8);
    const linkedList: AbiType = {
        kind: AbiTypeKind.LINKED_LIST,
        capacity: 8,
        value: scalar,
        size: geometry.size,
        align: geometry.align,
        format: "wrong",
    };
    const containers: AbiType[] = [
        {
            kind: AbiTypeKind.HASH_MAP,
            capacity: 1,
            key: scalar,
            value: linkedList,
            size: 272,
            align: 8,
            format: "wrong",
        },
        {
            kind: AbiTypeKind.HASH_SET,
            capacity: 1,
            key: linkedList,
            size: 264,
            align: 8,
            format: "wrong",
        },
        {
            kind: AbiTypeKind.COLLECTION,
            capacity: 1,
            value: linkedList,
            size: 368,
            align: 8,
            format: "wrong",
        },
    ];

    for (const container of containers) {
        const raw = new Uint8Array(container.size);
        await expect(encodeInputJson(container, raw)).rejects.toThrow(/linked_list input is not supported/);
        expect(() => jsonToInputFormat(container, raw)).toThrow(/linked_list input is not supported/);
    }
});
