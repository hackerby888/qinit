import { test, expect } from "bun:test";
import { encodeInput, decodeOutput, structFieldOffsets, layoutOf, parseLayout, zeroInputFormat } from "../../src/abi-fmt";

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
