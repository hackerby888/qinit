// Little-endian byte helpers for building call-script inputs by hand.

import type { ScalarWidth } from "./types";

export const SCALAR_BYTES: Record<ScalarWidth, number> = {
    uint8: 1,
    uint16: 2,
    uint32: 4,
    uint64: 8,
    sint8: 1,
    sint16: 2,
    sint32: 4,
    sint64: 8,
};

export function isSigned(width: ScalarWidth): boolean {
    return width.startsWith("sint");
}

/** Largest value the width holds, as the contract's own arithmetic sees it. */
export function maxOf(width: ScalarWidth): bigint {
    const bits = BigInt(SCALAR_BYTES[width] * 8);
    return isSigned(width) ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
}

export function minOf(width: ScalarWidth): bigint {
    const bits = BigInt(SCALAR_BYTES[width] * 8);
    return isSigned(width) ? -(1n << (bits - 1n)) : 0n;
}

/** Wrap a value into the width's two's-complement range, the way the emitted wasm store does. */
export function wrap(value: bigint, width: ScalarWidth): bigint {
    const bits = BigInt(SCALAR_BYTES[width] * 8);
    const mask = (1n << bits) - 1n;
    const raw = value & mask;
    if (!isSigned(width)) return raw;
    const signBit = 1n << (bits - 1n);
    return raw >= signBit ? raw - (1n << bits) : raw;
}

function leBytes(value: bigint, bytes: number): string {
    const mask = (1n << BigInt(bytes * 8)) - 1n;
    let raw = value & mask;
    let hex = "";
    for (let i = 0; i < bytes; i++) {
        hex += (raw & 0xffn).toString(16).padStart(2, "0");
        raw >>= 8n;
    }
    return hex;
}

export function u8(value: bigint | number): string {
    return leBytes(BigInt(value), 1);
}
export function u16(value: bigint | number): string {
    return leBytes(BigInt(value), 2);
}
export function u32(value: bigint | number): string {
    return leBytes(BigInt(value), 4);
}
export function u64(value: bigint | number): string {
    return leBytes(BigInt(value), 8);
}
export function u128(value: bigint | number): string {
    return leBytes(BigInt(value), 16);
}

/** A scalar of the given QPI width, little-endian, sign handled by two's complement. */
export function scalar(width: ScalarWidth, value: bigint | number): string {
    return leBytes(BigInt(value), SCALAR_BYTES[width]);
}

/** A 32-byte `id`, seeded from a small number so scripts stay readable and deterministic. */
export function identity(seed: number): string {
    let hex = "";
    for (let i = 0; i < 32; i++) hex += (((seed * 31 + i * 7 + 1) & 0xff) >>> 0).toString(16).padStart(2, "0");
    return hex;
}

export const NULL_IDENTITY = "00".repeat(32);

/** Concatenate field encodings into one struct image. Padding is the caller's job — QPI structs are packed as declared. */
export function cat(...parts: string[]): string {
    return parts.join("");
}

/** Explicit padding bytes, for a struct whose C++ layout inserts them. */
export function pad(bytes: number): string {
    return "00".repeat(bytes);
}

export function hexToBytes(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
}

export function bytesToHex(bytes: Uint8Array): string {
    let hex = "";
    for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
    return hex;
}

/** The edge values worth driving a width with: the boundaries where a narrowing store, a sign extension, or an integer promotion goes wrong. Ordered small-
 *  to-large so a script reads sensibly. */
export function edgeValues(width: ScalarWidth): bigint[] {
    const max = maxOf(width);
    const min = minOf(width);
    const values = [0n, 1n, 2n, max - 1n, max];
    if (isSigned(width)) values.push(min, min + 1n, -1n);
    return values;
}
