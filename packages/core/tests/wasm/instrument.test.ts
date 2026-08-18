import { expect, test } from "bun:test";
import { compileContractWithTypeScript } from "@qinit/compiler/browser";
import COUNTER_SOURCE from "../../../../fixtures/Counter.h" with { type: "text" };
import BIG_STATE_SOURCE from "../../../../fixtures/BigState.h" with { type: "text" };
import TOKEN_SOURCE from "../../../../fixtures/Token.h" with { type: "text" };
import {
    DEFAULT_JOURNAL_CAP_BYTES,
    InstrumentError,
    JOURNAL_RESET_EXPORT,
    capacityBlocksFor,
    instrumentStateJournal,
    journalBytesFor,
    remapCodeOffset,
    tableSlotsFor,
} from "../../src/wasm/instrument";
import { JOURNAL_BLOCK_BYTES } from "../../src/wasm/journal";

/**
 * A module without the journal already baked in. The shared fixture loader caches compiled contracts
 * across test files, so these compile their own rather than racing another file for that cache.
 */
async function pristine(source: string, contractName: string): Promise<Uint8Array<ArrayBuffer>> {
    const saved = process.env.QINIT_NO_STATE_JOURNAL;
    process.env.QINIT_NO_STATE_JOURNAL = "1";
    try {
        const result = await compileContractWithTypeScript({ source, contractName, slot: 28, arenaSizeBytes: 1024 * 1024 });
        if (result.wasm.byteLength === 0) {
            throw new Error(`${contractName} did not compile: ${JSON.stringify(result.diagnostics)}`);
        }
        return Uint8Array.from(result.wasm);
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_NO_STATE_JOURNAL;
        } else {
            process.env.QINIT_NO_STATE_JOURNAL = saved;
        }
    }
}

test("an instrumented module still validates and keeps the ABI exports", async () => {
    const result = instrumentStateJournal(await pristine(COUNTER_SOURCE, "Counter"));

    expect(WebAssembly.validate(result.wasm)).toBe(true);
    expect(result.storesInstrumented).toBeGreaterThan(0);

    const exports = WebAssembly.Module.exports(new WebAssembly.Module(result.wasm)).map((entry) => entry.name);
    for (const required of ["contract_index", "state_addr", "state_size", "io_base", "io_size", "dispatch", "_initialize"]) {
        expect(exports).toContain(required);
    }
    expect(exports).toContain(JOURNAL_RESET_EXPORT);
});

// The journal lives in the arena, so the module reports less of it than before: any host that respects
// io_size() keeps out of the journal without being told it exists.
test("io_size shrinks by exactly the journal size", async () => {
    const bytes = await pristine(COUNTER_SOURCE, "Counter");
    const result = instrumentStateJournal(bytes);

    const sizeOf = (wasm: Uint8Array<ArrayBuffer>) => {
        const instance = new WebAssembly.Instance(new WebAssembly.Module(wasm), stubImports(wasm));
        return (instance.exports as Record<string, () => number>).io_size!() >>> 0;
    };

    expect(sizeOf(bytes) - sizeOf(result.wasm)).toBe(result.journalBytes);
});

test("instrumenting an already-instrumented module is refused", async () => {
    const once = instrumentStateJournal(await pristine(COUNTER_SOURCE, "Counter"));

    expect(() => instrumentStateJournal(once.wasm)).toThrow(InstrumentError);
});

test("journal size follows capacity, not state size", () => {
    // A bit-per-block map would cost 450 KB for a 923 MB state; the probe table is capacity-sized.
    const small = capacityBlocksFor(8, DEFAULT_JOURNAL_CAP_BYTES);
    const huge = capacityBlocksFor(923_559_560, DEFAULT_JOURNAL_CAP_BYTES);

    expect(small).toBe(1);
    expect(huge).toBe(Math.floor(DEFAULT_JOURNAL_CAP_BYTES / (JOURNAL_BLOCK_BYTES + 4)));
    expect(journalBytesFor(huge)).toBeLessThan(DEFAULT_JOURNAL_CAP_BYTES * 2);
    // The table is a power of two and never more than half full, so a probe always finds a free slot.
    expect(tableSlotsFor(huge)).toBeGreaterThanOrEqual(huge * 2);
    expect(tableSlotsFor(huge) & (tableSlotsFor(huge) - 1)).toBe(0);
});

// Trap backtraces symbolize through a line map built from the pristine module, so the offsets it
// carries have to survive the rewrite.
test("the offset map lands every un-rewritten instruction on identical bytes", async () => {
    for (const [source, name] of [
        [COUNTER_SOURCE, "Counter"],
        [BIG_STATE_SOURCE, "BigState"],
        [TOKEN_SOURCE, "Token"],
    ] as const) {
        const bytes = await pristine(source, name);
        const result = instrumentStateJournal(bytes);

        // Each breakpoint marks a byte copied verbatim: a body's content start, or the byte just past a
        // rewritten site.
        expect(result.offsetMap.length).toBeGreaterThan(0);
        for (const entry of result.offsetMap) {
            expect(result.wasm[remapCodeOffset(result.offsetMap, entry.from)], `${name} offset ${entry.from}`).toBe(bytes[entry.from]!);
        }
    }
});

test("a module the rewriter cannot read is rejected rather than half-instrumented", () => {
    expect(() => instrumentStateJournal(new Uint8Array([1, 2, 3, 4]))).toThrow();
    expect(() => instrumentStateJournal(new Uint8Array(0))).toThrow();
});

test("remapping is monotonic and never moves an offset backwards", async () => {
    const result = instrumentStateJournal(await pristine(TOKEN_SOURCE, "Token"));

    let previous = -1;
    for (const entry of result.offsetMap) {
        const mapped = remapCodeOffset(result.offsetMap, entry.from);
        expect(mapped).toBeGreaterThanOrEqual(entry.from);
        expect(mapped).toBeGreaterThan(previous);
        previous = mapped;
    }
});

function stubImports(wasm: Uint8Array<ArrayBuffer>): WebAssembly.Imports {
    const imports: WebAssembly.Imports = {};
    for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(wasm))) {
        imports[entry.module] ??= {};
        (imports[entry.module] as Record<string, unknown>)[entry.name] = entry.kind === "function" ? () => 0 : 0;
    }
    return imports;
}
