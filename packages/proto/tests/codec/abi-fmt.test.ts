import { test, expect } from "bun:test";
import { checkInputSize, encodeInput, decodeOutput, decodeAbiValue, structFieldOffsets, layoutOf, parseLayout, zeroInputFormat } from "../../src/abi-fmt";
import { formatAbiType, type AbiType } from "../../src/contract-idl";
import { arr, ba, bit, co, hm, hs, i8, i16, i32, i64, i128, id, ll, m256i, st, u8, u16, u32, u64, u128, validated } from "./abi-builders";

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const bytes = (h: string) => new Uint8Array((h.match(/../g) ?? []).map((x) => parseInt(x, 16)));

test("uint64 round-trip", async () => {
    const b = await encodeInput("42uint64");
    expect(b.length).toBe(8);
    expect(await decodeOutput(b, "uint64")).toBe(42n);
});

test("smaller scalars", async () => {
    expect(await decodeOutput(await encodeInput("7uint8"), "uint8")).toBe(7);
    expect(await decodeOutput(await encodeInput("258uint16"), "uint16")).toBe(258);
    expect(await decodeOutput(await encodeInput("70000uint32"), "uint32")).toBe(70000);
});

test("signed sint64 negative", async () => {
    expect(await decodeOutput(await encodeInput("-5sint64"), "sint64")).toBe(-5n);
    expect(await decodeOutput(await encodeInput("-1sint32"), "sint32")).toBe(-1);
});

test("uint128 round-trip uses low@0 and high@8 without Number precision loss", async () => {
    const max = (1n << 128n) - 1n;
    const b = await encodeInput(`${max}uint128`);
    expect(b.length).toBe(16);
    expect(hex(b)).toBe("ff".repeat(16));
    expect(await decodeOutput(b, "uint128")).toBe(max);

    const limbs = await encodeInput(`${(2n << 64n) + 3n}uint128`);
    expect(hex(limbs)).toBe("03000000000000000200000000000000");
    expect(await decodeOutput(limbs, "uint128")).toBe((2n << 64n) + 3n);
});

test("uint128 rejects negative and overflowing values", async () => {
    await expect(encodeInput("-1uint128")).rejects.toThrow(/out of range/);
    await expect(encodeInput(`${1n << 128n}uint128`)).rejects.toThrow(/out of range/);
});

test("natural alignment: {uint16, uint32} pads uint32 to offset 4", async () => {
    const b = await encodeInput("5uint16, 7uint32");
    expect(hex(b)).toBe("0500" + "0000" + "07000000"); // val, pad, val
    expect(await decodeOutput(b, "uint16, uint32")).toEqual([5, 7]);
});

test("struct round-trip", async () => {
    const b = await encodeInput("{ 1uint64, 2uint16 }");
    expect(await decodeOutput(b, "{ uint64, uint16 }")).toEqual([1n, 2]);
});

test("array round-trip", async () => {
    const b = await encodeInput("[2; 1uint64, 2uint64]");
    expect(b.length).toBe(16);
    expect(await decodeOutput(b, "[2; uint64]")).toEqual([1n, 2n]);
});

test("nested: array of structs", async () => {
    const b = await encodeInput("[2; { 1uint32, 2uint32 }, { 3uint32, 4uint32 }]");
    expect(await decodeOutput(b, "[2; { uint32, uint32 }]")).toEqual([
        [1, 2],
        [3, 4],
    ]);
});

test("id round-trip (32-byte pubkey <-> 60-char identity)", async () => {
    const pub = "1f590d03e613bdded38b4c0820ac44615f91af12435980b3ede3c08c315a2544";
    const id = await decodeOutput(bytes(pub), "id");
    expect(id).toMatch(/^[A-Z]{60}$/);
    expect(hex(await encodeInput(id + "id"))).toBe(pub);
});

test("empty structs encode and decode as one zero byte", async () => {
    expect(await encodeInput("")).toEqual(Uint8Array.of(0));
    expect(await encodeInput("{}")).toEqual(Uint8Array.of(0));
    expect(layoutOf("")).toEqual({ size: 1, align: 1 });
    expect(layoutOf("{}")).toEqual({ size: 1, align: 1 });
    expect(await decodeOutput(Uint8Array.of(0), "")).toEqual([]);
    await expect(decodeOutput(new Uint8Array(0), "")).rejects.toThrow(RangeError);
});

test("nested and arrayed empty structs use one-byte stride", async () => {
    const nested = await encodeInput("{}, 7uint8");
    expect(nested).toEqual(Uint8Array.of(0, 7));
    expect(await decodeOutput(nested, "{}, uint8")).toEqual([[], 7]);
    expect(structFieldOffsets("{}, uint8")).toEqual([
        { off: 0, size: 1 },
        { off: 1, size: 1 },
    ]);

    const array = await encodeInput("[3; {}, {}, {}]");
    expect(array).toEqual(Uint8Array.of(0, 0, 0));
    expect(layoutOf("[3;{}]")).toEqual({ size: 3, align: 1 });
    expect(await decodeOutput(array, "[3;{}]")).toEqual([[], [], []]);
});

test("zero-length arrays remain zero bytes", async () => {
    expect(layoutOf("[0;uint8]")).toEqual({ size: 0, align: 1 });
    expect(await encodeInput("[0;]")).toEqual(new Uint8Array(0));
    expect(await decodeOutput(new Uint8Array(0), "[0;uint8]")).toEqual([]);
});

test("m256i (digest) round-trips as hex, not an identity", async () => {
    const dg = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";
    const b = await encodeInput(dg + "m256i");
    expect(b.length).toBe(32);
    expect(await decodeOutput(b, "m256i")).toBe(dg);
});

test("id and m256i accept compact zero values", async () => {
    expect(await encodeInput("0id")).toEqual(new Uint8Array(32));
    expect(await encodeInput("0m256i")).toEqual(new Uint8Array(32));
});

test("deep nested: array of structs with an inner array", async () => {
    const b = await encodeInput("[2; { 1uint32, [2; 2uint16, 3uint16] }, { 4uint32, [2; 5uint16, 6uint16] }]");
    expect(await decodeOutput(b, "[2; { uint32, [2; uint16] }]")).toEqual([
        [1, [2, 3]],
        [4, [5, 6]],
    ]);
});

test("rejects a malformed id (not 60-char identity nor 64-hex)", async () => {
    await expect(encodeInput("abcid")).rejects.toThrow(/id must be/);
    await expect(encodeInput("1id")).rejects.toThrow(/id must be/);
    await expect(encodeInput("notavalidlowercaseidentitynotavalidlowercaseidentitynotavaid")).rejects.toThrow(/id must be/);
});

test("rejects a malformed m256i (not 64 hex)", async () => {
    await expect(encodeInput("zzzm256i")).rejects.toThrow(/m256i must be/);
    await expect(encodeInput("1m256i")).rejects.toThrow(/m256i must be/);
    await expect(encodeInput("00112233m256i")).rejects.toThrow(/m256i must be/);
});

test("rejects scalar out of range / bad bit", async () => {
    await expect(encodeInput("300uint8")).rejects.toThrow(/out of range/);
    await expect(encodeInput("-1uint8")).rejects.toThrow(/out of range/);
    await expect(encodeInput("70000uint16")).rejects.toThrow(/out of range/);
    await expect(encodeInput("2bit")).rejects.toThrow(/bit must be/);
});

test("bit round-trips 0/1", async () => {
    expect(await decodeOutput(await encodeInput("1bit"), "bit")).toBe(1);
    expect(await decodeOutput(await encodeInput("0bit"), "bit")).toBe(0);
});

// ---- structFieldOffsets / layoutOf / parseLayout: the alignment math decode-log + state-diff rely on ----
test("structFieldOffsets: internal padding (uint8 then uint64 lands at 8)", () => {
    expect(structFieldOffsets("uint8, uint64")).toEqual([
        { off: 0, size: 1 },
        { off: 8, size: 8 },
    ]);
    expect(structFieldOffsets("uint64, uint8")).toEqual([
        { off: 0, size: 8 },
        { off: 8, size: 1 },
    ]);
});

test("structFieldOffsets: a nested struct field is aligned + sized as a unit", () => {
    // uint32@0(4), then {uint8,uint64} (align 8, size 16) @8
    expect(structFieldOffsets("uint32, { uint8, uint64 }")).toEqual([
        { off: 0, size: 4 },
        { off: 8, size: 16 },
    ]);
});

test("layoutOf: TAIL padding included (sizeof != end-of-last-field)", () => {
    expect(layoutOf("{ uint64, uint8 }")).toEqual({ size: 16, align: 8 }); // 9 bytes used -> padded to 16
    expect(layoutOf("uint8")).toEqual({ size: 1, align: 1 });
    expect(layoutOf("m256i")).toEqual({ size: 32, align: 8 });
    expect(layoutOf("uint128")).toEqual({ size: 16, align: 8 });
    expect(layoutOf("[3;uint16]")).toEqual({ size: 6, align: 2 }); // 3 * stride(2)
});

test("layoutOf: HashMap<id,uint64,1024> expansion sizeof = 41232 (matches C++ StateData)", () => {
    // [1024;{id,uint64}]=40960 + [32;uint64] flags=256 + uint64 + uint64 = 41232 (DbgMap marker offset)
    expect(layoutOf("{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }").size).toBe(41232);
});

test("parseLayout: empty -> empty struct; unknown type throws", () => {
    expect(parseLayout("")).toEqual({ kind: "struct", fields: [] });
    expect(() => parseLayout("notatype")).toThrow(/unknown type/);
});

test("decodeOutput on a truncated buffer throws (out-of-bounds read)", async () => {
    await expect(decodeOutput(new Uint8Array(4), "uint64")).rejects.toThrow(); // needs 8 bytes
});

test("repeat shorthand: ×N expands to N copies (array, byte-exact + == hand-expanded)", async () => {
    const short = await encodeInput("[4; 9uint32 ×4]");
    const long = await encodeInput("[4; 9uint32, 9uint32, 9uint32, 9uint32]");
    expect(hex(short)).toBe(hex(long));
    expect(hex(short)).toBe("09000000".repeat(4));
    expect(await decodeOutput(short, "[4; uint32]")).toEqual([9, 9, 9, 9]);
});

test("repeat shorthand: x and * variants, spaces optional (9uint32x32 valid)", async () => {
    const ref = await encodeInput("[3; 7uint64, 7uint64, 7uint64]");
    expect(hex(await encodeInput("[3; 7uint64x3]"))).toBe(hex(ref)); // bare x, no space
    expect(hex(await encodeInput("[3; 7uint64 * 3]"))).toBe(hex(ref)); // * with spaces
    expect(hex(await encodeInput("[3; 7uint64×3]"))).toBe(hex(ref)); // × no space
    expect((await encodeInput("[64; 0uint64 ×64]")).length).toBe(64 * 8); // the RANDOM reveal case
});

test("repeat shorthand: struct + top-level reps; non-repeat tokens untouched", async () => {
    const ref = await encodeInput("{1uint32, 2uint32}, {1uint32, 2uint32}, 5uint64");
    expect(hex(await encodeInput("{1uint32, 2uint32} ×2, 5uint64"))).toBe(hex(ref)); // struct repeat
    expect(hex(await encodeInput("5uint64 ×3"))).toBe(hex(await encodeInput("5uint64, 5uint64, 5uint64")));
    expect((await encodeInput("ee".repeat(32) + "id")).length).toBe(32); // 64-hex id (no x): unaffected
});

test("zeroInputFormat: builds a schema-matched all-zero sample (scalar/id/array/struct)", async () => {
    expect(zeroInputFormat("uint64")).toBe("0uint64");
    expect(zeroInputFormat("[64; uint64], id")).toBe("[64; 0uint64 ×64], 0id");
    expect(zeroInputFormat("{ uint32, id }")).toBe("0uint32, 0id"); // top-level struct -> implicit field list (no braces, encodeInput-consistent)
    expect(zeroInputFormat("uint16, uint32")).toBe("0uint16, 0uint32");
    expect(zeroInputFormat("m256i")).toBe("0m256i");
    expect(zeroInputFormat("uint128")).toBe("0uint128");
});

test("zeroInputFormat: the sample is valid input — encodes to exactly the layout size", async () => {
    for (const fmt of ["uint64", "uint128", "[64; uint64], id", "{ uint32, id }", "uint16, uint32", "m256i", "[3; { uint8, uint64 }]"]) {
        const sample = zeroInputFormat(fmt);
        const b = await encodeInput(sample);
        expect(hex(b)).toBe("00".repeat(b.length));
        expect(b.length).toBe(layoutOf(fmt).size); // matches the entry's input scheme byte-for-byte
    }
});

// ---- grammar rejections: a malformed layout must name what is wrong, not crash or corrupt silently ----
test("parseLayout rejects a malformed array instead of looping or yielding NaN", () => {
    expect(() => parseLayout("[2 uint8]")).toThrow(/array needs a ';'/); // used to recurse until the stack blew
    expect(() => parseLayout("[abc; uint8]")).toThrow(/array count 'abc' must be a non-negative integer/);
    expect(() => layoutOf("[-3;uint8]")).toThrow(/array count '-3' must be a non-negative integer/);
    expect(() => layoutOf("[1.5;uint8]")).toThrow(/array count '1.5' must be a non-negative integer/);
    expect(() => parseLayout("[2;uint8")).toThrow(/array is missing its closing ']'/);
});

test("parseLayout names an unterminated struct and a stray delimiter", () => {
    expect(() => parseLayout("{uint64")).toThrow(/struct is missing its closing '}'/);
    expect(() => parseLayout("}")).toThrow(/expected a type at position 0/);
    expect(parseLayout("{ uint8, }")).toEqual({ kind: "struct", fields: [parseLayout("uint8")] }); // a trailing comma stays legal
    expect(() => parseLayout("notatype")).toThrow(/unknown type/); // still the message for a real typo
});

test("encodeInput rejects an array whose declared count does not match its values", async () => {
    await expect(encodeInput("[5; 1uint8]")).rejects.toThrow(/array of 5 needs 5 values, got 1/);
    await expect(encodeInput("[0; 1uint8, 2uint8]")).rejects.toThrow(/array of 0 needs 0 values, got 2/);
    await expect(encodeInput("[2;{}]")).rejects.toThrow(/array of 2 needs 2 values, got 1/);
});

test("the count check counts values after ×N expansion, so the existing shorthands still pass", async () => {
    expect(await encodeInput("[0;]")).toEqual(new Uint8Array(0));
    expect((await encodeInput("[3; {}, {}, {}]")).length).toBe(3);
    expect((await encodeInput("[64; 0uint64 ×64]")).length).toBe(512);
    expect((await encodeInput("[2; 1uint128 ×2]")).length).toBe(32);
    expect((await encodeInput("[4; 9uint32 ×4]")).length).toBe(16);
});

// ---- sint128: a valid AbiScalarKind that the string dialect used to reject outright ----
test("sint128 parses, sizes, and round-trips as a signed 128-bit value", async () => {
    expect(parseLayout("sint128")).toEqual({ kind: "sint128" });
    expect(layoutOf("sint128")).toEqual({ size: 16, align: 8 });

    expect(await decodeOutput(new Uint8Array(16).fill(0xff), "sint128")).toBe(-1n);
    expect(hex(await encodeInput("-1sint128"))).toBe("ff".repeat(16));

    const min = -(1n << 127n);
    const max = (1n << 127n) - 1n;
    expect(await decodeOutput(await encodeInput(`${min}sint128`), "sint128")).toBe(min);
    expect(await decodeOutput(await encodeInput(`${max}sint128`), "sint128")).toBe(max);
});

test("sint128 rejects values outside the signed range and non-integers", async () => {
    await expect(encodeInput(`${1n << 127n}sint128`)).rejects.toThrow(/out of range/);
    await expect(encodeInput(`${-(1n << 127n) - 1n}sint128`)).rejects.toThrow(/out of range/);
    await expect(encodeInput("1.5sint128")).rejects.toThrow(/sint128 must be an integer/);
});

test("sint128 aligns and pads like uint128 inside a struct", async () => {
    expect(layoutOf("{ uint8, sint128 }")).toEqual({ size: 24, align: 8 }); // uint8@0, sint128@8, no tail padding needed
    expect(structFieldOffsets("sint128, uint8")).toEqual([
        { off: 0, size: 16 },
        { off: 16, size: 1 },
    ]);
    expect(zeroInputFormat("sint128")).toBe("0sint128");
    expect(zeroInputFormat("[2;sint128]")).toBe("[2; 0sint128 ×2]");
    expect((await encodeInput("[2; 0sint128 ×2]")).length).toBe(32);
});

// ---- properties: the three layers (qpi-layout geometry, formatAbiType, the string parser) must agree ----
// Each row is a type built from the geometry oracle, run through parseContractIdl, then re-parsed from
// its own format string. Any drift between the C++ mirror and the grammar fails here first.
const LAYOUT_ROWS: [label: string, type: AbiType, size: number, align: number, format?: string][] = [
    ["HashMap with a struct key and a LinkedList value", hm(st(arr(id, 2), u64), ll(u64, 2), 2), 360, 8],
    ["Collection of a struct holding a BitArray and a uint128", co(st(ba(64), u128), 2), 280, 8],
    ["LinkedList of HashMap", ll(hm(u8, u8, 2), 2), 144, 8],
    ["array of HashMap of BitArray", arr(hm(id, ba(64), 2), 2), 208, 8, "[2;{ [2;{ id, [1;uint64] }], [1;uint64], uint64, uint64 }]"],
    ["HashMap whose value is a Collection", hm(u8, co(u8, 2), 2), 536, 8],
    ["HashMap whose key is a HashMap", hm(hm(u8, u8, 2), u8, 2), 104, 8],
    ["HashSet of a struct with record-stride padding", hs(st(u64, u8), 4), 88, 8, "{ [4;{ uint64, uint8 }], [1;uint64], uint64, uint64 }"],
    ["HashSet of a struct holding an array", hs(st(u8, arr(u16, 4)), 4), 64, 8, "{ [4;{ uint8, [4;uint16] }], [1;uint64], uint64, uint64 }"],
    ["array of array of struct", arr(arr(st(u8, u64), 2), 2), 64, 8, "[2;[2;{ uint8, uint64 }]]"],
    ["a container between two scalars", st(u8, hm(u8, u64, 2), u16), 72, 8, "{ uint8, { [2;{ uint8, uint64 }], [1;uint64], uint64, uint64 }, uint16 }"],
    ["four nested structs, padding forced at each level", st(u8, st(u16, st(u32, st(u8, u64)))), 40, 8, "{ uint8, { uint16, { uint32, { uint8, uint64 } } } }"],
    ["a one-bit BitArray still costs a whole word", ba(1), 8, 8, "[1;uint64]"],
    ["a 1024-bit BitArray is sixteen words", ba(1024), 128, 8, "[16;uint64]"],
];

test("every container kind's format string re-parses to its own size and alignment", () => {
    for (const [label, raw, size, align, format] of LAYOUT_ROWS) {
        const type = validated(raw);
        expect(`${label}: ${type.size}/${type.align}`).toBe(`${label}: ${size}/${align}`);
        expect(`${label}: ${JSON.stringify(layoutOf(formatAbiType(type)))}`).toBe(`${label}: ${JSON.stringify({ size, align })}`);
        if (format !== undefined) {
            expect(formatAbiType(type)).toBe(format);
        }
    }
});

// The two decoders share no code: one walks a TypeNode it parsed from a string, the other walks the
// IDL's own offsets. Container roots are excluded — the typed path returns {slot,key,value} entries there.
const CROSS_PATH_ROWS: [label: string, type: AbiType, size: number, format: string][] = [
    [
        "every scalar width in one struct",
        st(bit, i8, u16, i16, u32, i32, u64, i64, u128, i128, id, m256i),
        128,
        "{ bit, sint8, uint16, sint16, uint32, sint32, uint64, sint64, uint128, sint128, id, m256i }",
    ],
    ["array of struct with an inner array and an id", arr(st(u8, arr(st(u16, u8), 2), id), 2), 96, "[2;{ uint8, [2;{ uint16, uint8 }], id }]"],
    ["four levels ending in an array", st(u8, st(u16, st(u32, st(u8, arr(u64, 2))))), 48, "{ uint8, { uint16, { uint32, { uint8, [2;uint64] } } } }"],
    ["empty structs as a field, an element, and a neighbour", st(st(), arr(st(), 3), u8), 5, "{ {}, [3;{}], uint8 }"],
];

test("the string and typed decoders agree on the same bytes", async () => {
    for (const [label, raw, size, format] of CROSS_PATH_ROWS) {
        const type = validated(raw);
        expect(`${label}: ${type.size} ${formatAbiType(type)}`).toBe(`${label}: ${size} ${format}`);

        const bytes = new Uint8Array(type.size);
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = (index * 37 + 11) & 0xff;
        }
        expect(await decodeOutput(bytes, format)).toEqual(await decodeAbiValue(bytes, type));
    }
});

test("the decoders read the same wide scalars, not just the same shape", async () => {
    const type = validated(st(bit, i8, u16, i16, u32, i32, u64, i64, u128, i128, id, m256i));
    const bytes = new Uint8Array(type.size);
    for (let index = 0; index < bytes.length; index++) {
        bytes[index] = (index * 37 + 11) & 0xff;
    }

    const decoded = await decodeAbiValue(bytes, type);
    expect(decoded.slice(0, 10)).toEqual([
        11,
        48,
        31317,
        -15201,
        2726123571,
        907144391,
        6789480933367316571n,
        -8763657326330795901n,
        285376675360240156043455777163709894827n,
        50520332810868806498481338092594995451n, // sint128 stays positive below 2^127
    ]);
    expect(decoded[10]).toMatch(/^[A-Z]{60}$/); // id renders as an identity
    expect(decoded[11]).toMatch(/^[0-9a-f]{64}$/); // m256i stays raw hex
});

// zeroInputFormat is the sample a user gets back when their --in fails to parse, so it has to be
// valid input for the very layout it was built from: same byte count, all zeros.
const ZERO_ROWS: [fmt: string, sample: string, size: number][] = [
    ["{}", "", 1],
    ["[0;uint8]", "[0; 0uint8 ×0]", 0],
    ["[2;{}]", "[2; {  } ×2]", 2],
    ["{ {}, {} }", "{  }, {  }", 2],
    ["[3;{ {} }]", "[3; { {  } } ×3]", 3],
    ["{ uint8, [3;{ uint16, uint8 }], id }", "0uint8, [3; { 0uint16, 0uint8 } ×3], 0id", 48],
    ["[2;[2;{ uint8, uint64 }]]", "[2; [2; { 0uint8, 0uint64 } ×2] ×2]", 64],
    ["{ uint8, { uint16, { uint32, { uint8, uint64 } } } }", "0uint8, { 0uint16, { 0uint32, { 0uint8, 0uint64 } } }", 40],
    ["[2;{ id, [1;uint64] }]", "[2; { 0id, [1; 0uint64 ×1] } ×2]", 80],
    ["uint128, uint8", "0uint128, 0uint8", 24],
    ["m256i, uint8, id", "0m256i, 0uint8, 0id", 72],
    ["bit, uint64", "0bit, 0uint64", 16],
    ["[64;bit]", "[64; 0bit ×64]", 64],
    ["{ uint8, m256i }", "0uint8, 0m256i", 40],
    ["sint128", "0sint128", 16],
    ["{ sint128, uint8 }", "0sint128, 0uint8", 24],
];

test("zeroInputFormat emits a valid all-zero sample for every nesting shape", async () => {
    for (const [fmt, sample, size] of ZERO_ROWS) {
        expect(`${fmt} -> ${zeroInputFormat(fmt)}`).toBe(`${fmt} -> ${sample}`);
        expect(`${fmt}: ${layoutOf(fmt).size}`).toBe(`${fmt}: ${size}`);

        const bytes = await encodeInput(sample);
        expect(`${fmt}: ${bytes.length}`).toBe(`${fmt}: ${size}`);
        expect(bytes.every((byte) => byte === 0)).toBe(true);
    }
});

test("zeroInputFormat reaches the same sample through a type string and through an AbiType", () => {
    for (const [, raw] of LAYOUT_ROWS) {
        const type = validated(raw);
        expect(zeroInputFormat(type)).toBe(zeroInputFormat(formatAbiType(type)));
    }
});

test("structFieldOffsets covers a bare scalar, a nested struct, and a whole array as one field", () => {
    expect(structFieldOffsets("uint64")).toEqual([{ off: 0, size: 8 }]); // a non-struct root is one field
    expect(structFieldOffsets("uint8, {uint16, uint8}, id, bit")).toEqual([
        { off: 0, size: 1 },
        { off: 2, size: 4 },
        { off: 8, size: 32 },
        { off: 40, size: 1 },
    ]);
    expect(structFieldOffsets("[2;[3;{uint8, uint64}]]")).toEqual([{ off: 0, size: 96 }]);
    expect(layoutOf("[2;[3;{uint8, uint64}]]")).toEqual({ size: 96, align: 8 });
});

test("a nested value format encodes and decodes byte-for-byte through three levels", async () => {
    const encoded = await encodeInput("{ 1uint8, [2; {2uint8, 3uint64}, {4uint8, 5uint64}] }");
    expect(encoded.length).toBe(layoutOf("{ uint8, [2;{uint8,uint64}] }").size); // 40: the array aligns to 8 first
    expect(await decodeOutput(encoded, "{ uint8, [2;{uint8,uint64}] }")).toEqual([
        1,
        [
            [2, 3n],
            [4, 5n],
        ],
    ]);

    const matrix = await encodeInput("[2; [2; {1uint8, 2uint64}, {3uint8, 4uint64}], [2; {5uint8, 6uint64}, {7uint8, 8uint64}]]");
    expect(matrix.length).toBe(layoutOf("[2;[2;{uint8,uint64}]]").size);
    expect(await decodeOutput(matrix, "[2;[2;{uint8,uint64}]]")).toEqual([
        [
            [1, 2n],
            [3, 4n],
        ],
        [
            [5, 6n],
            [7, 8n],
        ],
    ]);
});

test("the ×N shorthand expands inside a nested struct inside an array", async () => {
    const short = await encodeInput("[2; { 1uint8, [3; 2uint16 ×3] } ×2]");
    const long = await encodeInput("[2; { 1uint8, [3; 2uint16, 2uint16, 2uint16] }, { 1uint8, [3; 2uint16, 2uint16, 2uint16] }]");

    expect(hex(short)).toBe(hex(long));
    expect(hex(short)).toBe("0100" + "020002000200" + "0100" + "020002000200"); // uint8, pad, three uint16, twice
    expect(short.length).toBe(layoutOf("[2;{ uint8, [3;uint16] }]").size);
    expect(await decodeOutput(short, "[2;{ uint8, [3;uint16] }]")).toEqual([
        [1, [2, 2, 2]],
        [1, [2, 2, 2]],
    ]);
});

test("a ×0 repeat contributes no values and satisfies a zero-length array", async () => {
    expect(await encodeInput("[0; 1uint8 ×0]")).toEqual(new Uint8Array(0));
    expect(await encodeInput("5uint64 ×0")).toEqual(new Uint8Array(0));
    await expect(encodeInput("[1; 1uint8 ×0]")).rejects.toThrow(/array of 1 needs 1 values, got 0/);
});

// A value format that is self-consistent can still be the wrong shape for the entry it is sent to, and
// encodeInput cannot see that. These pin the size cross-check the two call sites run afterwards.
test("checkInputSize passes an input whose encoding matches the entry", async () => {
    const type = validated(st(arr(u16, 4), u32));
    expect(type.size).toBe(12);
    const input = await encodeInput("[4; 1uint16, 2uint16, 3uint16, 4uint16], 9uint32");
    expect(() => checkInputSize(type, input, "proc 1/2")).not.toThrow();
});

test("checkInputSize rejects a self-consistent input of the wrong shape", async () => {
    const type = validated(st(arr(u16, 4), u32));
    // Declares a 2-element array, so it encodes cleanly at 8 bytes — the engine would zero-fill the rest
    // and the contract would read the uint32 as the array's third element.
    const short = await encodeInput("[2; 1uint16, 2uint16], 9uint32");
    expect(short.length).toBe(8);
    expect(() => checkInputSize(type, short, "proc 1/2")).toThrow("encodes to 8 bytes, proc 1/2 wants 12 ({ [4;uint16], uint32 })");
});

test("checkInputSize rejects an input that drops the array brackets entirely", async () => {
    const type = validated(st(arr(u16, 4), u32));
    const flat = await encodeInput("1uint16, 2uint16, 9uint32");
    expect(() => checkInputSize(type, flat, "proc 1/2")).toThrow(/encodes to 8 bytes, proc 1\/2 wants 12/);
});

test("checkInputSize accepts the empty input an entry with no arguments encodes to", async () => {
    const type = validated(st());
    const empty = await encodeInput("");
    expect(empty.length).toBe(type.size);
    expect(() => checkInputSize(type, empty, "proc 1/1")).not.toThrow();
});

test("checkInputSize names an over-long input against an entry that takes none", async () => {
    const type = validated(st());
    const extra = await encodeInput("1uint64");
    expect(() => checkInputSize(type, extra, "proc 1/1")).toThrow(/encodes to 8 bytes, proc 1\/1 wants 1/);
});
