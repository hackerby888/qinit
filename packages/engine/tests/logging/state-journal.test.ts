import { expect, test } from "bun:test";
import { loadWasmFixture as wasm, wasmFixtureManifest, type WasmFixtureName } from "../../../../test-utils/wasm-fixtures";
import { QubicSimulator } from "../../src/qubic-simulator";
import { JOURNAL_FIRST_GENERATION, JOURNAL_HEADER_BYTES, JOURNAL_SLOT_BYTES, JournalHeaderOffset, readJournalHeader } from "@qinit/core/wasm/journal";
import type { DebugStateRegion } from "@qinit/core";

const WHO = new Uint8Array(32).fill(7);

interface Drive {
    readonly fixture: WasmFixtureName;
    /** Contracts the driver calls into. Each keeps its own instance, its own memory and its own journal. */
    readonly callees?: readonly WasmFixtureName[];
    /** Traced entries expected, so a drive cannot quietly stop covering its callees. */
    readonly entries?: number;
    readonly run: (sim: QubicSimulator, slot: number) => void;
}

/** Runs `body` with the host-side snapshot override cleared, so a journal-mode test holds under either leg. */
function withJournalEnabled<T>(body: () => T): T {
    const saved = process.env.QINIT_STATE_DIFF;
    delete process.env.QINIT_STATE_DIFF;
    try {
        return body();
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_STATE_DIFF;
        } else {
            process.env.QINIT_STATE_DIFF = saved;
        }
    }
}

/** Runs a fixture with the journal, then again with QINIT_STATE_DIFF=snapshot, and returns both diffs. */
async function bothMechanisms(drive: Drive): Promise<{ journal: DebugStateRegion[][]; snapshot: DebugStateRegion[][]; truncated: boolean[] }> {
    const slot = wasmFixtureManifest[drive.fixture].slot;
    const bytes = await wasm(drive.fixture);
    const callees = await Promise.all((drive.callees ?? []).map(async (name) => [wasmFixtureManifest[name].slot, await wasm(name)] as const));

    // Every traced entry is compared, callees included, not just the driver's own.
    const collect = () => {
        const sim = new QubicSimulator({ fees: "off" });
        for (const [calleeSlot, calleeBytes] of callees) {
            sim.deploy(calleeSlot, calleeBytes);
        }
        sim.deploy(slot, bytes);
        sim.setDebug(true);
        drive.run(sim, slot);
        const entries = sim.getTrace().entries;
        return { diffs: entries.map((entry) => entry.stateDiff), truncated: entries.map((entry) => entry.stateTruncated) };
    };

    const journal = withJournalEnabled(collect);
    const snapshot = withJournalEnabled(() => {
        process.env.QINIT_STATE_DIFF = "snapshot";
        return collect();
    });

    return { journal: journal.diffs, snapshot: snapshot.diffs, truncated: journal.truncated };
}

test("the compilers bake a journal into every contract", async () => {
    const sim = new QubicSimulator({ fees: "off" });
    const contract = sim.deploy(28, await wasm("Counter")) as unknown as { mem: WebAssembly.Memory; arenaEnd: number };
    const header = readJournalHeader(new Uint8Array(contract.mem.buffer), contract.arenaEnd);

    expect(header).toBeDefined();
    expect(header!.stateSize).toBe(8);
    expect(header!.overflowed).toBe(false);
});

// The whole design rests on this: the journal must report exactly what copying the state reports.
test("journal diffs match snapshot diffs byte for byte", async () => {
    const drives: Drive[] = [
        { fixture: "Counter", run: (sim, slot) => sim.procedure(slot, 1) },
        { fixture: "BigState", run: (sim, slot) => sim.procedure(slot, 1, Uint8Array.from([7, 1, 0, 0, 0, 0, 0, 0])) },
        { fixture: "Token", run: (sim, slot) => sim.procedure(slot, 1) },
        { fixture: "Vault", run: (sim, slot) => sim.procedure(slot, 1) },
        { fixture: "Trap", run: (sim, slot) => sim.procedure(slot, 1) },
        { fixture: "DigestProbe", run: (sim, slot) => sim.procedure(slot, 1) },
        // Caller and callee are separate instances with separate memories, so each keeps its own journal.
        { fixture: "QpiDual", callees: ["QpiDualCallee"], entries: 4, run: (sim, slot) => sim.procedure(slot, 1) },
        // Two calls in a row: the second must diff against the first's result, not against zero.
        {
            fixture: "Counter",
            run: (sim, slot) => {
                sim.procedure(slot, 1);
                sim.procedure(slot, 1);
            },
        },
    ];

    for (const drive of drives) {
        const { journal, snapshot } = await bothMechanisms(drive);
        expect(journal, `${drive.fixture} diverged from the snapshot oracle`).toEqual(snapshot);
        if (drive.entries !== undefined) {
            expect(journal.length, `${drive.fixture} traced fewer contracts than expected`).toBe(drive.entries);
        }
    }
});

// getEntity fills a caller-provided struct, so the host writes the state and no wasm store is involved.
// Without a host-side note this reports no change at all.
test("a state field written by the host, not by the contract, still reaches the diff", async () => {
    const { journal, snapshot } = await bothMechanisms({
        fixture: "HostWrite",
        run: (sim, slot) => sim.procedure(slot, 1, undefined, { invocator: WHO, originator: WHO }),
    });

    expect(journal[0]!.length).toBe(1);
    expect(journal).toEqual(snapshot);
});

// An inter-contract call's output buffer can be a state field, and then lh_liteCallFunction writes the
// state through an out-pointer. Same blind spot as getEntity, reached by a different import.
test("an inter-contract call that writes its output straight into state still reaches the diff", async () => {
    const { journal, snapshot } = await bothMechanisms({
        fixture: "CallOutState",
        callees: ["Counter"],
        entries: 2,
        run: (sim, slot) => {
            sim.procedure(28, 1); // Counter.Inc, so the pulled value is not the zero the state already holds
            sim.procedure(slot, 1);
        },
    });

    // The caller's own entry is the one the host wrote; it must report the field, not an empty diff.
    expect(journal.at(-1)!.length).toBe(1);
    expect(journal).toEqual(snapshot);
});

// More blocks than the journal holds: that call can only say "truncated", and the contract falls back
// to snapshot diffing from the next call, which must then be complete again.
test("an overflowing call truncates, arms the fallback, and the next call is complete", async () => {
    const slot = wasmFixtureManifest.WideWrite.slot;
    const bytes = await wasm("WideWrite");
    withJournalEnabled(() => {
        const sim = new QubicSimulator({ fees: "off" });
        const contract = sim.deploy(slot, bytes) as unknown as { mem: WebAssembly.Memory; arenaEnd: number };

        const header = readJournalHeader(new Uint8Array(contract.mem.buffer), contract.arenaEnd)!;
        const blocksInState = Math.ceil(header.stateSize / 256);
        expect(blocksInState).toBeGreaterThan(header.capacityBlocks);

        sim.setDebug(true);
        sim.procedure(slot, 1, u64(1n));
        const overflowed = sim.getTrace().entries.at(-1)!;
        expect(overflowed.stateTruncated).toBe(true);

        sim.procedure(slot, 1, u64(2n));
        const recovered = sim.getTrace().entries.at(-1)!;
        expect(recovered.stateTruncated).toBe(false);

        // The fallback has the whole state, so the second call reports every changed byte.
        const changed = recovered.stateDiff.reduce((total, region) => total + region.after.length / 2, 0);
        expect(changed).toBe(header.stateSize);
    });
});

// The point of the change is a number: a traced call on a 64 MB state must not allocate a 64 MB shadow.
test("journal mode never allocates the state-sized shadow", async () => {
    const slot = wasmFixtureManifest.BigState.slot;
    const bytes = await wasm("BigState");
    withJournalEnabled(() => {
        const sim = new QubicSimulator({ fees: "off" });
        const contract = sim.deploy(slot, bytes) as unknown as { shadow: Uint8Array | null; stateSize: number };

        sim.setDebug(true);
        sim.procedure(slot, 1, Uint8Array.from([7, 1, 0, 0, 0, 0, 0, 0]));
        sim.procedure(slot, 1, Uint8Array.from([9, 2, 0, 0, 0, 0, 0, 0]));

        expect(contract.stateSize).toBeGreaterThan(16 * 1024 * 1024);
        expect(contract.shadow).toBeNull();
        expect(sim.getTrace().entries.at(-1)!.stateDiff.length).toBeGreaterThan(0);
    });
});

test("QINIT_STATE_DIFF=snapshot ignores a baked journal", async () => {
    const saved = process.env.QINIT_STATE_DIFF;
    process.env.QINIT_STATE_DIFF = "snapshot";
    try {
        const sim = new QubicSimulator({ fees: "off" });
        const contract = sim.deploy(28, await wasm("Counter")) as unknown as { journal: unknown };
        expect(contract.journal).toBeNull();
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_STATE_DIFF;
        } else {
            process.env.QINIT_STATE_DIFF = saved;
        }
    }
});

// Verify mode exists to catch a write path the journal misses. It only earns that if it checks calls
// nobody traced, so this drives an untraced contract and plants a host write the journal cannot see.
test("QINIT_STATE_DIFF=verify checks dispatches no recorder asked about", async () => {
    const saved = process.env.QINIT_STATE_DIFF;
    process.env.QINIT_STATE_DIFF = "verify";
    try {
        const sim = new QubicSimulator({ fees: "off" });
        const contract = sim.deploy(28, await wasm("Counter"));
        sim.procedure(28, 1);

        // Debug was never switched on, so the only reason state was diffed at all is verify mode.
        expect(sim.getTrace().entries.length).toBe(0);

        // Blind the journal to the state it covers. It then under-reports exactly as a missed write path
        // would, and verify mode has to notice a write the contract really made.
        const view = contract as unknown as { mem: WebAssembly.Memory; arenaEnd: number };
        new DataView(view.mem.buffer).setUint32(view.arenaEnd + JournalHeaderOffset.STATE_SIZE, 0, true);
        expect(() => sim.procedure(28, 1)).toThrow(/journal disagrees with the snapshot/);
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_STATE_DIFF;
        } else {
            process.env.QINIT_STATE_DIFF = saved;
        }
    }
});

// Reset retires a generation instead of scrubbing the table, so the one dangerous moment is the wrap
// back to the first generation: a leftover slot stamped with that exact value would read as live and
// the block behind it would never be recorded. Both reset paths must clear on wrap.
test("a generation wrap clears leftovers stamped with the first generation", async () => {
    const bytes = await wasm("Counter");
    withJournalEnabled(() => {
        const sim = new QubicSimulator({ fees: "off" });
        const contract = sim.deploy(28, bytes) as unknown as { mem: WebAssembly.Memory; arenaEnd: number; ex: Record<string, () => void> };
        const view = () => new DataView(contract.mem.buffer);
        const header = () => readJournalHeader(new Uint8Array(contract.mem.buffer), contract.arenaEnd)!;
        const tableAt = () => contract.arenaEnd + JOURNAL_HEADER_BYTES;
        const setGeneration = (value: number) => view().setUint32(contract.arenaEnd + JournalHeaderOffset.GENERATION, value, true);

        sim.setDebug(true);
        sim.procedure(28, 1);
        const before = sim.getTrace().entries.at(-1)!.stateDiff;
        expect(before.length).toBe(1);

        // Restamp the slot the dispatch just claimed as if it were written 2^32 dispatches ago, then
        // wrap onto it. Without a clear, block 0 reads as already-recorded and drops out of the diff.
        const staleSlot = tableAt() + JOURNAL_SLOT_BYTES * (header().tableSlots - 1);
        for (let slot = tableAt(); slot < tableAt() + header().tableSlots * JOURNAL_SLOT_BYTES; slot += JOURNAL_SLOT_BYTES) {
            view().setUint32(slot, JOURNAL_FIRST_GENERATION, true);
        }
        expect(view().getUint32(staleSlot, true)).toBe(JOURNAL_FIRST_GENERATION);
        setGeneration(0xffffffff);

        sim.procedure(28, 1);
        expect(header().generation).toBe(JOURNAL_FIRST_GENERATION);
        const wrapped = sim.getTrace().entries.at(-1)!.stateDiff;
        expect(wrapped.length, "block vanished after the wrap — leftovers were not cleared").toBe(1);
        expect(wrapped[0]!.off).toBe(before[0]!.off);

        // Same branch inside the module, which is what a host that only calls the export relies on.
        for (let slot = tableAt(); slot < tableAt() + header().tableSlots * JOURNAL_SLOT_BYTES; slot += JOURNAL_SLOT_BYTES) {
            view().setUint32(slot, JOURNAL_FIRST_GENERATION, true);
        }
        setGeneration(0xffffffff);
        contract.ex.__q_journal_reset!();
        expect(header().generation).toBe(JOURNAL_FIRST_GENERATION);
        const table = new Uint8Array(contract.mem.buffer).slice(tableAt(), tableAt() + header().tableSlots * JOURNAL_SLOT_BYTES);
        expect(table.every((byte) => byte === 0), "wasm reset left stale stamps behind").toBe(true);
    });
});

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}
