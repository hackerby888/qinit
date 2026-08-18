import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "../../src/wasm/headers";
import { DEFAULT_ARENA_BYTES, INPUT_BUFFER_BYTES, IO_BUFFER_BYTES, JOURNAL_REGION_BYTES, LOCALS_BUFFER_BYTES, OUTPUT_BUFFER_BYTES } from "../../src/wasm/sizing";

/**
 * core-lite declares the same layout as a C++ array and carries its own arena default, so the two
 * definitions can drift silently — nothing in either language references the other. Every core
 * checkout reachable from here is checked, the in-repo IDE copy included.
 */
function moduleStorageHeaders(): { label: string; source: string }[] {
    const roots: [string, string][] = [
        ["vscode resources", join(import.meta.dir, "../../../vscode/resources/core-headers/src")],
        ...(process.env.QINIT_CORE?.trim() ? ([["QINIT_CORE", join(process.env.QINIT_CORE.trim(), "src")]] as [string, string][]) : []),
    ];

    return roots
        .map(([label, root]) => ({ label, path: join(root, CORE_WASM_HEADERS.sdk.moduleStorage) }))
        .filter((entry) => existsSync(entry.path))
        .map((entry) => ({ label: entry.label, source: readFileSync(entry.path, "utf8") }));
}

/** Evaluates the parenthesised arithmetic these declarations use, e.g. `(64 * 1024) + ... + NAME`. */
function evaluateSizes(expression: string, substitutions: Record<string, number>): number {
    let text = expression;
    for (const [name, value] of Object.entries(substitutions)) {
        text = text.replaceAll(name, String(value));
    }
    if (!/^[\d\s()*+]+$/.test(text)) {
        throw new Error(`unexpected tokens in core size expression: ${expression}`);
    }
    return Number(new Function(`return ${text};`)());
}

test("core-lite's module_storage.h agrees with the shared sizing constants", () => {
    const headers = moduleStorageHeaders();
    expect(headers.length, "no module_storage.h reachable to check against").toBeGreaterThan(0);

    let journalChecked = false;
    for (const { label, source } of headers) {
        // To end of line, not to the first ")": these values nest parentheses.
        const define = (name: string) => source.match(new RegExp(`^#define\\s+${name}\\s+(.+)$`, "m"))?.[1]?.trim();

        const arena = define("WASM_ARENA_SIZE");
        expect(arena, `${label}: no WASM_ARENA_SIZE define`).toBeDefined();
        expect(evaluateSizes(arena!, {}), `${label}: arena default drifted`).toBe(DEFAULT_ARENA_BYTES);

        // Newer headers name the carve; older vendored snapshots still inline it in the array bound.
        const carve = define("WASM_IO_CARVE_SIZE");
        const io = carve ?? source.match(/moduleIoStorage\[([^\]]+)\]/)?.[1];
        expect(io, `${label}: no IO carve to check`).toBeDefined();
        expect(evaluateSizes(io!, { WASM_IO_CARVE_SIZE: 0, WASM_JOURNAL_SIZE: 0, WASM_ARENA_SIZE: 0 }), `${label}: IO buffer layout drifted`).toBe(
            IO_BUFFER_BYTES,
        );

        const journal = define("WASM_JOURNAL_SIZE");
        if (journal) {
            expect(evaluateSizes(journal, {}), `${label}: journal region drifted`).toBe(JOURNAL_REGION_BYTES);
            journalChecked = true;
        }
    }

    // A vendored snapshot may predate the journal, but the checkout the build compiles against must not:
    // the region has to exist in C++ or an instrumented artifact writes past its own memory.
    if (process.env.QINIT_CORE?.trim()) {
        expect(journalChecked, "the core checkout defines no WASM_JOURNAL_SIZE").toBe(true);
    }

    expect(IO_BUFFER_BYTES).toBe(INPUT_BUFFER_BYTES + OUTPUT_BUFFER_BYTES + LOCALS_BUFFER_BYTES);
});
