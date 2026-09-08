// Sweep the corpus against core's own WAMR host, looking for what a two-backend comparison
// structurally cannot see.
//
// Rounds 1-5 asked "do the two backends agree?". That question is blind to any bug in a component
// they share — the build gate, qpi.h, and above all the QubicSimulator they both execute in. This
// asks a different question, of each backend separately:
//
//     does this artifact behave the same way on the qinit simulator and on core's real runtime?
//
// A contract where both backends agree with each other and both differ from WAMR is exactly the
// class of finding no previous round could have produced.
//
// Usage:
//   bun run scripts/solidity-port/wamr-sweep.ts [--family <name>] [--limit <n>] [--backend clang|typescript|both]
import { readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

for (const family of families) {
    const scripts = readFileSync(`${CORPUS}/scripts/${family}.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as ScriptRow);
    const chosen = limit > 0 ? scripts.slice(0, limit) : scripts;

    for (const script of chosen) {
        const header = `${CORPUS}/variants/${family}/${script.contract}.h`;
        if (!existsSync(header)) continue;
        const name = script.contract.split("__")[0]!;
        considered++;

        const artifacts: { backend: string; path: string }[] = [];
        if (backendFilter !== "typescript") {
            const built = await buildContractWithClang({
                contractPath: resolve(header),
                contractName: name,
                slot: script.slot,
                corePath: CORE,
                outDir: OUT,
                skipVerify: true,
            });
            if (built.ok) artifacts.push({ backend: "clang", path: built.wasmPath! });
            else rows.push({ id: `${family}/${script.contract}`, backend: "clang", simulator: "-", wamr: "-", verdict: "build-rejected" });
        }
        if (backendFilter !== "clang") {
            // buildContractWithTypeScript, NOT the raw compileContractWithTypeScript driver. The raw
            // driver skips the build gate, so for a contract the gate refuses (F217's block shadowing,
            // the namespace alias) it returns an empty module instead of failing — which this sweep
            // then scored as 28 simulator-vs-WAMR "disagreements" that were nothing of the kind.
            const built = await buildContractWithTypeScript({
                contractPath: resolve(header),
                contractName: name,
                slot: script.slot,
                corePath: CORE,
                outDir: OUT,
                skipVerify: true,
            });
            if (built.ok) artifacts.push({ backend: "typescript", path: built.wasmPath! });
            else rows.push({ id: `${family}/${script.contract}`, backend: "typescript", simulator: "-", wamr: "-", verdict: "build-rejected" });
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

const tally = rows.reduce<Record<string, number>>((into, row) => ({ ...into, [row.verdict]: (into[row.verdict] ?? 0) + 1 }), {});
console.log(`\n${considered} contracts considered, ${rows.length} artifact runs`);
for (const [verdict, count] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`  ${String(count).padStart(5)}  ${verdict}`);
await Bun.write("work/wamr-sweep.jsonl", rows.map((row) => JSON.stringify(row)).join("\n"));
console.log("\nrows -> work/wamr-sweep.jsonl");
process.exit(tally["DISAGREE"] ? 1 : 0);
