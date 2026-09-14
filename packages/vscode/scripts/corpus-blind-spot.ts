// Round 20: every generated corpus contract through both oracles, to size the editor's blind spot.
// The editor stops before lowering a function body, so a diagnostic raised there reaches no one.
import { readFileSync, globSync } from "node:fs";
import { analyzeContract, DiagnosticSeverity } from "@qinit/compiler/analyzer";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { initK12 } from "@qinit/core";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}

// The compile pipeline hashes through K12; without this the backend returns no diagnostics at all.
await initK12();
const qpiHeader = loadQpiHeader(CORE_PATH);

// The intercontract family pairs each caller with a callee the generator holds in memory and never writes
// to disk, so compiling one alone fails on the missing callee — the harness's doing, not the editor's.
const CONTAMINATED_FAMILY = "intercontract";

const contractNameOf = (source: string) => source.match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/)?.[1];
const errorsOf = (diagnostics: readonly { severity: string; code?: string; message?: string }[]) =>
    diagnostics
        .filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)
        // A diagnostic raised while lowering carries a message and no code, which is the shape being counted.
        .map((diagnostic) => diagnostic.code ?? `(uncoded) ${String(diagnostic.message ?? "").slice(0, 70)}`);

const files = globSync("corpus/solidity-port/variants/**/*.h").sort();
if (files.length === 0) {
    console.error("no corpus on disk — run `bun run corpus:generate` first");
    process.exit(2);
}

let agreeClean = 0;
let agreeError = 0;
let falsePositives = 0;
let skipped = 0;
const blind = new Map<string, { family: string; example: string; count: number }>();

for (const path of files) {
    const family = path.split("/")[3] ?? "?";
    if (family === CONTAMINATED_FAMILY) {
        skipped++;
        continue;
    }

    const source = readFileSync(path, "utf8");
    const contractName = contractNameOf(source);
    if (!contractName) {
        skipped++;
        continue;
    }

    let editorErrors: string[] = [];
    try {
        editorErrors = errorsOf(analyzeContract({ source, contractName, slot: 31, qpiHeader }).diagnostics);
    } catch {
        editorErrors = ["(threw)"];
    }

    let backendErrors: string[] = [];
    try {
        const built = await compileContractWithTypeScript({ source, contractName, slot: 31, qpiHeader, arenaSizeBytes: 1 << 20 });
        backendErrors = errorsOf(built.diagnostics);
    } catch {
        skipped++;
        continue;
    }

    if (editorErrors.length === 0 && backendErrors.length === 0) {
        agreeClean++;
    } else if (editorErrors.length > 0 && backendErrors.length > 0) {
        agreeError++;
    } else if (editorErrors.length > 0) {
        falsePositives++;
        console.log(`FALSE POSITIVE  ${path}  -> ${editorErrors.join("; ")}`);
    } else {
        const key = backendErrors[0]!;
        const seen = blind.get(key);
        if (seen) seen.count++;
        else blind.set(key, { family, example: path, count: 1 });
    }
}

const blindTotal = [...blind.values()].reduce((sum, entry) => sum + entry.count, 0);
console.log(`\n${files.length - skipped} contracts compared (${skipped} skipped: the ${CONTAMINATED_FAMILY} family and any that would not build standalone)`);
console.log(`  agree, both clean    ${agreeClean}`);
console.log(`  agree, both error    ${agreeError}`);
console.log(`  editor silent, backend refuses   ${blindTotal}  in ${blind.size} distinct classes`);
console.log(`  editor errors, backend clean     ${falsePositives}`);

for (const [message, entry] of [...blind].sort((left, right) => right[1].count - left[1].count)) {
    console.log(`\n  ${entry.count}x  ${entry.family}: ${message}`);
    console.log(`      ${entry.example}`);
}
