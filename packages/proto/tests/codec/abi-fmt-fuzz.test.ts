// Generated type trees, run through every layer that has to agree about them: the qpi-layout geometry
// the builders use, the format string formatAbiType emits, the string parser, and the two decoders.
// Hand-written cases only cover shapes someone thought of; these cover the ones nobody did.
import { test, expect } from "bun:test";
import { decodeAbiValue, decodeOutput, encodeInput, layoutOf, structFieldOffsets, zeroInputFormat } from "../../src/abi-fmt";
import { formatAbiType, type AbiType } from "../../src/contract-idl";
import { arr, ba, bit, co, hm, hs, i8, i16, i32, i64, i128, id, ll, m256i, st, u8, u16, u32, u64, u128, validated } from "./abi-builders";

// A tiny LCG rather than Math.random, so a failure reproduces from the seed the message carries.
function rng(seed: number): () => number {
    let state = (seed * 2654435761) >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 0x100000000;
    };
}

const LEAVES: AbiType[] = [u8, u16, u32, u64, u128, i8, i16, i32, i64, i128, id, m256i, bit];
const COUNTS = [1, 2, 3, 4];

const pick = <T>(next: () => number, xs: readonly T[]): T => xs[Math.floor(next() * xs.length)];

// Scalars, arrays and structs — the shapes both dialects and both decoders are supposed to handle.
function genPlain(next: () => number, depth: number): AbiType {
    const roll = next();
    if (depth <= 0 || roll < 0.45) return pick(next, LEAVES);
    if (roll < 0.7) return arr(genPlain(next, depth - 1), pick(next, COUNTS));
    const fields = 1 + Math.floor(next() * 3);
    return st(...Array.from({ length: fields }, () => genPlain(next, depth - 1)));
}

// Containers only appear at the outside of a shape here; their contents reuse the plain generator.
function genAny(next: () => number, depth: number): AbiType {
    const roll = next();
    if (roll < 0.6) return genPlain(next, depth);
    const capacity = pick(next, [1, 2, 4]);
    const inner = () => genPlain(next, Math.min(depth, 2));
    if (roll < 0.68) return ba(pick(next, [8, 64, 128]));
    if (roll < 0.76) return hm(inner(), inner(), capacity);
    if (roll < 0.84) return hs(inner(), capacity);
    if (roll < 0.92) return co(inner(), capacity);
    return ll(inner(), capacity);
}

// Anything above this is a generator accident, not a shape worth spending a test on.
const SIZE_CAP = 1 << 16;

const filler = (size: number) => new Uint8Array(size).map((_, index) => (index * 37 + 11) & 0xff);

test("a generated type, its format string and its layout all report the same geometry", () => {
    let checked = 0;
    for (let seed = 1; seed <= 300; seed++) {
        const next = rng(seed);
        const type = validated(genAny(next, 4) as AbiType);
        if (type.size > SIZE_CAP) continue;

        const fmt = formatAbiType(type);
        expect({ seed, fmt, ...layoutOf(fmt) }).toEqual({ seed, fmt, size: type.size, align: type.align });
        checked++;
    }
    expect(checked).toBeGreaterThan(200);
});

test("the all-zero sample for a generated type encodes to exactly that type's size", async () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
        const next = rng(seed + 5000);
        const type = validated(genAny(next, 4) as AbiType);
        if (type.size > SIZE_CAP) continue;

        const sample = zeroInputFormat(type);
        const bytes = await encodeInput(sample);
        expect({ seed, sample: sample.slice(0, 120), length: bytes.length }).toEqual({ seed, sample: sample.slice(0, 120), length: type.size });
        expect(bytes.every((byte) => byte === 0)).toBe(true);
        checked++;
    }
    expect(checked).toBeGreaterThan(150);
});

test("the string decoder and the typed decoder read a generated type identically", async () => {
    let checked = 0;
    for (let seed = 1; seed <= 200; seed++) {
        const next = rng(seed + 9000);
        const type = validated(genPlain(next, 4) as AbiType);
        if (type.size > SIZE_CAP) continue;

        const fmt = formatAbiType(type);
        const bytes = filler(type.size);
        const fromString = await decodeOutput(bytes, fmt);
        const fromType = await decodeAbiValue(bytes, type);
        expect({ seed, fmt, value: fromString }).toEqual({ seed, fmt, value: fromType });
        checked++;
    }
    expect(checked).toBeGreaterThan(150);
});

test("every field a generated struct reports sits inside the struct and after the one before it", () => {
    for (let seed = 1; seed <= 200; seed++) {
        const next = rng(seed + 13000);
        const type = validated(st(genPlain(next, 3), genPlain(next, 3), genPlain(next, 3)));
        if (type.size > SIZE_CAP) continue;

        const fmt = formatAbiType(type);
        const offsets = structFieldOffsets(fmt);
        expect(offsets.length).toBe(3);

        let previousEnd = 0;
        for (const [index, field] of offsets.entries()) {
            const idlField = type.fields[index];
            expect({ seed, index, off: field.off, size: field.size }).toEqual({ seed, index, off: idlField.offset, size: idlField.type.size });
            expect(field.off).toBeGreaterThanOrEqual(previousEnd);
            expect(field.off + field.size).toBeLessThanOrEqual(type.size);
            previousEnd = field.off + field.size;
        }
    }
});

// The random shapes above rarely isolate one scalar's alignment, so pair every scalar with every other
// exhaustively: a wrong align for one type shows up in the pair where it is the only one demanding it.
const NAMED_LEAVES: [string, AbiType][] = [
    ["uint8", u8],
    ["uint16", u16],
    ["uint32", u32],
    ["uint64", u64],
    ["uint128", u128],
    ["sint8", i8],
    ["sint16", i16],
    ["sint32", i32],
    ["sint64", i64],
    ["sint128", i128],
    ["id", id],
    ["m256i", m256i],
    ["bit", bit],
];

test("every scalar pair lays out, encodes and decodes the same through all three layers", async () => {
    for (const [firstName, first] of NAMED_LEAVES) {
        for (const [secondName, second] of NAMED_LEAVES) {
            const label = `{ ${firstName}, ${secondName} }`;
            const type = validated(st(first, second));
            const fmt = formatAbiType(type);

            expect({ label, ...layoutOf(fmt) }).toEqual({ label, size: type.size, align: type.align });

            const zeroed = await encodeInput(zeroInputFormat(type));
            expect({ label, length: zeroed.length }).toEqual({ label, length: type.size });

            const bytes = filler(type.size);
            expect({ label, value: await decodeOutput(bytes, fmt) }).toEqual({ label, value: await decodeAbiValue(bytes, type) });

            expect({ label, offsets: structFieldOffsets(fmt) }).toEqual({
                label,
                offsets: type.fields.map((field) => ({ off: field.offset, size: field.type.size })),
            });
        }
    }
});

test("an array of every scalar keeps the element stride its own alignment implies", async () => {
    for (const [name, leaf] of NAMED_LEAVES) {
        for (const count of COUNTS) {
            const label = `[${count};${name}]`;
            const type = validated(arr(leaf, count));
            const fmt = formatAbiType(type);

            expect({ label, ...layoutOf(fmt) }).toEqual({ label, size: type.size, align: type.align });
            expect({ label, length: (await encodeInput(zeroInputFormat(type))).length }).toEqual({ label, length: type.size });

            const bytes = filler(type.size);
            expect({ label, value: await decodeOutput(bytes, fmt) }).toEqual({ label, value: await decodeAbiValue(bytes, type) });
        }
    }
});
