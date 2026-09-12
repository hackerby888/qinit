// How the editor's per-keystroke work scales with a real contract: `analyzeContract` on a debounce after
// every edit, `completeMembersAt` on every fallback completion. Only ever timed on a few hundred lines.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { initK12 } from "@qinit/core";
import { analyzeContract, completeMembersAt } from "@qinit/compiler/analyzer";
import { loadQpiHeader } from "@qinit/compiler";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required: this measures against core's own contracts");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);

const CONTRACTS = join(CORE_PATH, "src", "contracts");
const BUDGET_MS = Number(process.env.QPI_ANALYZE_BUDGET_MS ?? 500);

/** Median of a few runs: a single timing on a loaded box says more about the box than the code. */
function medianMs(run: () => void, samples = 5): number {
    const times: number[] = [];
    for (let i = 0; i < samples; i++) {
        const started = performance.now();
        run();
        times.push(performance.now() - started);
    }
    return times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
}

interface Row {
    name: string;
    lines: number;
    analyzeMs: number;
    completeMs: number | null;
    diagnostics: number;
}

const files = readdirSync(CONTRACTS)
    .filter((file) => file.endsWith(".h"))
    .map((file) => ({ file, path: join(CONTRACTS, file), source: readFileSync(join(CONTRACTS, file), "utf8") }))
    .map((entry) => ({ ...entry, lines: entry.source.split("\n").length }))
    .sort((left, right) => left.lines - right.lines);

console.log(`scale: ${files.length} of core's own contracts · analyze budget ${BUDGET_MS} ms\n`);
console.log(`${"CONTRACT".padEnd(22)} ${"LINES".padStart(6)} ${"ANALYZE".padStart(9)} ${"µs/LINE".padStart(8)} ${"MEMBER".padStart(8)}  DIAGS`);
console.log("-".repeat(74));

const rows: Row[] = [];
for (const entry of files) {
    // The struct that derives ContractBase is the contract; the filename is not reliably its name.
    const name = /struct\s+([A-Za-z_]\w*)\s*:\s*public\s+ContractBase/.exec(entry.source)?.[1] ?? entry.file.replace(/\.h$/, "");
    let analyzeMs: number;
    let diagnostics = 0;
    try {
        analyzeMs = medianMs(() => {
            diagnostics = analyzeContract({ source: entry.source, contractName: name, slot: 31, qpiHeader: headers }).diagnostics.length;
        });
    } catch {
        console.log(`${name.padEnd(22)} ${String(entry.lines).padStart(6)}  analyze threw — skipped`);
        continue;
    }

    // The first `state.get().` in the file: the shape a developer completes on constantly.
    let completeMs: number | null = null;
    const marker = entry.source.indexOf("state.get().");
    if (marker >= 0) {
        const offset = marker + "state.get().".length;
        try {
            completeMs = medianMs(() => {
                completeMembersAt({ source: entry.source, offset, contractName: name, slot: 31, qpiHeader: headers });
            }, 3);
        } catch {
            completeMs = null;
        }
    }

    rows.push({ name, lines: entry.lines, analyzeMs, completeMs, diagnostics });
    const perLine = ((analyzeMs * 1000) / entry.lines).toFixed(0);
    const over = analyzeMs > BUDGET_MS ? "  <<< over budget" : "";
    console.log(
        `${name.padEnd(22)} ${String(entry.lines).padStart(6)} ${analyzeMs.toFixed(0).padStart(7)}ms ${perLine.padStart(8)} ` +
            `${(completeMs === null ? "—" : `${completeMs.toFixed(0)}ms`).padStart(8)}  ${String(diagnostics).padStart(5)}${over}`,
    );
}

// Flat µs/line is linear cost; a rising one means big contracts are served worst. Small files are all
// fixed cost, so comparing the smallest against the largest would measure startup rather than scaling.
const perLineOf = (row: Row) => (row.analyzeMs * 1000) / row.lines;
const SCALING_FLOOR = 500;
const scaled = rows.filter((row) => row.lines >= SCALING_FLOOR);
const perLine = scaled.map(perLineOf).sort((a, b) => a - b);
const largest = rows[rows.length - 1];

console.log(`\nfixed cost: ${rows[0].name} at ${rows[0].lines} lines still takes ${rows[0].analyzeMs.toFixed(0)} ms`);
console.log(
    `per line, over the ${scaled.length} contracts of ${SCALING_FLOOR}+ lines: ` +
        `${perLine[0].toFixed(0)}–${perLine[perLine.length - 1].toFixed(0)} µs (median ${perLine[Math.floor(perLine.length / 2)].toFixed(0)})`,
);
console.log(`largest: ${largest.name}, ${largest.lines} lines, ${largest.analyzeMs.toFixed(0)} ms analyze, ${largest.completeMs?.toFixed(0) ?? "—"} ms member`);
// A flat band across a 13x size range is linear; a rising one would show as a widening spread.
console.log(`spread across a ${(largest.lines / scaled[0].lines).toFixed(0)}x size range: ${(perLine[perLine.length - 1] / perLine[0]).toFixed(1)}x per line`);

const over = rows.filter((row) => row.analyzeMs > BUDGET_MS);
console.log(`\n${rows.length} measured · ${over.length} over the ${BUDGET_MS} ms analyze budget`);
if (over.length) console.log(`over: ${over.map((row) => `${row.name} ${row.analyzeMs.toFixed(0)}ms`).join(", ")}`);
process.exitCode = over.length ? 1 : 0;
