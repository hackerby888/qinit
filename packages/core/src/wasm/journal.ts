// State-write journal baked into a contract module by `instrument.ts`. The contract records the
// original bytes of every state granule it is the first to overwrite, so a host can report what
// changed without keeping a copy of the state.

/** Undo granularity. Matches the engine's diff window, so journal output equals a snapshot diff. */
export const JOURNAL_GRANULE_BYTES = 256;

/** "QJRN" — identifies an instrumented module without asking the module anything. */
export const JOURNAL_MAGIC = 0x514a524e;

export const JOURNAL_FORMAT_VERSION = 1;

export const JOURNAL_HEADER_BYTES = 32;

/** Empty slot marker in the probe table; also the reset fill byte, repeated. */
export const JOURNAL_EMPTY_SLOT = 0xffffffff;

export const JOURNAL_ENTRY_BYTES = JOURNAL_GRANULE_BYTES + 4;

export const JOURNAL_OVERFLOW_FLAG = 1;

/** Probe-table hash (Knuth). Part of the format: a host note must land in the same slot a wasm note would. */
export const JOURNAL_HASH_MULTIPLIER = -1640531527;

/** Byte offsets inside the journal header. */
export const JournalHeaderOffset = {
    MAGIC: 0,
    VERSION: 4,
    FLAGS: 8,
    ENTRY_COUNT: 12,
    CAPACITY: 16,
    STATE_SIZE: 20,
    TABLE_MASK: 24,
} as const;

export interface JournalHeader {
    readonly version: number;
    readonly flags: number;
    readonly entryCount: number;
    readonly capacity: number;
    readonly stateSize: number;
    readonly tableSlots: number;
    /** Where the undo entries start, relative to the journal base. */
    readonly entriesOffset: number;
    readonly overflowed: boolean;
}

export interface JournalGranule {
    readonly granule: number;
    /** Byte offset of the granule inside the contract state. */
    readonly offset: number;
    readonly before: Uint8Array;
}

/**
 * Reads the header at `base`, or undefined when the module carries no journal there. Every geometry
 * value comes from the header, never from build-time constants: a host reads artifacts whose journal
 * capacity it did not choose.
 */
export function readJournalHeader(memory: Uint8Array, base: number): JournalHeader | undefined {
    if (base < 0 || base + JOURNAL_HEADER_BYTES > memory.byteLength) {
        return undefined;
    }

    const view = new DataView(memory.buffer, memory.byteOffset);
    if (view.getUint32(base + JournalHeaderOffset.MAGIC, true) !== JOURNAL_MAGIC) {
        return undefined;
    }

    const version = view.getUint32(base + JournalHeaderOffset.VERSION, true);
    if (version !== JOURNAL_FORMAT_VERSION) {
        return undefined;
    }

    const tableSlots = view.getUint32(base + JournalHeaderOffset.TABLE_MASK, true) + 1;
    const flags = view.getUint32(base + JournalHeaderOffset.FLAGS, true);

    return {
        version,
        flags,
        entryCount: view.getUint32(base + JournalHeaderOffset.ENTRY_COUNT, true),
        capacity: view.getUint32(base + JournalHeaderOffset.CAPACITY, true),
        stateSize: view.getUint32(base + JournalHeaderOffset.STATE_SIZE, true),
        tableSlots,
        entriesOffset: JOURNAL_HEADER_BYTES + tableSlots * 4,
        overflowed: (flags & JOURNAL_OVERFLOW_FLAG) !== 0,
    };
}

/** The granules this dispatch was the first to write, in journal order, with their original bytes. */
export function readJournalGranules(memory: Uint8Array, base: number, header: JournalHeader): JournalGranule[] {
    const view = new DataView(memory.buffer, memory.byteOffset);
    const entriesAt = base + header.entriesOffset;
    const granules: JournalGranule[] = [];

    for (let index = 0; index < header.entryCount; index++) {
        const at = entriesAt + index * JOURNAL_ENTRY_BYTES;
        const granule = view.getUint32(at, true);
        const offset = granule * JOURNAL_GRANULE_BYTES;
        // The last granule of a state is short whenever the state is not a multiple of the granule.
        const length = Math.min(JOURNAL_GRANULE_BYTES, header.stateSize - offset);
        if (length <= 0) {
            continue;
        }

        granules.push({ granule, offset, before: memory.subarray(at + 4, at + 4 + length) });
    }

    return granules;
}

/**
 * Clears the counters and the probe table so the next dispatch starts empty. The module also exports
 * `__q_journal_reset`, but doing it host-side avoids a wasm call per dispatch.
 */
export function resetJournal(memory: Uint8Array, base: number, header: JournalHeader): void {
    const view = new DataView(memory.buffer, memory.byteOffset);
    view.setUint32(base + JournalHeaderOffset.FLAGS, 0, true);
    view.setUint32(base + JournalHeaderOffset.ENTRY_COUNT, 0, true);
    memory.fill(0xff, base + JOURNAL_HEADER_BYTES, base + JOURNAL_HEADER_BYTES + header.tableSlots * 4);
}

/**
 * Records a host write into guest memory, exactly as an instrumented store would. Store rewriting
 * cannot see writes the host makes through an lhost out-pointer, and a contract may aim one at state.
 */
export function noteHostWrite(memory: Uint8Array, base: number, header: JournalHeader, stateAddr: number, address: number, length: number): void {
    if (length <= 0) {
        return;
    }

    const relative = address - stateAddr;
    if (relative < 0 || relative >= header.stateSize) {
        return;
    }

    const view = new DataView(memory.buffer, memory.byteOffset);
    const lastByte = Math.min(relative + length - 1, header.stateSize - 1);
    const mask = header.tableSlots - 1;
    const tableAt = base + JOURNAL_HEADER_BYTES;
    const entriesAt = base + header.entriesOffset;

    for (let granule = relative >>> 8; granule <= lastByte >>> 8; granule++) {
        let slotIndex = Math.imul(granule, JOURNAL_HASH_MULTIPLIER) & mask;
        let seen = false;

        for (;;) {
            const slot = tableAt + slotIndex * 4;
            const value = view.getUint32(slot, true);
            if (value === granule) {
                seen = true;
                break;
            }
            if (value === JOURNAL_EMPTY_SLOT) {
                break;
            }
            slotIndex = (slotIndex + 1) & mask;
        }

        if (seen) {
            continue;
        }

        const count = view.getUint32(base + JournalHeaderOffset.ENTRY_COUNT, true);
        if (count >= header.capacity) {
            view.setUint32(base + JournalHeaderOffset.FLAGS, view.getUint32(base + JournalHeaderOffset.FLAGS, true) | JOURNAL_OVERFLOW_FLAG, true);
            return;
        }

        view.setUint32(tableAt + slotIndex * 4, granule, true);

        const destination = entriesAt + count * JOURNAL_ENTRY_BYTES;
        const offset = granule * JOURNAL_GRANULE_BYTES;
        const copyLength = Math.min(JOURNAL_GRANULE_BYTES, header.stateSize - offset);
        view.setUint32(destination, granule, true);
        memory.copyWithin(destination + 4, stateAddr + offset, stateAddr + offset + copyLength);
        view.setUint32(base + JournalHeaderOffset.ENTRY_COUNT, count + 1, true);
    }
}
