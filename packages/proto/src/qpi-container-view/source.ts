import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";

export interface QpiByteSource {
    readonly byteLength: number;
    readonly maxReadLength: number;
    read(offset: number, length: number): Promise<Uint8Array>;
}

function assertSourceRange(source: Pick<QpiByteSource, "byteLength">, offset: number, length: number): void {
    const end = offset + length;
    if (
        !Number.isSafeInteger(source.byteLength) ||
        source.byteLength < 0 ||
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        !Number.isSafeInteger(end) ||
        offset < 0 ||
        length < 0 ||
        end > source.byteLength
    ) {
        throw new QpiIncompleteReadError(`QPI byte range ${offset}..${end} exceeds ${source.byteLength} bytes`);
    }
}

export async function readQpiBytes(source: QpiByteSource, offset: number, length: number): Promise<Uint8Array> {
    assertSourceRange(source, offset, length);
    if (!Number.isSafeInteger(source.maxReadLength) || source.maxReadLength <= 0) {
        throw new Error("QPI byte source has an invalid maxReadLength");
    }
    if (!length) {
        return new Uint8Array();
    }

    const bytes = new Uint8Array(length);
    let completed = 0;
    while (completed < length) {
        const chunkLength = Math.min(source.maxReadLength, length - completed);
        const chunk = await source.read(offset + completed, chunkLength);
        if (chunk.length !== chunkLength) {
            throw new QpiIncompleteReadError(`QPI byte source returned ${chunk.length} of ${chunkLength} bytes at ${offset + completed}`);
        }
        bytes.set(chunk, completed);
        completed += chunkLength;
    }
    return bytes;
}

export async function readUint64(source: QpiByteSource, offset: number): Promise<bigint> {
    return uint64At(await readQpiBytes(source, offset, 8), 0);
}

export function uint64At(bytes: Uint8Array, offset: number): bigint {
    assertIntegerRange(bytes, offset, "uint64");
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

export function sint64At(bytes: Uint8Array, offset: number): bigint {
    assertIntegerRange(bytes, offset, "sint64");
    return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
}

function assertIntegerRange(bytes: Uint8Array, offset: number, label: string): void {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > bytes.length) {
        throw new QpiContainerConsistencyError(`${label} exceeds container range`);
    }
}

function byteArraySource(bytes: Uint8Array): QpiByteSource {
    return {
        byteLength: bytes.length,
        maxReadLength: Math.max(1, bytes.length),
        async read(offset, length) {
            assertSourceRange({ byteLength: bytes.length }, offset, length);
            return bytes.slice(offset, offset + length);
        },
    };
}

export function qpiSnapshotSource(bytes: Uint8Array): QpiByteSource {
    return byteArraySource(bytes.slice());
}

export function qpiBorrowedSource(bytes: Uint8Array): QpiByteSource {
    return byteArraySource(bytes);
}

// Two occupation bits per slot, 32 slots to a word. Reading each word once instead of once per slot, and
// skipping the empty ones, turns a full-capacity walk into work proportional to the slots in use.
export function occupiedSlots(flags: Uint8Array, capacity: number): number[] {
    const slots: number[] = [];

    for (let word = 0; word * 32 < capacity; word++) {
        const bits = uint64At(flags, word * 8);
        if (bits === 0n) {
            continue;
        }

        const base = word * 32;
        for (let offset = 0; offset < 32 && base + offset < capacity; offset++) {
            const flag = Number((bits >> BigInt(offset * 2)) & 3n);
            if (flag === 1) {
                slots.push(base + offset);
            } else if (flag === 3) {
                throw new QpiContainerConsistencyError(`invalid occupation flag at slot ${base + offset}`);
            }
        }
    }

    return slots;
}

// Neighbouring slots are read as one range, so a run of entries costs one fetch rather than one each.
export function occupiedRanges(slots: number[]): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];

    for (const slot of slots) {
        const last = ranges[ranges.length - 1];
        if (last && slot === last.end + 1) {
            last.end = slot;
        } else {
            ranges.push({ start: slot, end: slot });
        }
    }

    return ranges;
}
