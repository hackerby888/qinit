import { DiagnosticSeverity } from "../../src/shared/enums";
// Dual-backend corpus verification: clang and TypeScript.
import { describe, expect, beforeAll } from "bun:test";
import {
    readFileSync,
    writeFileSync,
    appendFileSync,
    mkdtempSync,
    rmSync,
    existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initK12 } from "@qinit/core";
import { runContractTesting } from "@qinit/engine";
import { buildContractWithWasiClang, buildCorpusRunner } from "@qinit/build";
import {
    compileContract,
    loadQpiHeader,
    type CompileResult,
    type ContractIdl,
} from "../../src/index";
import { CORE } from "../support/qutil-bridge";
import {
    toolchainTest,
    wasiToolchain,
    type ToolchainStatus,
} from "../support/container-toolchains";

// The parity and sweep cells need the wasi toolchain plus their env selector, so both gate the skip.
function cellStatus(when: boolean, detail: string): ToolchainStatus {
    return when ? wasiToolchain() : { available: false, detail };
}

// The single-cell child entry drives an already-built runner, so it needs no toolchain of its own.
const singleCell: ToolchainStatus = process.env.SC_SINGLE
    ? { available: true, detail: "SC_SINGLE" }
    : { available: false, detail: "set SC_SINGLE=1 to run one cell" };
const parity = cellStatus(
    !process.env.SC_SINGLE && !process.env.SC_TYPESCRIPT_ONLY,
    "SC_SINGLE / SC_TYPESCRIPT_ONLY selects a different cell",
);
const sweep = cellStatus(
    Boolean(process.env.SC_SWEEP) && !process.env.SC_SINGLE,
    "set SC_SWEEP=1 (without SC_SINGLE) to run the sweep",
);

interface CalleeSpec {
    name: string;
    header: string;
    stateType: string;
    slot: number;
}

interface Spec {
    corpus: string;
    header: string;
    name: string;
    stateType: string;
    slot: number;
    callees: CalleeSpec[];
}

const ARENA = 8 * 1024 * 1024;
type CorpusCompilerBackend = "clang" | "typescript";

const SPECS: Spec[] = [
    {
        corpus: "contract_qutil.cpp",
        header: "QUtil.h",
        name: "QUTIL",
        stateType: "QUTIL",
        slot: 4,
        callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
    },
    {
        corpus: "contract_qrp.cpp",
        header: "QReservePool.h",
        name: "QRP",
        stateType: "QRP",
        slot: 21,
        callees: [
            { name: "RANDOM", header: "Random.h", stateType: "RANDOM", slot: 3 },
            { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
        ],
    },
    {
        corpus: "contract_vottunbridge.cpp",
        header: "VottunBridge.h",
        name: "VOTTUNBRIDGE",
        stateType: "VOTTUNBRIDGE",
        slot: 25,
        callees: [],
    },
    {
        corpus: "contract_qearn.cpp",
        header: "Qearn.h",
        name: "QEARN",
        stateType: "QEARN",
        slot: 9,
        callees: [],
    },
    {
        corpus: "contract_gqmprop.cpp",
        header: "GeneralQuorumProposal.h",
        name: "GQMPROP",
        stateType: "GQMPROP",
        slot: 6,
        callees: [],
    },
    {
        corpus: "contract_ccf.cpp",
        header: "ComputorControlledFund.h",
        name: "CCF",
        stateType: "CCF",
        slot: 8,
        callees: [],
    },
    {
        corpus: "contract_random.cpp",
        header: "Random.h",
        name: "RANDOM",
        stateType: "RANDOM",
        slot: 3,
        callees: [],
    },
    {
        corpus: "contract_qip.cpp",
        header: "QIP.h",
        name: "QIP",
        stateType: "QIP",
        slot: 18,
        callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
    },
    {
        corpus: "contract_qraffle.cpp",
        header: "QRaffle.h",
        name: "QRAFFLE",
        stateType: "QRAFFLE",
        slot: 19,
        callees: [{ name: "QX", header: "Qx.h", stateType: "QX", slot: 1 }],
    },
    {
        corpus: "contract_qduel.cpp",
        header: "QDuel.h",
        name: "QDUEL",
        stateType: "QDUEL",
        slot: 23,
        callees: [
            { name: "RANDOM", header: "Random.h", stateType: "RANDOM", slot: 3 },
            { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
        ],
    },
    {
        corpus: "contract_rl.cpp",
        header: "RandomLottery.h",
        name: "RL",
        stateType: "RL",
        slot: 16,
        callees: [{ name: "RANDOM", header: "Random.h", stateType: "RANDOM", slot: 3 }],
    },
    {
        corpus: "contract_ggwp.cpp",
        header: "GGWP.h",
        name: "GGWP",
        stateType: "WOLFPACK",
        slot: 28,
        callees: [],
    },
    {
        corpus: "contract_qtf.cpp",
        header: "QThirtyFour.h",
        name: "QTF",
        stateType: "QTF",
        slot: 22,
        callees: [
            { name: "RANDOM", header: "Random.h", stateType: "RANDOM", slot: 3 },
            { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
            { name: "QRP", header: "QReservePool.h", stateType: "QRP", slot: 21 },
        ],
    },
    {
        corpus: "contract_pulse.cpp",
        header: "Pulse.h",
        name: "PULSE",
        stateType: "PULSE",
        slot: 24,
        callees: [
            { name: "RANDOM", header: "Random.h", stateType: "RANDOM", slot: 3 },
            { name: "RL", header: "RandomLottery.h", stateType: "RL", slot: 16 },
            { name: "QRP", header: "QReservePool.h", stateType: "QRP", slot: 21 },
            { name: "QTF", header: "QThirtyFour.h", stateType: "QTF", slot: 22 },
            { name: "QX", header: "Qx.h", stateType: "QX", slot: 1 },
        ],
    },
];

function calleeIdlFrom(name: string, slot: number, r: CompileResult): ContractIdl {
    if (!r.idl) {
        throw new Error(`missing IDL for callee '${name}'`);
    }

    return {
        ...r.idl,
        name,
        slot,
    };
}

async function buildRunnerFor(spec: Spec, outDir: string): Promise<Uint8Array> {
    const r = await buildCorpusRunner({
        corpusPath: `${CORE}/test/${spec.corpus}`,
        contractPath: `${CORE}/src/contracts/${spec.header}`,
        name: spec.name,
        stateType: spec.stateType,
        slot: spec.slot,
        corePath: CORE,
        outDir,
        arenaSizeBytes: ARENA,
    });

    if (!r.ok || !r.wasmPath) {
        const lines = (r.stderr ?? "")
            .split("\n")
            .filter((l) => /error:|undefined|cannot|fatal/i.test(l));
        throw new Error(`runner build failed: ${lines.slice(0, 6).join(" | ")}`);
    }

    return new Uint8Array(readFileSync(r.wasmPath));
}

async function buildWithTypeScript(spec: Spec): Promise<Record<number, Uint8Array>> {
    const headers = loadQpiHeader(CORE);
    const out: Record<number, Uint8Array> = {};
    const calleeResults: CompileResult[] = [];

    for (const callee of spec.callees) {
        const src = readFileSync(`${CORE}/src/contracts/${callee.header}`, "utf8");
        const prior = spec.callees.slice(0, calleeResults.length);
        const priorIdl = prior.map((item, index) =>
            calleeIdlFrom(item.name, item.slot, calleeResults[index]),
        );
        const priorSources = prior.map((item) => ({
            name: item.name,
            source: readFileSync(`${CORE}/src/contracts/${item.header}`, "utf8"),
        }));
        const r = await compileContract({
            source: src,
            contractName: callee.name,
            slot: callee.slot,
            qpiHeader: headers,
            arenaSizeBytes: ARENA,
            callees: priorIdl.length ? priorIdl : undefined,
            calleeSources: priorSources.length ? priorSources : undefined,
        });
        const errs = r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
        if (errs.length) {
            throw new Error(
                `typescript ${callee.name}: ${errs.map((d) => `L${d.span.line} ${d.message}`).join("; ")}`,
            );
        }
        calleeResults.push(r);
        out[callee.slot] = r.wasm;
    }

    const mainSrc = readFileSync(`${CORE}/src/contracts/${spec.header}`, "utf8");
    const callees = spec.callees.map((c, i) => calleeIdlFrom(c.name, c.slot, calleeResults[i]));
    const calleeSources = spec.callees.map((c) => ({
        name: c.name,
        source: readFileSync(`${CORE}/src/contracts/${c.header}`, "utf8"),
    }));

    const mainR = await compileContract({
        source: mainSrc,
        contractName: spec.name,
        slot: spec.slot,
        qpiHeader: headers,
        arenaSizeBytes: ARENA,
        callees,
        calleeSources,
    });
    const mainErrs = mainR.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
    if (mainErrs.length) {
        throw new Error(
            `typescript ${spec.name}: ${mainErrs.map((d) => `L${d.span.line} ${d.message}`).join("; ")}`,
        );
    }
    out[spec.slot] = mainR.wasm;

    return out;
}

async function buildWithClang(spec: Spec, outDir: string): Promise<Record<number, Uint8Array>> {
    const out: Record<number, Uint8Array> = {};

    for (const callee of spec.callees) {
        const r = await buildContractWithWasiClang({
            contractPath: `${CORE}/src/contracts/${callee.header}`,
            name: callee.name,
            stateType: callee.stateType,
            slot: callee.slot,
            corePath: CORE,
            outDir,
            arenaSizeBytes: ARENA,
            skipVerify: true,
        });
        if (!r.ok || !r.wasmPath) {
            throw new Error(
                `clang ${callee.name}: ${(r.stderr ?? "").split("\n").slice(-3).join(" | ")}`,
            );
        }
        out[callee.slot] = new Uint8Array(readFileSync(r.wasmPath));
    }

    const mainR = await buildContractWithWasiClang({
        contractPath: `${CORE}/src/contracts/${spec.header}`,
        name: spec.name,
        stateType: spec.stateType,
        slot: spec.slot,
        corePath: CORE,
        outDir,
        arenaSizeBytes: ARENA,
        skipVerify: true,
    });
    if (!mainR.ok || !mainR.wasmPath) {
        throw new Error(
            `clang ${spec.name}: ${(mainR.stderr ?? "").split("\n").slice(-3).join(" | ")}`,
        );
    }
    out[spec.slot] = new Uint8Array(readFileSync(mainR.wasmPath));

    return out;
}

// Child mode runs one spec/backend cell and writes its result to SC_OUT.
async function runSingleCell(): Promise<void> {
    const outPath = process.env.SC_OUT!;
    const [name, compilerBackend] = (process.env.SC_SINGLE ?? "").split("|");
    const spec = SPECS.find((s) => s.name === name);

    if (!spec) {
        appendFileSync(outPath, "RUNNER err\nERR unknown spec\n");
        return;
    }
    if (compilerBackend !== "clang" && compilerBackend !== "typescript") {
        appendFileSync(outPath, "RUNNER err\nERR unknown compiler backend\n");
        return;
    }

    const dir = mkdtempSync(join(tmpdir(), `qinit-cell-${name.toLowerCase()}-${compilerBackend}-`));
    let runnerOk = false;

    try {
        const runner = await buildRunnerFor(spec, dir);
        runnerOk = true;
        appendFileSync(outPath, "RUNNER ok\n");

        const contracts =
            compilerBackend === "typescript"
                ? await buildWithTypeScript(spec)
                : await buildWithClang(spec, dir);
        const results = await runContractTesting(runner, contracts);
        const passed = results.filter((r) => r.passed).length;
        appendFileSync(outPath, `SCORE ${passed}/${results.length}\n`);
        for (const result of results.filter((item) => !item.passed)) {
            appendFileSync(
                outPath,
                `FAIL ${result.name} — ${result.message.replace(/\s+/g, " ").slice(0, 300)}\n`,
            );
        }
    } catch (e: any) {
        if (!runnerOk) {
            appendFileSync(outPath, "RUNNER err\n");
        }
        const msg = String(e?.message ?? e)
            .split("\n")[0]
            .slice(0, 200);
        appendFileSync(outPath, `ERR ${msg}\n`);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

interface Cell {
    runner: string;
    score: string;
}

// Spawn this file under `bun test` with SC_SINGLE set, kill it at a deadline, and read its temp result.
async function spawnCell(
    name: string,
    compilerBackend: CorpusCompilerBackend,
    timeoutMs: number,
): Promise<Cell> {
    const outPath = join(
        tmpdir(),
        `qinit-cell-${name.toLowerCase()}-${compilerBackend}-${Date.now()}.txt`,
    );
    writeFileSync(outPath, "");

    const proc = Bun.spawn([process.execPath, "test", import.meta.path], {
        cwd: join(import.meta.dir, "..", ".."),
        env: {
            ...process.env,
            SC_SINGLE: `${name}|${compilerBackend}`,
            SC_OUT: outPath,
            SC_SWEEP: "",
        },
        stdout: "ignore",
        stderr: "ignore",
    });

    let killed = false;
    const timer = setTimeout(() => {
        killed = true;
        proc.kill(9);
    }, timeoutMs);

    await proc.exited;
    clearTimeout(timer);

    const text = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
    rmSync(outPath, { force: true });

    const runner = /RUNNER ok/.test(text) ? "ok" : "err";

    const scoreMatch = text.match(/SCORE (\d+\/\d+)/);
    let score: string;
    if (scoreMatch) {
        score = scoreMatch[1];
    } else if (killed) {
        score = "hang";
    } else {
        score = "err";
    }

    return { runner, score };
}

describe("sc-corpus — dual-backend EASY-tier sweep", () => {
    beforeAll(async () => {
        await initK12();
    });

    toolchainTest(
        "__single-cell child entry",
        singleCell,
        async () => {
            await runSingleCell();
        },
        600000,
    );

    toolchainTest(
        "QUTIL parity: clang >= 51 AND typescript >= 51 via qinit harness",
        parity,
        async () => {
            const spec = SPECS.find((s) => s.name === "QUTIL")!;
            const dir = mkdtempSync(join(tmpdir(), "qinit-parity-qutil-"));

            try {
                const runner = await buildRunnerFor(spec, dir);
                const clang = await buildWithClang(spec, dir);
                const typescript = await buildWithTypeScript(spec);

                const clangResults = await runContractTesting(runner, clang);
                const typescriptResults = await runContractTesting(runner, typescript);

                const clangPassed = clangResults.filter((r) => r.passed).length;
                const typescriptPassed = typescriptResults.filter((r) => r.passed).length;

                console.log(`\n  [clang] QUTIL: ${clangPassed}/${clangResults.length} PASS`);
                const tsTotal = typescriptResults.length;
                console.log(`  [typescript] QUTIL: ${typescriptPassed}/${tsTotal} PASS`);

                for (const r of clangResults.filter((r) => !r.passed).slice(0, 6)) {
                    const detail = r.message.replace(/\n/g, " ").slice(0, 100);
                    console.log(`  FAIL clang ${r.name} — ${detail}`);
                }
                for (const r of typescriptResults.filter((r) => !r.passed).slice(0, 6)) {
                    const detail = r.message.replace(/\n/g, " ").slice(0, 100);
                    console.log(`  FAIL typescript ${r.name} — ${detail}`);
                }

                expect(clangPassed).toBeGreaterThanOrEqual(51);
                expect(typescriptPassed).toBeGreaterThanOrEqual(51);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        },
        600000,
    );

    toolchainTest(
        "EASY-tier scoreboard (SC_SWEEP=1)",
        sweep,
        async () => {
            interface Row {
                name: string;
                runner: string;
                clang: string;
                typescript: string;
            }

            const CELL_TIMEOUT = 120000;
            const rows: Row[] = [];

            const selectedNames = new Set(
                (process.env.SC_SWEEP_FILTER ?? "").split(",").filter(Boolean),
            );
            const selected = selectedNames.size
                ? SPECS.filter((spec) => selectedNames.has(spec.name))
                : SPECS;
            const typescriptOnly = !!process.env.SC_TYPESCRIPT_ONLY;

            for (const spec of selected) {
                const clang = typescriptOnly
                    ? { runner: "-", score: "skip" }
                    : await spawnCell(spec.name, "clang", CELL_TIMEOUT);
                const typescript = await spawnCell(spec.name, "typescript", CELL_TIMEOUT);

                const runner = clang.runner === "ok" || typescript.runner === "ok" ? "ok" : "err";
                rows.push({
                    name: spec.name,
                    runner,
                    clang: clang.score,
                    typescript: typescript.score,
                });
                console.log(
                    `  [${spec.name}] runner:${runner}  clang:${clang.score}  typescript:${typescript.score}`,
                );
            }

            const column = (s: string, w: number) => s.padEnd(w);
            const header = [
                column("CONTRACT", 16),
                column("RUNNER", 8),
                column("CLANG", 10),
                column("TYPESCRIPT", 10),
            ].join(" ");
            const sep = "-".repeat(header.length);

            const tableLines = [sep, header, sep];
            for (const row of rows) {
                tableLines.push(
                    `${column(row.name, 16)} ${column(row.runner, 8)} ${column(row.clang, 10)} ${column(row.typescript, 10)}`,
                );
            }
            tableLines.push(sep);

            const scored = (v: string) => /^\d+\/\d+$/.test(v);
            const clangScored = rows.filter((r) => scored(r.clang)).length;
            const typescriptScored = rows.filter((r) => scored(r.typescript)).length;
            tableLines.push(
                `  ${rows.length} specs · clang scored ${clangScored}/${rows.length} · typescript scored ${typescriptScored}/${rows.length}`,
            );

            console.log("\n" + tableLines.join("\n"));

            expect(rows.length).toBe(selected.length);
        },
        1800000,
    );
});
