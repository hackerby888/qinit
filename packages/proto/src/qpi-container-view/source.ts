import { QpiContainerConsistencyError, QpiIncompleteReadError } from "./errors";

// one container's bytes with a per-read cap, e.g. { byteLength: 88, maxReadLength: 4096, read(64, 8) } for a HashMap<uint64, uint64, 4>; over rpc the cap is one state read (4 MiB)
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

// exactly `length` bytes stitched from reads of at most maxReadLength; a short read throws rather than returning less
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

// little-endian words out of a buffer, e.g. ff ff ff ff ff ff ff ff as sint64 -> -1n, core's NULL_INDEX
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

// copies the bytes, so later writes to the caller's buffer cannot change what the view reads
export function qpiSnapshotSource(bytes: Uint8Array): QpiByteSource {
    return byteArraySource(bytes.slice());
}

// no copy: reads see later writes to the buffer
export function qpiBorrowedSource(bytes: Uint8Array): QpiByteSource {
    return byteArraySource(bytes);
}

// core's 2-bit occupation flags, 32 slots to a word: reading each word once and skipping empty ones makes a walk proportional to slots in use, not capacity.
// only 0b01 counts. 0b10 is marked for removal and core already zeroed those bytes, so skipping them matches _population; they still cost a probe until cleanup()
export function occupiedSlotIndices(occupationFlags: Uint8Array, capacity: number): number[] {
    const occupied: number[] = [];

    for (let wordIndex = 0; wordIndex * 32 < capacity; wordIndex++) {
        const bits = uint64At(occupationFlags, wordIndex * 8);
        if (bits === 0n) {
            continue;
        }

        const firstSlotOfWord = wordIndex * 32;
        for (let slotInWord = 0; slotInWord < 32 && firstSlotOfWord + slotInWord < capacity; slotInWord++) {
            const occupation = Number((bits >> BigInt(slotInWord * 2)) & 3n);
            if (occupation === 1) {
                occupied.push(firstSlotOfWord + slotInWord);
            } else if (occupation === 3) {
                // 0b11 is unused in every core encoding, so it means a torn or misaligned read, not a full container
                throw new QpiContainerConsistencyError(`invalid occupation flag at slot ${firstSlotOfWord + slotInWord}`);
            }
        }
    }

    return occupied;
}

// Neighbouring slots are read as one range, so a run of entries costs one fetch rather than one each.
export function occupiedRanges(slotIndices: number[]): Array<{ start: number; end: number }> {
    const ranges: Array<{ start: number; end: number }> = [];

    for (const slotIndex of slotIndices) {
        const last = ranges[ranges.length - 1];
        if (last && slotIndex === last.end + 1) {
            last.end = slotIndex;
        } else {
            ranges.push({ start: slotIndex, end: slotIndex });
        }
    }

    return ranges;
}
