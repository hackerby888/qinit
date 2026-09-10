// The sweep: run every corpus contract through both backends and compare final-state digests.
//
// Parent/child, after packages/compiler/tests/gtest/sc-corpus.test.ts: each shard runs in its own
// process with a wall-clock deadline, so a compiler that hangs on one contract costs one deadline
// instead of stalling the run. Results are appended as NDJSON, so a killed run resumes where it stopped.
//
//   bun run scripts/solidity-port/run-differential.ts --tier smoke
//   bun run scripts/solidity-port/run-differential.ts --workers 3 --out work/results.jsonl
//   bun run scripts/solidity-port/run-differential.ts --single integers/PromoteAdd__base

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { initK12 } from "@qinit/engine";
import { runCell } from "./cell";
import { describeCell } from "./compare-runs";
import { environmentFor } from "./compile";
import { expandAll, TIERS, type Tier, type Variant } from "./registry";
import type { CellResult, Family, Verdict } from "./types";

interface Options {
    tier: Tier;
    family?: string;
    single?: string;
    workers: number;
    out: string;
    cacheDir: string;
    shardSize: number;
    resume: boolean;
}

function parseArguments(argv: string[]): Options {
    const value = (flag: string): string | undefined => {
        const index = argv.indexOf(flag);
        return index >= 0 ? argv[index + 1] : undefined;
    };
    const tier = (value("--tier") ?? "standard") as Tier;
    if (!(tier in TIERS)) throw new Error(`--tier must be one of ${Object.keys(TIERS).join(", ")}`);
    return {
        tier,
        family: value("--family"),
        single: value("--single"),
        workers: Number(value("--workers") ?? 3),
        out: value("--out") ?? "work/results.jsonl",
        cacheDir: value("--cache") ?? "work/cache",
        shardSize: Number(value("--shard-size") ?? 25),
        resume: !argv.includes("--no-resume"),
    };
}

function selectVariants(options: Options): Variant[] {
    const all = expandAll(options.tier, options.family ? (archetype) => archetype.family === options.family : undefined);
    if (options.single) return all.filter((variant) => variant.id === options.single || variant.archetype.name === options.single);
    return all;
}

function requireEnvironment(): { corePath: string } {
    const corePath = process.env.QINIT_CORE;
    if (!corePath) throw new Error("QINIT_CORE must point at a core-lite checkout");
    if (!process.env.WASM_CLANG || !process.env.WASI_SYSROOT) {
        // The clang half of a differential that silently skips is the classic way to report nothing.
        throw new Error("WASM_CLANG and WASI_SYSROOT must be set — a sweep without the clang backend compares nothing");
    }
    return { corePath };
}

async function runShard(variants: Variant[], outPath: string, cacheDir: string, corePath: string): Promise<void> {
    await initK12();
    const env = environmentFor({ corePath, cacheDir });
    for (const variant of variants) {
        // A BEGIN with no matching RESULT names the contract a deadline killed.
        appendFileSync(outPath, `${JSON.stringify({ begin: variant.id })}\n`);
        let result: CellResult;
        try {
            result = await runCell(env, {
                id: variant.id,
                archetype: variant.archetype.name,
                family: variant.archetype.family,
                axis: variant.axis,
                contractName: variant.archetype.name,
                source: variant.contract.source,
                script: variant.contract.script,
                callee: variant.contract.callee,
                expectReject: variant.archetype.expectReject,
                expectedVerdict: variant.archetype.expectedVerdict,
                divergenceNote: variant.archetype.divergenceNote,
            });
        } catch (error: any) {
            result = {
                id: variant.id,
                archetype: variant.archetype.name,
                family: variant.archetype.family,
                axis: variant.axis,
                verdict: "harness-error",
                firstDifference: String(error?.message ?? error),
                ts: { backend: "typescript", status: "error", steps: [], compileMs: 0, executeMs: 0 },
                clang: { backend: "clang", status: "error", steps: [], compileMs: 0, executeMs: 0 },
                totalMs: 0,
            };
        }
        appendFileSync(outPath, `${JSON.stringify(result)}\n`);
        console.log(describeCell(result));
    }
}

function completedIds(outPath: string): Set<string> {
    if (!existsSync(outPath)) return new Set();
    const done = new Set<string>();
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as { id?: string };
            if (row.id) done.add(row.id);
        } catch {
            // A truncated final line from a killed process is expected; skip it.
        }
    }
    return done;
}

function scoreboard(outPath: string): number {
    const rows: CellResult[] = [];
    const begun = new Set<string>();
    for (const line of readFileSync(outPath, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
            const row = JSON.parse(line) as CellResult & { begin?: string };
            if (row.begin) begun.add(row.begin);
            else rows.push(row);
        } catch {
            /* truncated line */
        }
    }
    for (const id of rows.map((row) => row.id)) begun.delete(id);

    const families = new Map<Family, Map<Verdict, number>>();
    for (const row of rows) {
        const counts = families.get(row.family) ?? new Map<Verdict, number>();
        counts.set(row.verdict, (counts.get(row.verdict) ?? 0) + 1);
        families.set(row.family, counts);
    }
    const verdicts: Verdict[] = ["match", "digest-mismatch", "step-mismatch", "trap-divergence", "one-side-rejected", "both-rejected", "expect-violation", "harness-error"];

    console.log("");
    console.log(`FAMILY${" ".repeat(16)}${verdicts.map((v) => v.slice(0, 9).padStart(10)).join("")}`);
    console.log("-".repeat(22 + verdicts.length * 10));
    for (const [family, counts] of [...families].sort(([left], [right]) => left.localeCompare(right))) {
        console.log(`${family.padEnd(22)}${verdicts.map((v) => String(counts.get(v) ?? 0).padStart(10)).join("")}`);
    }
    console.log("-".repeat(22 + verdicts.length * 10));

    const total = rows.length;
    const matched = rows.filter((row) => row.verdict === "match").length;
    const failures = rows.filter((row) => row.verdict !== "match");
    const times = rows.map((row) => row.totalMs).sort((a, b) => a - b);
    const median = times.length ? times[Math.floor(times.length / 2)] : 0;

    // Stimulus coverage. A corpus whose contracts never write state matches trivially and forever, so
    // these counts are what stop a green sweep from being vacuous.
    const isZero = (hex: string | undefined): boolean => hex !== undefined && /^0*$/.test(hex);
    const deadState = rows.filter((row) => isZero(row.ts.statePrefix) && isZero(row.ts.stateSuffix)).length;
    const emittedLogs = rows.filter((row) => row.ts.steps.some((step) => (step.logs?.length ?? 0) > 0)).length;
    const trapped = rows.filter((row) => row.ts.steps.some((step) => step.fault)).length;
    const distinctDigests = rows.filter((row) => new Set(row.ts.steps.map((step) => step.digest).filter(Boolean)).size > 1).length;
    const pairs = rows.filter((row) => row.ts.calleeDigest !== undefined).length;

    console.log(`${total} contracts · ${matched} match · ${failures.length} not-match · ${begun.size} hang · median ${median}ms`);
    console.log(
        `stimulus: ${distinctDigests} moved state mid-script · ${emittedLogs} emitted >=1 log · ${trapped} produced >=1 trap · ${pairs} called a callee · ${deadState} ended all-zero`,
    );
    if (deadState > 0) console.log(`  NOTE: ${deadState} contract(s) finished with an all-zero state — their scripts may never reach a state write.`);
    if (begun.size) console.log(`HANG: ${[...begun].join(", ")}`);
    for (const failure of failures.slice(0, 40)) console.log(`  ${failure.verdict}  ${failure.id}  ${failure.firstDifference ?? ""}`);
    if (failures.length > 40) console.log(`  … ${failures.length - 40} more`);

    return failures.length + begun.size;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const { corePath } = requireEnvironment();

    // Child mode: the parent hands one shard through the environment.
    const shardSpec = process.env.SOLPORT_SHARD;
    if (shardSpec) {
        const wanted = new Set(shardSpec.split(","));
        const shard = selectVariants(options).filter((variant) => wanted.has(variant.id));
        await runShard(shard, process.env.SOLPORT_OUT!, options.cacheDir, corePath);
        return;
    }

    const selected = selectVariants(options);
    if (selected.length === 0) throw new Error("no contracts selected");
    mkdirSync(dirname(options.out), { recursive: true });
    mkdirSync(options.cacheDir, { recursive: true });

    const done = options.resume ? completedIds(options.out) : new Set<string>();
    const pending = selected.filter((variant) => !done.has(variant.id));
    console.log(`selected ${selected.length} contracts · ${done.size} already done · ${pending.length} to run · tier ${options.tier}`);

    if (pending.length === 0) {
        process.exit(scoreboard(options.out) === 0 ? 0 : 1);
    }

    // A single contract runs in-process: triage wants the stack trace, not a killed child.
    if (options.single || pending.length <= 2) {
        await runShard(pending, options.out, options.cacheDir, corePath);
        process.exit(scoreboard(options.out) === 0 ? 0 : 1);
    }

    const shards: Variant[][] = [];
    for (let index = 0; index < pending.length; index += options.shardSize) shards.push(pending.slice(index, index + options.shardSize));

    let next = 0;
    const started = Date.now();
    const worker = async (): Promise<void> => {
        while (next < shards.length) {
            const shard = shards[next++];
            const deadlineMs = 60_000 + 15_000 * shard.length;
            const child = Bun.spawn([process.execPath, "run", import.meta.path, ...process.argv.slice(2)], {
                env: { ...process.env, SOLPORT_SHARD: shard.map((variant) => variant.id).join(","), SOLPORT_OUT: options.out },
                stdout: "inherit",
                stderr: "inherit",
            });
            const timer = setTimeout(() => child.kill(9), deadlineMs);
            await child.exited;
            clearTimeout(timer);
        }
    };
    await Promise.all(Array.from({ length: Math.max(1, options.workers) }, () => worker()));

    console.log(`\nsweep wall time ${(Date.now() - started) / 1000}s`);
    process.exit(scoreboard(options.out) === 0 ? 0 : 1);
}

await main();
