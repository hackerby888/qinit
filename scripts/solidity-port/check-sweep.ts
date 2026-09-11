// The sweep gate: read a run's NDJSON rows and decide whether the result is acceptable. What counts as
// a divergence, and what --strict adds, are in README.md.

import { existsSync, readFileSync } from "node:fs";
import { KNOWN_DIVERGENCES } from "./known-divergences";
import type { CellResult, Verdict } from "./types";

/** Verdicts where the two backends agree — including agreeing to refuse the contract. */
const AGREEING: ReadonlySet<Verdict> = new Set<Verdict>(["match", "both-rejected"]);

function rowsFrom(path: string): CellResult[] {
    if (!existsSync(path)) throw new Error(`no sweep results at ${path}`);
    const rows: CellResult[] = [];
    for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const parsed = JSON.parse(line) as Partial<CellResult>;
        // The runner also appends progress lines; only scored cells carry a verdict.
        if (parsed.verdict) rows.push(parsed as CellResult);
    }
    return rows;
}

function main(): void {
    const args = process.argv.slice(2);
    const strict = args.includes("--strict");
    const path = args.find((arg) => !arg.startsWith("--")) ?? "work/sweep.jsonl";
    const rows = rowsFrom(path);
    if (rows.length === 0) throw new Error(`${path} holds no scored rows — did the sweep run?`);

    const byVerdict = new Map<Verdict, number>();
    const divergedBy = new Map<string, CellResult[]>();
    const ranBy = new Set<string>();

    for (const row of rows) {
        byVerdict.set(row.verdict, (byVerdict.get(row.verdict) ?? 0) + 1);
        ranBy.add(row.archetype);
        if (!AGREEING.has(row.verdict)) {
            const list = divergedBy.get(row.archetype) ?? [];
            list.push(row);
            divergedBy.set(row.archetype, list);
        }
    }

    console.log(`${rows.length} rows from ${path}`);
    for (const [verdict, count] of [...byVerdict].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(count).padStart(6)}  ${verdict}`);
    }

    const regressions = [...divergedBy].filter(([archetype]) => !(archetype in KNOWN_DIVERGENCES));
    // Only archetypes this run actually exercised can be judged stale; a smoke tier does not reach all.
    const stale = strict ? Object.keys(KNOWN_DIVERGENCES).filter((archetype) => ranBy.has(archetype) && !divergedBy.has(archetype)) : [];

    if (regressions.length > 0) {
        console.log(`\n${regressions.length} archetype(s) diverge that are not in KNOWN_DIVERGENCES:`);
        for (const [archetype, list] of regressions) {
            console.log(`  ${archetype} — ${list.length} row(s), first: ${list[0].verdict} ${list[0].firstDifference ?? ""}`);
        }
    }

    if (stale.length > 0) {
        console.log(`\n${stale.length} entr(y|ies) in KNOWN_DIVERGENCES no longer diverge — delete them:`);
        for (const archetype of stale) console.log(`  ${archetype} — ${KNOWN_DIVERGENCES[archetype]}`);
    }

    if (regressions.length > 0 || stale.length > 0) process.exit(1);
    const tail = strict ? ", and every one of them still diverges" : "";
    console.log(`\nok — every divergence is one of the ${Object.keys(KNOWN_DIVERGENCES).length} open findings${tail}`);
}

main();
