// Run one contract through both backends and print everything a finding needs.
//
//   bun run scripts/solidity-port/triage.ts corpus/solidity-port/triage/F200-signed-div/contract.h \
//                                           corpus/solidity-port/triage/F200-signed-div/script.json
//
// This is the tool the ledger's repro blocks are cut from: it prints the per-step outputs, faults, logs
// and digests of both backends side by side, so a finding can quote the exact step where they part.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { initK12 } from "@qinit/engine";
import { runCell } from "./cell";
import { environmentFor } from "./compile";
import type { BackendRun, CallScript } from "./types";

function renderRun(run: BackendRun): string[] {
    const lines = [`  status ${run.status}  digest ${run.digest ?? "-"}  stateSize ${run.stateSize ?? "-"}  compile ${run.compileMs}ms`];
    if (run.diagnostics?.length) for (const diagnostic of run.diagnostics) lines.push(`  ! ${diagnostic.split("\n")[0].slice(0, 200)}`);
    for (const step of run.steps) {
        const detail = step.fault ? `FAULT ${step.fault}` : `out ${step.out ?? "-"}`;
        const logs = step.logs?.length ? `  logs ${step.logs.join(",")}` : "";
        lines.push(`  [${String(step.index).padStart(2)}] ${step.kind}${step.entry ? ` ${step.entry}` : ""}  ${detail}${logs}`);
    }
    return lines;
}

const [contractPath, scriptPath] = process.argv.slice(2);
if (!contractPath || !scriptPath) throw new Error("usage: triage.ts <contract.h> <script.json>");

const corePath = process.env.QINIT_CORE;
if (!corePath) throw new Error("QINIT_CORE must point at a core-lite checkout");
if (!process.env.WASM_CLANG || !process.env.WASI_SYSROOT) throw new Error("WASM_CLANG and WASI_SYSROOT must be set");

await initK12();
const source = readFileSync(contractPath, "utf8");
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as CallScript;
const contractName = basename(contractPath, extname(contractPath));

const result = await runCell(environmentFor({ corePath, cacheDir: "work/cache" }), {
    id: contractName,
    archetype: contractName,
    family: "integers",
    axis: {},
    contractName,
    source,
    script,
});

console.log(`${contractName}: ${result.verdict}${result.firstDifference ? ` — ${result.firstDifference}` : ""}`);
console.log("TypeScript backend:");
for (const line of renderRun(result.ts)) console.log(line);
console.log("clang backend:");
for (const line of renderRun(result.clang)) console.log(line);
process.exit(result.verdict === "match" ? 0 : 1);
