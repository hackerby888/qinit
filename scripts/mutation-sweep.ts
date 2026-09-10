// Mutation sweep: break one source line, run tests, restore — a survivor is code nothing guards. JSON list: [{ label, file, from, to, fast?, slow? }].
// An anchor must match exactly once or the mutation is skipped: an ambiguous anchor mutates the wrong line, or nothing, and either reads as a clean pass.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemContracts } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";

interface Mutation {
    label: string;
    file: string;
    from: string;
    to: string;
    fast?: string;
    slow?: string;
}

// Without a core checkout the differentials skip, turning every mutation they would have caught into a false survivor.
const corePath = process.env.QINIT_CORE;
if (!corePath) {
    throw new Error("QINIT_CORE is required: without it the slow phase skips rather than runs, and every survivor it reports is false");
}
const core = resolve(corePath);
const repoRoot = resolve(import.meta.dir, "..");

const DEFAULT_FAST = "packages/compiler/tests/frontend packages/compiler/tests/edge packages/compiler/tests/qpi";
const DEFAULT_SLOW = "packages/compiler/tests/differential packages/compiler/tests/gtest packages/compiler/tests/integration";
const TEST_TIMEOUT_MS = 900_000;

function failureCount(testPaths: string): number {
    const result = Bun.spawnSync(["bun", "test", ...testPaths.split(/\s+/)], {
        cwd: repoRoot,
        env: process.env,
        timeout: TEST_TIMEOUT_MS,
        stdout: "pipe",
        stderr: "pipe",
    });
    const output = result.stdout.toString() + result.stderr.toString();
    const match = output.match(/^\s*(\d+) fail/m);
    return match ? Number(match[1]) : 0;
}

// Restore has to survive a kill, or an interrupted run leaves a mutated source in the tree.
const originals = new Map<string, string>();

function restoreAll(): void {
    for (const [path, contents] of originals) {
        writeFileSync(path, contents);
    }
    originals.clear();
}

process.on("SIGINT", () => {
    restoreAll();
    process.exit(130);
});

function applyMutation(mutation: Mutation): boolean {
    const path = join(repoRoot, mutation.file);
    const source = readFileSync(path, "utf8");
    const occurrences = source.split(mutation.from).length - 1;
    if (occurrences !== 1) {
        console.log(`${mutation.label.padEnd(44)}SKIPPED (anchor matched ${occurrences} times)`);
        return false;
    }
    originals.set(path, source);
    writeFileSync(path, source.replace(mutation.from, mutation.to));
    return true;
}

function runList(listPath: string): void {
    const mutations: Mutation[] = JSON.parse(readFileSync(listPath, "utf8"));
    for (const mutation of mutations) {
        if (!applyMutation(mutation)) {
            continue;
        }
        try {
            const fastFailures = failureCount(mutation.fast ?? DEFAULT_FAST);
            if (fastFailures > 0) {
                console.log(`${mutation.label.padEnd(44)}caught: fast (${fastFailures} fail)`);
                continue;
            }
            const slowFailures = failureCount(mutation.slow ?? DEFAULT_SLOW);
            if (slowFailures > 0) {
                console.log(`${mutation.label.padEnd(44)}caught: slow only (${slowFailures} fail)`);
                continue;
            }
            console.log(`${mutation.label.padEnd(44)}*** SURVIVED ***`);
        } finally {
            restoreAll();
        }
    }
}

// Every sibling is offered as a callee so inter-contract calls resolve without a dependency table; one that then fails to compile is reported, not hidden.
async function runReachProbe(): Promise<void> {
    await initK12();
    const qpiHeader = loadQpiHeader(core);
    const contracts = systemContracts(core);

    for (const contract of contracts) {
        const others = contracts.filter((other) => other.name !== contract.name);
        let digest: string;
        try {
            const result = await compileContractWithTypeScript({
                source: contract.source,
                contractName: contract.name,
                slot: contract.index,
                qpiHeader,
                arenaSizeBytes: 64 * 1024 * 1024,
                callees: others.map((other) => ({ ...other.idl, name: other.name, slot: other.index })),
                calleeSources: others.map((other) => ({ name: other.name, source: other.source })),
            });
            digest = result.wasm?.length ? createHash("sha256").update(result.wasm).digest("hex").slice(0, 12) : "no-wasm";
        } catch (error) {
            digest = `threw: ${String(error).slice(0, 50)}`;
        }
        console.log(`${contract.name}\t${digest}`);
    }
}

const [argument] = process.argv.slice(2);
if (argument === "--reach") {
    await runReachProbe();
} else if (argument) {
    runList(argument);
} else {
    throw new Error("usage: mutation-sweep.ts <mutations.json> | --reach");
}
