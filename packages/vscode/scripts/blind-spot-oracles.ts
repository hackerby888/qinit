// Round 29: for each class the blind-spot differential closed, which oracle actually speaks? Round 21
// recorded clang rejecting all 22; round 28 measured clang silent on the log payload. One of them is wrong.
import { readFileSync, mkdtempSync, rmSync, globSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { analyzeContract, DiagnosticSeverity } from "@qinit/compiler/analyzer";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { initK12 } from "@qinit/core";
import { environmentFor, compileWith } from "../../../scripts/solidity-port/compile";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required");
    process.exit(2);
}

// The corpus is found from the repo, not the shell: the sweep is run from a tmp directory so a core
// binary cannot litter the tree.
const REPO_ROOT = resolve(import.meta.dir, "../../..");

// One contract per class is enough to settle which oracle speaks: the corpus families are generated
// from one template, so every member of a family has the same shape and the same verdict.
const DEFAULT_CLASSES: Array<{ label: string; glob: string }> = [
    { label: "log payload, field after _terminator", glob: "corpus/solidity-port/variants/logging/LogTerminatorFirst__*.h" },
    { label: "enum constant hidden by a member fn ", glob: "corpus/solidity-port/variants/namespaces/NsEnumConstantHiddenByMember__*.h" },
];

// Globs on the command line triage a new class without editing the defaults above.
const requested = process.argv.slice(2);
const CLASSES = requested.length > 0 ? requested.map((glob) => ({ label: glob.split("/").pop() ?? glob, glob })) : DEFAULT_CLASSES;

await initK12();
const qpiHeader = loadQpiHeader(CORE_PATH);
const cacheDir = mkdtempSync(join(tmpdir(), "blind-spot-oracles-"));
const environment = environmentFor({ corePath: CORE_PATH, cacheDir });

const errorMessagesOf = (diagnostics: readonly { severity: string; message?: string }[]) =>
    diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR).map((item) => String(item.message ?? "").slice(0, 100));

try {
    for (const contractClass of CLASSES) {
        const paths = globSync(isAbsolute(contractClass.glob) ? contractClass.glob : join(REPO_ROOT, contractClass.glob)).sort();

        if (paths.length === 0) {
            console.log(`\n${contractClass.label} -> no corpus instance on disk`);
            continue;
        }

        const path = paths[0]!;
        const source = readFileSync(path, "utf8");
        const contractName = source.match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/)?.[1] ?? "Contract";

        const editorErrors = errorMessagesOf(analyzeContract({ source, contractName, slot: 31, qpiHeader }).diagnostics);
        const built = await compileContractWithTypeScript({ source, contractName, slot: 31, qpiHeader, arenaSizeBytes: 1 << 20 });
        const backendErrors = errorMessagesOf(built.diagnostics);
        const clangBuild = await compileWith(environment, "clang", { main: { name: contractName, source, slot: 31 } });
        const clangStderr = String(clangBuild.main.diagnostics[0] ?? "").replace(/\n/g, " ");

        console.log(`\n${contractClass.label}   (${paths.length} in the corpus, showing ${path.split("/").pop()})`);
        console.log(`  qinit editor  : ${editorErrors.length > 0 ? editorErrors.join(" | ") : "clean"}`);
        console.log(`  qinit backend : ${backendErrors.length > 0 ? backendErrors.join(" | ") : "clean"}`);
        console.log(`  clang         : ${clangBuild.main.ok ? "accepts" : `REJECTS -> ${clangStderr.slice(0, 700)}`}`);
    }
} finally {
    rmSync(cacheDir, { recursive: true, force: true });
}
