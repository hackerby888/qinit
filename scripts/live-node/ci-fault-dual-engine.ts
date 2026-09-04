// Every contract failure class on both runtimes: a function abort fails only its query, a procedure trap
// or abort halts the node behind a fault and a trace frame, and a migration abort halts the same way.
// The simulator leg runs in-process. The core node at QINIT_RPC runs one case (QINIT_FAULT_CASE =
// fn|trap|abort|migrate) with one compiler (QINIT_FAULT_COMPILER = TS|Clang), because a halted node
// does not come back; without QINIT_FAULT_CASE only the simulator leg runs, every case and compiler.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { deployContract } from "@qinit/cli/ops/deploy";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, loadQpiHeader } from "@qinit/compiler";
import { DEFAULT_RPC_BASE, DEFAULT_WASM_SLOT_LAYOUT, initK12, k12Hex, LiteRpc, type EngineFaultInfo } from "@qinit/core";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { invokeProcedure } from "@qinit/proto";
import { assertPinnedQpiHeader } from "./core-proof";

const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const core = process.env.QINIT_CORE;
if (!core) {
    throw new Error("QINIT_CORE not set");
}

type Compiler = "TS" | "Clang";
type FaultCase = "fn" | "trap" | "abort" | "migrate";
const CASES: readonly FaultCase[] = ["fn", "trap", "abort", "migrate"];
const COMPILERS: readonly Compiler[] = ["TS", "Clang"];

function fail(message: string): never {
    throw new Error(`FAULT MATRIX FAIL: ${message}`);
}

const coreCase = process.env.QINIT_FAULT_CASE as FaultCase | undefined;
const coreCompiler = (process.env.QINIT_FAULT_COMPILER ?? "TS") as Compiler;
if (coreCase && !CASES.includes(coreCase)) {
    fail(`QINIT_FAULT_CASE must be one of ${CASES.join("|")}`);
}
if (!COMPILERS.includes(coreCompiler)) {
    fail("QINIT_FAULT_COMPILER must be TS or Clang");
}

const ARENA_SIZE = DEFAULT_COMPILE_ARENA_SIZE_BYTES;
const FALLBACK_SEED = "a".repeat(55);
const ASSERT_FN = 1;
const ASSERT = 1;
const OVERFLOW = 2;
const INC = 1;
const FN_ABORT_CODE = 3422552091; // 0xCC000000 | the CC_ASSERT line of FaultZoo.AssertFn
const scratch = mkdtempSync(join(tmpdir(), "qinit-fault-matrix-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));

interface Artifact {
    compiler: Compiler;
    name: string;
    path: string;
    slot: number;
    wasm: Uint8Array;
    hash: string;
    registration: { functions: number; procedures: number };
}

function uint64(bytes: Uint8Array, index: number): bigint {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(index * 8, true);
}

function u64(value: bigint): Uint8Array {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setBigUint64(0, value, true);
    return bytes;
}

function sleep(ms: number): Promise<void> {
    return new Promise((done) => setTimeout(done, ms));
}

async function compileTs(name: string, path: string, slot: number, qpiHeader: string): Promise<Artifact> {
    const result = await compileContractWithTypeScript({ source: readFileSync(path, "utf8"), contractName: name, slot, qpiHeader, arenaSizeBytes: ARENA_SIZE });
    const errors = result.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
    if (errors.length || !result.wasm.length || !result.idl) {
        fail(`TS ${name} compile: ${errors.map((item) => item.message).join("; ") || "empty artifact"}`);
    }
    return {
        compiler: "TS",
        name,
        path,
        slot,
        wasm: result.wasm,
        hash: await k12Hex(result.wasm),
        registration: { functions: result.idl.functions.length, procedures: result.idl.procedures.length },
    };
}

async function compileClang(name: string, path: string, slot: number): Promise<Artifact> {
    const result = await buildContractWithClang({
        contractPath: path,
        contractName: name,
        slot,
        corePath: core!,
        outDir: join(scratch, `clang-${name}-${slot}`),
        arenaSizeBytes: ARENA_SIZE,
    });
    if (!result.ok || !result.wasmPath || !result.idl) {
        fail(`Clang ${name} compile: ${result.stderr ?? "no artifact"}`);
    }
    const wasm = new Uint8Array(readFileSync(result.wasmPath));
    return {
        compiler: "Clang",
        name,
        path,
        slot,
        wasm,
        hash: await k12Hex(wasm),
        registration: { functions: result.idl.functions.length, procedures: result.idl.procedures.length },
    };
}

async function deploy(base: string, rpc: LiteRpc, seed: string, item: Artifact) {
    return deployContract(
        {
            contractPath: item.path,
            name: item.name,
            core: core!,
            rpcBaseUrl: base,
            rpc,
            seed,
            slotOverride: item.slot,
            artifact: { wasm: item.wasm, hash: item.hash, registration: item.registration },
        },
        () => {},
    );
}

async function deployOrFail(base: string, rpc: LiteRpc, seed: string, item: Artifact): Promise<void> {
    const deployed = await deploy(base, rpc, seed, item);
    if (!deployed.ok || !deployed.armed || !deployed.constructed) {
        fail(`${base} ${item.compiler} ${item.name} deploy: ${JSON.stringify(deployed)}`);
    }
}

async function latestSeq(rpc: LiteRpc): Promise<number> {
    const trace = await rpc.debugTrace(0, 256);
    return trace.entries.reduce((latest, entry) => Math.max(latest, entry.seq), 0);
}

async function frameAfter(rpc: LiteRpc, since: number, slot: number, kind: number, entry: number) {
    const trace = await rpc.debugTrace(since, 64);
    return trace.entries.find((candidate) => candidate.index === slot && candidate.kind === kind && candidate.entry === entry && !candidate.ok);
}

async function ticksBetween(rpc: LiteRpc): Promise<number> {
    const first = (await rpc.tickInfo()).tick;
    await sleep(2500);
    return (await rpc.tickInfo()).tick - first;
}

async function waitForFault(rpc: LiteRpc, label: string): Promise<EngineFaultInfo> {
    for (let attempt = 0; attempt < 120; attempt++) {
        const fault = await rpc.faultInfo();
        if (fault) {
            return fault;
        }
        await sleep(500);
    }
    fail(`${label}: the node never reported a fault`);
}

async function sendProcedure(
    base: string,
    rpc: LiteRpc,
    seed: string,
    slot: number,
    procedureId: number,
    inputFormat: string,
    confirm: boolean,
): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId,
        amount: 0,
        inputFormat,
        tick,
        confirm,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || (confirm && !result.included)) {
        fail(`${base} slot ${slot} procedure ${procedureId} was not included: ${JSON.stringify(result)}`);
    }
}

async function runFn(label: string, base: string, rpc: LiteRpc, seed: string, faultZoo: Artifact): Promise<void> {
    await rpc.setDebug(true);
    await deployOrFail(base, rpc, seed, faultZoo);
    const since = await latestSeq(rpc);

    let message = "";
    try {
        await rpc.querySmartContract(faultZoo.slot, ASSERT_FN, u64(50n));
        fail(`${label} the aborting query succeeded`);
    } catch (error) {
        message = String((error as Error).message ?? error);
    }
    if (!message.includes(`Error calling smart contract function: `) || !message.includes(String(FN_ABORT_CODE))) {
        fail(`${label} function abort error reads "${message}"`);
    }
    if ((await ticksBetween(rpc)) <= 0) {
        fail(`${label} node stopped ticking after a function abort`);
    }
    if (await rpc.faultInfo()) {
        fail(`${label} a function abort recorded a node fault`);
    }
    if (uint64(await rpc.querySmartContract(faultZoo.slot, ASSERT_FN, u64(5n)), 0) !== 5n) {
        fail(`${label} the function did not answer after its abort`);
    }
    const frame = await frameAfter(rpc, since, faultZoo.slot, 0, ASSERT_FN);
    if (!frame || !/^abort\(/.test(frame.trap ?? "")) {
        fail(`${label} function abort frame is missing: ${JSON.stringify(frame)}`);
    }
}

async function runHalt(label: string, base: string, rpc: LiteRpc, seed: string, faultZoo: Artifact, kind: "trap" | "abort"): Promise<void> {
    await rpc.setDebug(true);
    await deployOrFail(base, rpc, seed, faultZoo);
    const since = await latestSeq(rpc);
    const entry = kind === "trap" ? OVERFLOW : ASSERT;
    const expected = kind === "trap" ? /overflow/i : /^abort\(/;

    await sendProcedure(base, rpc, seed, faultZoo.slot, entry, kind === "trap" ? "-1sint64" : "50uint64", false);
    const fault = await waitForFault(rpc, label);
    if (fault.slot !== faultZoo.slot || fault.kind !== 1 || fault.entry !== entry || !expected.test(fault.message)) {
        fail(`${label} fault does not name the ${kind}: ${JSON.stringify(fault)}`);
    }
    if ((await ticksBetween(rpc)) !== 0) {
        fail(`${label} node kept ticking after a procedure ${kind}`);
    }
    const frame = await frameAfter(rpc, since, faultZoo.slot, 1, entry);
    if (!frame || !expected.test(frame.trap ?? "") || frame.stateDiff.length === 0) {
        fail(`${label} procedure ${kind} frame is missing or has no state diff: ${JSON.stringify(frame)}`);
    }
}

async function runMigrate(label: string, base: string, rpc: LiteRpc, seed: string, v1: Artifact, v2: Artifact): Promise<void> {
    await rpc.setDebug(true);
    await deployOrFail(base, rpc, seed, v1);
    await sendProcedure(base, rpc, seed, v1.slot, INC, "", true);
    const since = await latestSeq(rpc);

    const deployed = await deploy(base, rpc, seed, v2);
    const report = JSON.stringify(deployed);
    if (deployed.ok || !report.includes("node halted")) {
        fail(`${label} migration deploy did not report the halt: ${report}`);
    }
    const fault = await waitForFault(rpc, label);
    if (fault.slot !== v2.slot || fault.kind !== 3 || !/^abort\(/.test(fault.message)) {
        fail(`${label} fault does not name the migration: ${JSON.stringify(fault)}`);
    }
    const frame = await frameAfter(rpc, since, v2.slot, 3, 0);
    if (!frame || !/^abort\(/.test(frame.trap ?? "")) {
        fail(`${label} migrate frame is missing: ${JSON.stringify(frame)}`);
    }
}

async function runCase(
    label: string,
    base: string,
    rpc: LiteRpc,
    seed: string,
    faultCase: FaultCase,
    compiler: Compiler,
    artifacts: Artifact[],
): Promise<void> {
    const pick = (name: string) =>
        artifacts.find(
            (item) => item.compiler === compiler && item.name === name && item.path.endsWith(name === "MigrateTrap" ? "MigrateTrap.h" : `${name}.h`),
        )!;
    const faultZoo = artifacts.find((item) => item.compiler === compiler && item.name === "FaultZoo")!;
    const v1 = artifacts.find((item) => item.compiler === compiler && item.path.endsWith("MigrateTrapV1.h"))!;
    const v2 = pick("MigrateTrap");
    switch (faultCase) {
        case "fn":
            return runFn(label, base, rpc, seed, faultZoo);
        case "trap":
        case "abort":
            return runHalt(label, base, rpc, seed, faultZoo, faultCase);
        case "migrate":
            return runMigrate(label, base, rpc, seed, v1, v2);
    }
}

await initK12();
const coreRpc = new LiteRpc(rpcBaseUrl);
const registry = coreCase ? await coreRpc.dynRegistry() : null;
if (registry?.contracts.some((contract) => contract.armed)) {
    fail("core node must start with empty dynamic slots");
}
const layout = registry ?? DEFAULT_WASM_SLOT_LAYOUT;
const faultZooSlot = layout.slotBase;
const migrateSlot = layout.slotBase + 1;
const qpiHeader = loadQpiHeader(core);
assertPinnedQpiHeader(qpiHeader);

const sources = [
    ["FaultZoo", resolve("fixtures/FaultZoo.h"), faultZooSlot],
    ["MigrateTrap", resolve("fixtures/MigrateTrapV1.h"), migrateSlot],
    ["MigrateTrap", resolve("fixtures/MigrateTrap.h"), migrateSlot],
] as const;
const compilers = coreCase ? [coreCompiler] : COMPILERS;
const artifacts: Artifact[] = [];
for (const compiler of compilers) {
    for (const [name, path, slot] of sources) {
        artifacts.push(compiler === "TS" ? await compileTs(name, path, slot, qpiHeader) : await compileClang(name, path, slot));
    }
}
for (const item of artifacts) {
    console.log(`${item.compiler.padEnd(5)} ${item.path.split("/").pop()!.padEnd(16)} slot ${item.slot}: ${item.wasm.length}B · ${item.hash}`);
}

const cases = coreCase ? [coreCase] : CASES;
for (const compiler of compilers) {
    for (const faultCase of cases) {
        const server = new EngineServer(new VirtualNode({ slotBase: layout.slotBase, slotCount: layout.slotCount }));
        const handle = await server.start(0, 25);
        try {
            const rpc = new LiteRpc(handle.rpcBaseUrl);
            const seed = (await rpc.fundedSeed()) ?? FALLBACK_SEED;
            await runCase(`simulator/${compiler}/${faultCase}`, handle.rpcBaseUrl, rpc, seed, faultCase, compiler, artifacts);
            console.log(`simulator ${compiler} ${faultCase}: ok`);
        } finally {
            handle.stop();
        }
    }
}

if (coreCase) {
    const seed = (await coreRpc.fundedSeed()) ?? FALLBACK_SEED;
    await runCase(`core/${coreCompiler}/${coreCase}`, rpcBaseUrl, coreRpc, seed, coreCase, coreCompiler, artifacts);
    console.log(`core ${coreCompiler} ${coreCase}: ok`);
}
console.log(`FAULT MATRIX OK — ${compilers.join("/")} × simulator${coreCase ? "/core" : ""}: ${cases.join(", ")}`);
