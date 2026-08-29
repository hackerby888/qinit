// The typed encode path (an AbiType rather than a format string) reaches its own validation: the
// string dialect's tests never run these branches, so a dropped range or identity check survives there.
import { test, expect } from "bun:test";
import { encodeInputJson, decodeOutput, zeroInputFormat, encodeInput } from "../../src/abi-fmt";
import { AbiScalarKind, AbiTypeKind, type AbiStruct, type AbiType } from "../../src/contract-idl";
import { arr, bit, named, st, u8, u32, u64, i32, id, validated } from "./abi-builders";

const scalarField = (scalar: AbiScalarKind, size: number, align: number): AbiType => ({
    kind: AbiTypeKind.SCALAR,
    scalar,
    size,
    align,
    format: scalar,
});

test("the typed path range-checks every scalar width, not just the string dialect", async () => {
    const cases: [AbiScalarKind, number, number, unknown, string][] = [
        [AbiScalarKind.UINT8, 1, 1, 256, "uint8 out of range: 256 (allowed 0..255)"],
        [AbiScalarKind.SINT8, 1, 1, -129, "sint8 out of range: -129 (allowed -128..127)"],
        [AbiScalarKind.UINT16, 2, 2, 65536, "uint16 out of range: 65536 (allowed 0..65535)"],
        [AbiScalarKind.SINT32, 4, 4, -2147483649, "sint32 out of range: -2147483649 (allowed -2147483648..2147483647)"],
        [AbiScalarKind.UINT64, 8, 8, "18446744073709551616", "uint64 out of range: 18446744073709551616 (allowed 0..18446744073709551615)"],
        [AbiScalarKind.UINT128, 16, 8, (1n << 128n).toString(), "uint128 out of range"],
        [AbiScalarKind.SINT128, 16, 8, (-(1n << 127n) - 1n).toString(), "sint128 out of range"],
    ];

    for (const [scalar, size, align, value, message] of cases) {
        await expect(encodeInputJson(st(scalarField(scalar, size, align)), { f0: value })).rejects.toThrow(message);
    }
});

test("the typed path keeps each scalar's extremes encodable", async () => {
    const widest = named(["u", u64], ["s", i32]);
    const bytes = await encodeInputJson(widest, { u: "18446744073709551615", s: -2147483648 });

    expect(await decodeOutput(bytes, widest)).toEqual([18446744073709551615n, -2147483648]);
});

test("a typed bit takes only 0 and 1, however the value arrives", async () => {
    const flags = named(["b", bit]);

    expect(await encodeInputJson(flags, { b: true })).toEqual(new Uint8Array([1]));
    expect(await encodeInputJson(flags, { b: 0 })).toEqual(new Uint8Array([0]));
    await expect(encodeInputJson(flags, { b: 2 })).rejects.toThrow("bit out of range: 2 (allowed 0..1)");
    await expect(encodeInputJson(flags, { b: -1 })).rejects.toThrow("bit out of range: -1 (allowed 0..1)");
});

test("a typed id needs a full 60-character identity, not merely capital letters", async () => {
    const target = named(["dst", id]);

    expect(await encodeInputJson(target, { dst: "A".repeat(60) })).toEqual(new Uint8Array(32));
    await expect(encodeInputJson(target, { dst: "A".repeat(59) })).rejects.toThrow("id must be a 60-char identity");
    await expect(encodeInputJson(target, { dst: "A".repeat(61) })).rejects.toThrow("id must be a 60-char identity");
    await expect(encodeInputJson(target, { dst: "a".repeat(60) })).rejects.toThrow("id must be a 60-char identity");
});

test("a zero-length array field shares an offset without making the struct a union", async () => {
    const schema: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 4,
        align: 4,
        format: "",
        fields: [
            { name: "empty", offset: 0, size: 0, type: { ...arr(u8, 0), format: "[0;uint8]" } },
            { name: "value", offset: 0, size: 4, type: u32 },
        ],
    };

    // Both fields start at 0, but the empty one occupies nothing — so this stays a named struct.
    const bytes = await encodeInputJson(schema, { empty: [], value: 7 });
    expect(bytes).toEqual(new Uint8Array([7, 0, 0, 0]));
    expect(zeroInputFormat(schema)).toBe("[0; 0uint8 ×0], 0uint32");
});

test("zeroInputFormat falls back to raw bytes for a genuinely overlapping type", () => {
    const union: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 8,
        align: 8,
        format: "",
        fields: [
            { name: "wide", offset: 0, size: 8, type: u64 },
            { name: "narrow", offset: 0, size: 4, type: u32 },
        ],
    };

    expect(zeroInputFormat(union)).toBe("[8; 0uint8 ×8]");
    expect(zeroInputFormat({ ...arr(union, 2), format: "" })).toBe("[16; 0uint8 ×16]");
});

test("a positional typed input must carry exactly one value per field", async () => {
    const point = named(["x", i32], ["y", i32]);

    expect(await encodeInputJson(point, [1, 2])).toEqual(await encodeInputJson(point, { x: 1, y: 2 }));
    await expect(encodeInputJson(point, [1])).rejects.toThrow("expects 2 values, got 1");
    await expect(encodeInputJson(point, [1, 2, 3])).rejects.toThrow("expects 2 values, got 3");
    await expect(encodeInputJson(point, { x: 1 })).rejects.toThrow("missing input field 'y'");
});

test("a three-level typed input agrees byte-for-byte with the value dialect it prints", async () => {
    const inner = named(["flag", u8], ["wide", u64]);
    const middle = named(["items", validated(arr(inner, 2))], ["tag", u32]);
    const outer = named(["body", middle], ["trailer", u8]);

    const json = {
        body: {
            items: [
                { flag: 1, wide: "1" },
                { flag: 2, wide: "2" },
            ],
            tag: 9,
        },
        trailer: 3,
    };

    const typed = await encodeInputJson(outer, json);
    const dialect = await encodeInput("{ { [2; { 1uint8, 1uint64 }, { 2uint8, 2uint64 } ], 9uint32 }, 3uint8 }");

    expect(typed).toEqual(dialect);
    expect(await decodeOutput(typed, outer)).toEqual([
        [
            [
                [1, 1n],
                [2, 2n],
            ],
            9,
        ],
        3,
    ]);
});
