// Sweep the corpus against core's own WAMR host, looking for what comparing two backends against each
// other structurally cannot see. Rationale and usage are in README.md.

import { readFileSync, existsSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { resolve } from "node:path";
import { buildContractWithClang, buildContractWithTypeScript } from "@qinit/build";
import { QubicSimulator, initK12, toHex } from "@qinit/engine";
import { hostImports, unregisteredImports } from "./wamr-probe";

const GTEST = process.env.QINIT_WAMR_GTEST ?? `${process.env.QINIT_CORE}/build-wasm/test/qubic_wasm_tests`;

// The oracle binary is not in any repo and does not survive a container restart, so fail here with the
// one command that rebuilds it rather than letting every cell report a mystery trap.
if (!existsSync(GTEST)) {
    console.error(`error: the WAMR oracle is not built at ${GTEST}\n`);
    console.error("  QINIT_CORE=/path/to/core-lite scripts/solidity-port/build-wamr-oracle.sh\n");
    console.error("Then set QINIT_WAMR_GTEST to the path it prints.");
    process.exit(2);
}
const CORE = process.env.QINIT_CORE!;
const OUT = "/tmp/qinit-wamr-sweep";
const CORPUS = "corpus/solidity-port";

interface Step {
    kind: string;
    entry: number;
    in?: string;
}
interface ScriptRow {
    contract: string;
    slot: number;
    steps: Step[];
}

/** The gtest script language is procedures only; functions are read-only and cannot move state. */
const toGtestScript = (steps: Step[]): string =>
    steps
        .filter((step) => step.kind === "procedure")
        .map((step) => `${step.entry}:${step.in ?? ""}`)
        .join(";");

function underSimulator(wasm: Uint8Array, slot: number, steps: Step[]): string {
    const sim = new QubicSimulator();
    const contract = sim.deploy(slot, wasm);
    for (const step of steps) {
        if (step.kind !== "procedure") continue;
        try {
            sim.procedure(slot, step.entry, Uint8Array.from(Buffer.from(step.in ?? "", "hex")));
        } catch {
            return "TRAP";
        }
    }
    return toHex(contract.state());
}

function underWamr(wasmPath: string, slot: number, steps: Step[]): { state: string; raw: string } {
    const proc = Bun.spawnSync([GTEST, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"], {
        cwd: tmpdir(),
        env: { ...process.env, QINIT_WASM: wasmPath, QINIT_SCRIPT: toGtestScript(steps), QINIT_EXPECTED_SLOT: String(slot) },
        timeout: 60_000,
    });
    const out = proc.stdout.toString();
    if (/CROSSHOST_OP=\d+:trap/.test(out)) return { state: "TRAP", raw: out };
    const state = out.match(/CROSSHOST_STATE=([0-9a-f]+)/);
    return { state: state ? state[1]! : "NO_STATE", raw: out };
}

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
};
const familyFilter = flag("--family");
const limit = Number(flag("--limit") ?? "0");
const backendFilter = flag("--backend") ?? "both";
// Dominated by clang at roughly forty seconds per contract, uncached — hours if run serially. The work
// is independent per contract, so default to the core count.
const workers = Math.max(1, Number(flag("--workers") ?? String(Math.max(1, cpus().length))));

await initK12();

const families = (familyFilter ? [familyFilter] : ["integers", "layout", "controlflow", "containers", "namespaces", "vulnerabilities", "lifecycle"]).filter(
    (family) => existsSync(`${CORPUS}/scripts/${family}.jsonl`),
);

interface Row {
    id: string;
    backend: string;
    simulator: string;
    wamr: string;
    verdict: "agree" | "DISAGREE" | "shim-trap" | "build-rejected";
}
const rows: Row[] = [];
let considered = 0;

interface Job {
    family: string;
    script: ScriptRow;
    header: string;
    name: string;
}
const jobs: Job[] = [];
for (const family of families) {
    const scripts = readFileSync(`${CORPUS}/scripts/${family}.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ScriptRow);
    const chosen = limit > 0 ? scripts.slice(0, limit) : scripts;
    for (const script of chosen) {
        const header = `${CORPUS}/variants/${family}/${script.contract}.h`;
        if (!existsSync(header)) continue;
        jobs.push({ family, script, header, name: script.contract.split("__")[0]! });
    }
}
console.log(`${jobs.length} contracts across ${families.length} families, ${workers} workers\n`);

let nextJob = 0;
async function runJob(job: Job): Promise<void> {
    {
        const { family, script, header, name } = job;
        considered++;

        const artifacts: { backend: string; path: string }[] = [];
        if (backendFilter !== "typescript") {
            const built = await buildContractWithClang({
                contractPath: resolve(header),
                contractName: name,
                slot: script.slot,
                corePath: CORE,
                // Per-backend directory, never shared: both builders write `<outDir>/<contractName>.wasm`,
                // so a shared one has the second overwrite the first and the sweep compares an artifact to itself.
                outDir: `${OUT}/clang/${script.contract}`,
                skipVerify: true,
            });
            if (built.ok) artifacts.push({ backend: "clang", path: built.wasmPath! });
            else rows.push({ id: `${family}/${script.contract}`, backend: "clang", simulator: "-", wamr: "-", verdict: "build-rejected" });
        }
        if (backendFilter !== "clang") {
            // buildContractWithTypeScript, never the raw driver: the raw one skips the build gate and
            // returns an empty module where the gate would refuse, which scores as a false disagreement.
            const built = await buildContractWithTypeScript({
                contractPath: resolve(header),
                contractName: name,
                slot: script.slot,
                corePath: CORE,
                outDir: `${OUT}/typescript/${script.contract}`,
                skipVerify: true,
            });
            if (built.ok) artifacts.push({ backend: "typescript", path: built.wasmPath! });
            else rows.push({ id: `${family}/${script.contract}`, backend: "typescript", simulator: "-", wamr: "-", verdict: "build-rejected" });
        }

        // Two independently-produced artifacts must not be byte-identical. Identity here never means the
        // backends agree; it means the sweep is holding one file twice.
        if (artifacts.length === 2) {
            const [left, right] = artifacts.map((artifact) => readFileSync(artifact.path));
            if (left!.equals(right!)) {
                console.error(`\nFATAL: ${family}/${script.contract} produced byte-identical wasm for both backends (${left!.length} bytes).`);
                console.error(`  ${artifacts[0]!.backend}: ${artifacts[0]!.path}`);
                console.error(`  ${artifacts[1]!.backend}: ${artifacts[1]!.path}`);
                console.error("Two backends cannot agree byte-for-byte; one artifact has overwritten the other (see F219).");
                process.exit(3);
            }
        }

        for (const { backend, path } of artifacts) {
            const wasm = new Uint8Array(readFileSync(path));
            // A malformed artifact must be recorded, not allowed to end the sweep: the whole point is
            // to survey many contracts, and one that will not even deploy is itself a row worth having.
            let simulator: string;
            try {
                simulator = underSimulator(wasm, script.slot, script.steps);
            } catch (error) {
                simulator = `DEPLOY-FAILED(${(error as Error).message.split("\n")[0]})`;
            }
            const { state: wamr } = underWamr(path, script.slot, script.steps);

            // A WAMR-only trap in a module that imports host functions the gtest does not register is
            // the missing shim, not a divergence. A WAMR-only trap with nothing unregistered is real.
            let verdict: Row["verdict"];
            if (simulator === wamr) verdict = "agree";
            else if (wamr === "TRAP" && unregisteredImports(wasm).length > 0) verdict = "shim-trap";
            else verdict = "DISAGREE";

            rows.push({ id: `${family}/${script.contract}`, backend, simulator, wamr, verdict });
            if (verdict === "DISAGREE") {
                console.log(`DISAGREE  ${backend.padEnd(11)} ${family}/${script.contract}`);
                console.log(`            simulator ${simulator.slice(0, 96)}`);
                console.log(`            WAMR      ${wamr.slice(0, 96)}`);
                console.log(`            imports   ${hostImports(wasm).length} lhost, ${unregisteredImports(wasm).length} unregistered`);
            }
        }
    }
}

await Promise.all(
    Array.from({ length: workers }, async () => {
        for (;;) {
            const index = nextJob++;
            if (index >= jobs.length) return;
            await runJob(jobs[index]!);
            if (considered % 25 === 0) console.log(`  ... ${considered}/${jobs.length}`);
        }
    }),
);

const tally = rows.reduce<Record<string, number>>((into, row) => ({ ...into, [row.verdict]: (into[row.verdict] ?? 0) + 1 }), {});
console.log(`\n${considered} contracts considered, ${rows.length} artifact runs`);
for (const [verdict, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${verdict}`);
await Bun.write("work/wamr-sweep.jsonl", rows.map((row) => JSON.stringify(row)).join("\n"));
console.log("\nrows -> work/wamr-sweep.jsonl");
process.exit(tally["DISAGREE"] ? 1 : 0);
