// What E7's fix would cost. The diagnostics the editor misses are raised while lowering, so the option is
// to stop the compile one phase early — the driver's own phase tracker prices that, per deployed contract.
import { initK12 } from "@qinit/core";
import { analyzeContract } from "@qinit/compiler/analyzer";
import { compileContractWithTypeScript, loadQpiHeader } from "@qinit/compiler";
import { systemContracts, systemContractClosure, KNOWN_LOG_HEADER_VIOLATIONS } from "@qinit/build";
import { CORE_PATH, HAS_CORE } from "../../../test-utils/paths";

if (!HAS_CORE) {
    console.error("QINIT_CORE is required: this prices the compiler against core's own contracts");
    process.exit(2);
}
await initK12();
const headers = loadQpiHeader(CORE_PATH);

const ASSEMBLE = "assembling wasm";

/** Median of a few runs: a single timing on a loaded box says more about the box than the code. */
async function median(run: () => Promise<number>, samples = 3): Promise<number> {
    const times: number[] = [];
    for (let index = 0; index < samples; index++) {
        times.push(await run());
    }
    return times.sort((left, right) => left - right)[Math.floor(times.length / 2)];
}

interface Row {
    name: string;
    lines: number;
    analyzeMs: number;
    lowerMs: number;
    assembleMs: number;
}

const contracts = systemContracts(CORE_PATH).sort((left, right) => left.source.length - right.source.length);
console.log(`lowering cost: ${contracts.length} deployed contracts from contract_def.h\n`);
console.log(
    `${"CONTRACT".padEnd(10)} ${"LINES".padStart(6)} ${"ANALYZE".padStart(8)} ${"+LOWER".padStart(8)} ${"+ASSEMBLE".padStart(10)} ${"RATIO".padStart(6)}  AGREE`,
);
console.log("-".repeat(68));

const rows: Row[] = [];
const disagreed: string[] = [];
for (const contract of contracts) {
    // The build gives a contract its own callee closure, not every sibling, and exempts two contracts
    // from the log-header gate. Both matter: the looser wiring manufactures errors that are not there.
    const closure = systemContractClosure(CORE_PATH, contract.name).filter((other) => other.index !== contract.index);
    const calleeSources = closure.length ? closure.map((other) => ({ name: other.stateType, source: other.source, slot: other.index })) : undefined;
    const shared = { source: contract.source, contractName: contract.stateType, slot: contract.index, qpiHeader: headers };
    const compile = () =>
        compileContractWithTypeScript({
            ...shared,
            callees: closure.length ? closure.map((other) => other.idl) : undefined,
            calleeSources,
            strict: !KNOWN_LOG_HEADER_VIOLATIONS.has(contract.file),
        });

    // Warm both before timing either: measuring analyze first left the compile run inheriting caches
    // it had filled, which is how a strict superset of the work came out faster than its own prefix.
    analyzeContract({ ...shared, calleeSources });
    const warm = await compile();

    const phaseSums = async () => {
        const timings = (await compile()).timings ?? {};
        return Object.entries(timings).reduce((total, [phase, ms]) => (phase === ASSEMBLE ? total : total + ms), 0);
    };
    const assembleOf = async () => ((await compile()).timings ?? {})[ASSEMBLE] ?? 0;
    const lowerMs = await median(phaseSums);
    const assembleMs = await median(assembleOf);
    const analyzeMs = await median(async () => {
        const started = performance.now();
        analyzeContract({ ...shared, calleeSources });
        return performance.now() - started;
    });

    const editorErrors = analyzeContract({ ...shared, calleeSources }).diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const compileErrors = warm.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length;
    const agree = editorErrors === compileErrors;
    if (!agree) disagreed.push(`${contract.name} (editor ${editorErrors}, compile ${compileErrors})`);

    rows.push({ name: contract.name, lines: contract.source.split("\n").length, analyzeMs, lowerMs, assembleMs });
    console.log(
        `${contract.name.padEnd(10)} ${String(rows[rows.length - 1].lines).padStart(6)} ${analyzeMs.toFixed(0).padStart(6)}ms ${lowerMs.toFixed(0).padStart(6)}ms ` +
            `${assembleMs.toFixed(0).padStart(8)}ms ${(lowerMs / analyzeMs).toFixed(1).padStart(5)}x  ${agree ? "yes" : `NO — editor ${editorErrors}, compile ${compileErrors}`}`,
    );
}

// Small contracts are all fixed cost, and `assembling wasm` has a large one of its own, so the ratio is
// only meaningful where the contract dominates.
const FLOOR = 500;
const scaled = rows.filter((row) => row.lines >= FLOOR);
const ratios = scaled.map((row) => row.lowerMs / row.analyzeMs).sort((left, right) => left - right);
const assembleShare = scaled.map((row) => row.assembleMs / (row.lowerMs + row.assembleMs)).sort((left, right) => left - right);

console.log(`\nover the ${scaled.length} contracts of ${FLOOR}+ lines:`);
console.log(
    `  compile stopped after lowering, against analyze: ${ratios[0].toFixed(1)}x–${ratios[ratios.length - 1].toFixed(1)}x, median ${ratios[Math.floor(ratios.length / 2)].toFixed(1)}x`,
);
console.log(
    `  assembling wasm is ${(assembleShare[0] * 100).toFixed(0)}–${(assembleShare[assembleShare.length - 1] * 100).toFixed(0)}% of the full compile ` +
        `(median ${(assembleShare[Math.floor(assembleShare.length / 2)] * 100).toFixed(0)}%) and buys the editor nothing`,
);
console.log(`\n${rows.length - disagreed.length}/${rows.length} contracts: the editor and the compiler report the same error count`);
if (disagreed.length) console.log(`disagreed: ${disagreed.join(", ")}`);
process.exitCode = disagreed.length ? 1 : 0;
