// Compile the same driver/callee sources with Qinit and Clang, deploy every
// exact artifact through both node RPC paths, and compare complete state.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildContractWithClang } from "@qinit/build";
import { deployContract } from "@qinit/cli/ops/deploy";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, inspectWasmModule, loadQpiHeader } from "@qinit/compiler";
import { DEFAULT_RPC_BASE, hexToBytes, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { invokeProcedure } from "@qinit/proto";
import { assertCoreBuildProfile, assertPinnedQpiHeader } from "./core-proof";

const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const core = process.env.QINIT_CORE;
if (!core) {
    throw new Error("QINIT_CORE not set");
}

const ARENA_SIZE = DEFAULT_COMPILE_ARENA_SIZE_BYTES;
const FALLBACK_SEED = "a".repeat(55);
const driverPath = resolve("fixtures/QpiDual.h");
const calleePath = resolve("fixtures/QpiDualCallee.h");
const driverSource = readFileSync(driverPath, "utf8");
const calleeSource = readFileSync(calleePath, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "qinit-qpi-matrix-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));

type CompilerBackendLabel = "TS" | "Clang";
type Role = "driver" | "callee";
interface Registration {
    functions: number;
    procedures: number;
}
interface Artifact {
    compiler: CompilerBackendLabel;
    role: Role;
    slot: number;
    wasm: Uint8Array;
    hash: string;
    registration: Registration;
}
interface Result {
    driverStateSize: number;
    calleeStateSize: number;
    driverState: Uint8Array;
    calleeState: Uint8Array;
    driverOutput: Uint8Array;
    calleeOutput: Uint8Array;
    driverDigest: string;
    calleeDigest: string;
}

function fail(message: string): never {
    throw new Error(`QPI MATRIX FAIL: ${message}`);
}

const nestedRecoveryRuns = Number(process.env.QINIT_NESTED_RECOVERY_RUNS ?? "1");
if (!Number.isInteger(nestedRecoveryRuns) || nestedRecoveryRuns < 1 || nestedRecoveryRuns > 25) {
    fail("QINIT_NESTED_RECOVERY_RUNS must be an integer from 1 to 25");
}

function same(left: Uint8Array, right: Uint8Array, label: string): void {
    if (Buffer.from(left).equals(Buffer.from(right))) return;
    const first = left.findIndex((value, index) => value !== right[index]);
    fail(`${label} differs at byte ${first} (${left.byteLength}B vs ${right.byteLength}B)`);
}

function uint64(bytes: Uint8Array, index: number): bigint {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(index * 8, true);
}

async function artifact(compiler: CompilerBackendLabel, role: Role, slot: number, wasm: Uint8Array, registration: Registration): Promise<Artifact> {
    const inspection = inspectWasmModule(wasm);
    if (!inspection.ok) {
        fail(`${compiler} ${role}: ${inspection.diagnostics.map((item) => item.message).join("; ")}`);
    }
    if (inspection.imports.some((item) => item.module !== "lhost")) {
        fail(`${compiler} ${role} has a non-lhost import`);
    }
    return { compiler, role, slot, wasm, registration, hash: await k12Hex(wasm) };
}

async function compileTsPair(calleeSlot: number, driverSlot: number, qpiHeader: string): Promise<Artifact[]> {
    const callee = await compileContractWithTypeScript({
        source: calleeSource,
        contractName: "QpiDualCallee",
        slot: calleeSlot,
        qpiHeader,
        arenaSizeBytes: ARENA_SIZE,
    });
    const calleeErrors = callee.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
    if (calleeErrors.length || !callee.wasm.length) {
        fail(`TS callee compile: ${calleeErrors.map((item) => item.message).join("; ") || "empty artifact"}`);
    }
    if (!callee.idl) {
        fail("successful TS callee compile returned no IDL");
    }
    const driver = await compileContractWithTypeScript({
        source: driverSource,
        contractName: "QpiDual",
        slot: driverSlot,
        qpiHeader,
        arenaSizeBytes: ARENA_SIZE,
        callees: [callee.idl],
        calleeSources: [{ name: "QpiDualCallee", source: calleeSource }],
    });
    const driverErrors = driver.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
    if (driverErrors.length || !driver.wasm.length) {
        fail(`TS driver compile: ${driverErrors.map((item) => item.message).join("; ") || "empty artifact"}`);
    }
    if (!driver.idl) {
        fail("successful TS driver compile returned no IDL");
    }
    return [
        await artifact("TS", "callee", calleeSlot, callee.wasm, {
            functions: callee.idl.functions.length,
            procedures: callee.idl.procedures.length,
        }),
        await artifact("TS", "driver", driverSlot, driver.wasm, {
            functions: driver.idl.functions.length,
            procedures: driver.idl.procedures.length,
        }),
    ];
}

async function compileClangPair(calleeSlot: number, driverSlot: number): Promise<Artifact[]> {
    const callee = await buildContractWithClang({
        contractPath: calleePath,
        contractName: "QpiDualCallee",
        slot: calleeSlot,
        corePath: core!,
        outDir: join(scratch, "clang-callee"),
        arenaSizeBytes: ARENA_SIZE,
    });
    if (!callee.ok || !callee.wasmPath || !callee.idl) {
        fail(`Clang callee compile: ${callee.stderr ?? "no artifact"}`);
    }
    const driver = await buildContractWithClang({
        contractPath: driverPath,
        contractName: "QpiDual",
        slot: driverSlot,
        corePath: core!,
        outDir: join(scratch, "clang-driver"),
        arenaSizeBytes: ARENA_SIZE,
        dynCallees: { QpiDualCallee: { header: calleePath, slot: calleeSlot } },
    });
    if (!driver.ok || !driver.wasmPath || !driver.idl) {
        fail(`Clang driver compile: ${driver.stderr ?? "no artifact"}`);
    }
    return [
        await artifact("Clang", "callee", calleeSlot, new Uint8Array(readFileSync(callee.wasmPath)), {
            functions: callee.idl.functions.length,
            procedures: callee.idl.procedures.length,
        }),
        await artifact("Clang", "driver", driverSlot, new Uint8Array(readFileSync(driver.wasmPath)), {
            functions: driver.idl.functions.length,
            procedures: driver.idl.procedures.length,
        }),
    ];
}

async function deployAll(base: string, rpc: LiteRpc, artifacts: Artifact[], seed: string): Promise<void> {
    for (const item of artifacts) {
        const pairCallee = artifacts.find((candidate) => candidate.compiler === item.compiler && candidate.role === "callee")!;
        const deployed = await deployContract(
            {
                contractPath: item.role === "driver" ? driverPath : calleePath,
                name: `Qpi${item.compiler}${item.role === "driver" ? "Driver" : "Callee"}`,
                core: core!,
                rpcBaseUrl: base,
                rpc,
                seed,
                slotOverride: item.slot,
                dynCallees: item.role === "driver" ? { QpiDualCallee: { header: calleePath, slot: pairCallee.slot } } : undefined,
                artifact: {
                    wasm: item.wasm,
                    hash: item.hash,
                    registration: item.registration,
                },
            },
            (event) => {
                if ("step" in event && event.state === "fail") {
                    console.error(`  ${item.compiler} ${item.role} ${event.step}: ${event.detail ?? "failed"}`);
                }
            },
        );
        if (!deployed.ok || !deployed.armed || !deployed.constructed) {
            fail(`${base} ${item.compiler} ${item.role} deploy: ${JSON.stringify(deployed)}`);
        }
    }

    const registry = await rpc.dynRegistry();
    for (const item of artifacts) {
        const row = registry.contracts.find((contract) => contract.index === item.slot);
        if (!row?.armed || !row.constructed) {
            fail(`${base} slot ${item.slot} is not ready`);
        }
        if (row.codeHash.toLowerCase() !== item.hash.toLowerCase()) {
            fail(`${base} slot ${item.slot} code hash ${row.codeHash} != ${item.hash}`);
        }
    }
}

async function invoke(base: string, rpc: LiteRpc, slot: number, inputSeed: bigint, seed: string): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId: 1,
        amount: 2,
        inputFormat: `${inputSeed}uint64, ${slot}uint64`,
        tick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${base} slot ${slot} Run was not included: ${JSON.stringify(result)}`);
    }
}

async function recover(base: string, rpc: LiteRpc, slot: number, seed: string): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId: 2,
        amount: 0,
        inputFormat: "5uint64, 3uint64, -1sint64",
        tick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${base} slot ${slot} Recover was not included: ${JSON.stringify(result)}`);
    }
}

async function soakRecoveries(base: string, rpc: LiteRpc, artifacts: Artifact[], compiler: CompilerBackendLabel, seed: string): Promise<void> {
    const driver = artifacts.find((item) => item.compiler === compiler && item.role === "driver")!;
    const callee = artifacts.find((item) => item.compiler === compiler && item.role === "callee")!;
    const tickBefore = (await rpc.tickInfo()).tick;

    for (let run = 1; run < nestedRecoveryRuns; run++) {
        await recover(base, rpc, driver.slot, seed);
    }

    const calleeOutput = await rpc.querySmartContract(callee.slot, 1, new Uint8Array(0));
    const extraRuns = BigInt(nestedRecoveryRuns - 1);
    const expectedValue = 65n + 8n * extraRuns;
    const expectedCalls = 4n + 2n * extraRuns;
    if (uint64(calleeOutput, 0) !== expectedValue || uint64(calleeOutput, 1) !== expectedCalls) {
        fail(
            `${base} ${compiler} recovery soak: expected callee ` +
                `${expectedValue}/${expectedCalls}, got ` +
                `${uint64(calleeOutput, 0)}/${uint64(calleeOutput, 1)}`,
        );
    }

    const tickAfter = (await rpc.tickInfo()).tick;
    if (tickAfter <= tickBefore) {
        fail(`${base} ${compiler} recovery soak did not advance the RPC tick`);
    }
}

async function plainTransfer(base: string, rpc: LiteRpc, slot: number, seed: string): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId: 0,
        amount: 1,
        inputFormat: "",
        tick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included || !result.moneyFlew) {
        fail(`${base} slot ${slot} incoming transfer was not included: ${JSON.stringify(result)}`);
    }
}

async function execute(base: string, rpc: LiteRpc, artifacts: Artifact[], compiler: CompilerBackendLabel, seed: string): Promise<Result> {
    const driver = artifacts.find((item) => item.compiler === compiler && item.role === "driver")!;
    const callee = artifacts.find((item) => item.compiler === compiler && item.role === "callee")!;
    await rpc.setDebug(true);
    const traceBefore = await rpc.debugTrace(0, 256);
    const traceStart = traceBefore.entries.reduce((latest, entry) => Math.max(latest, entry.seq), 0);
    await invoke(base, rpc, driver.slot, 17n, seed);
    await invoke(base, rpc, driver.slot, 33n, seed);

    const trace = await rpc.debugTrace(traceStart, 64);
    const driverCalls = trace.entries.filter((entry) => entry.index === driver.slot && entry.entry === 1 && entry.kind === 1 && entry.ok);
    const calleeCalls = trace.entries.filter((entry) => entry.index === callee.slot && entry.entry === 1 && entry.kind === 1 && entry.ok);
    if (driverCalls.length !== 2 || calleeCalls.length !== 2) {
        fail(`${base} ${compiler} nested traces: expected 2 driver and 2 callee procedures, ` + `got ${driverCalls.length} and ${calleeCalls.length}`);
    }
    for (const [index, entry] of driverCalls.entries()) {
        const nestedCalls = entry.hostCalls
            .filter((call) => (call.name === "callFunction" || call.name === "invokeProcedure") && call.detail.includes(String(callee.slot)))
            .map((call) => call.name);
        if (nestedCalls.join(",") !== "callFunction,invokeProcedure,callFunction" || entry.stateTruncated || entry.stateDiff.length === 0) {
            fail(`${base} ${compiler} driver trace #${index + 1} is incomplete: ` + JSON.stringify(entry));
        }
    }

    const recoveryTraceStart = trace.entries.reduce((latest, entry) => Math.max(latest, entry.seq), traceStart);
    await recover(base, rpc, driver.slot, seed);
    const recoveryQuery = await rpc.querySmartContract(callee.slot, 1, new Uint8Array(0));
    if (uint64(recoveryQuery, 0) !== 65n || uint64(recoveryQuery, 1) !== 4n) {
        fail(`${base} ${compiler} callee did not recover after its nested trap`);
    }

    const recoveryTrace = await rpc.debugTrace(recoveryTraceStart, 32);
    const trappedChild = recoveryTrace.entries.find((entry) => entry.index === callee.slot && entry.entry === 2 && entry.kind === 1 && !entry.ok);
    if (!trappedChild?.trap || trappedChild.stateDiff.length !== 1) {
        fail(`${base} ${compiler} trapped child trace is missing: ${JSON.stringify(trappedChild)}`);
    }
    const trappedBefore = hexToBytes(trappedChild.stateDiff[0].before);
    const trappedAfter = hexToBytes(trappedChild.stateDiff[0].after);
    if (uint64(trappedBefore, 0) !== 57n || uint64(trappedBefore, 1) !== 2n || uint64(trappedAfter, 0) !== 62n || uint64(trappedAfter, 1) !== 3n) {
        fail(`${base} ${compiler} trapped child did not retain its partial write`);
    }

    const healthyChild = recoveryTrace.entries.find((entry) => entry.index === callee.slot && entry.entry === 1 && entry.kind === 1 && entry.ok);
    if (!healthyChild || healthyChild.stateDiff.length !== 1) {
        fail(`${base} ${compiler} healthy child invoke is missing after the trap`);
    }
    const healthyBefore = hexToBytes(healthyChild.stateDiff[0].before);
    const healthyAfter = hexToBytes(healthyChild.stateDiff[0].after);
    if (uint64(healthyBefore, 0) !== 62n || uint64(healthyBefore, 1) !== 3n || uint64(healthyAfter, 0) !== 65n || uint64(healthyAfter, 1) !== 4n) {
        fail(`${base} ${compiler} healthy child invoke has the wrong state transition`);
    }

    const recoveryDriver = recoveryTrace.entries.find((entry) => entry.index === driver.slot && entry.entry === 2 && entry.kind === 1 && entry.ok);
    const recoveryCalls = recoveryDriver?.hostCalls.map((call) => call.name);
    if (
        recoveryCalls?.join(",") !== "callFunction,invokeProcedure,callFunction,invokeProcedure,callFunction" ||
        recoveryDriver?.stateTruncated ||
        !recoveryDriver?.stateDiff.length
    ) {
        fail(`${base} ${compiler} recovery driver trace is incomplete: ${JSON.stringify(recoveryDriver)}`);
    }
    const recoveryOutput = hexToBytes(recoveryDriver.outHex);
    const recoveryExpected = [0n, 0n, 57n, 62n, 65n, 4n];
    for (const [index, expected] of recoveryExpected.entries()) {
        if (uint64(recoveryOutput, index) !== expected) {
            fail(`${base} ${compiler} recovery output word ${index}: ` + `${uint64(recoveryOutput, index)} != ${expected}`);
        }
    }

    await plainTransfer(base, rpc, driver.slot, seed);
    await plainTransfer(base, rpc, driver.slot, seed);

    const driverOutput = await rpc.querySmartContract(driver.slot, 1, new Uint8Array(0));
    const calleeOutput = await rpc.querySmartContract(callee.slot, 1, new Uint8Array(0));
    const driverDigest = await rpc.contractDigest(driver.slot);
    const calleeDigest = await rpc.contractDigest(callee.slot);
    const driverRead = await rpc.stateRead(driver.slot, 0, driverDigest.stateSize);
    const calleeRead = await rpc.stateRead(callee.slot, 0, calleeDigest.stateSize);
    const driverState = hexToBytes(driverRead.hex);
    const calleeState = hexToBytes(calleeRead.hex);
    if (driverRead.stateSize !== driverDigest.stateSize || driverState.byteLength !== driverDigest.stateSize) {
        fail(`${base} ${compiler} driver state read is incomplete`);
    }
    if (calleeRead.stateSize !== calleeDigest.stateSize || calleeState.byteLength !== calleeDigest.stateSize) {
        fail(`${base} ${compiler} callee state read is incomplete`);
    }
    return {
        driverStateSize: driverDigest.stateSize,
        calleeStateSize: calleeDigest.stateSize,
        driverState,
        calleeState,
        driverOutput,
        calleeOutput,
        driverDigest: driverDigest.digest.toLowerCase(),
        calleeDigest: calleeDigest.digest.toLowerCase(),
    };
}

function assertExpected(result: Result, label: string): void {
    const driver = new DataView(result.driverOutput.buffer, result.driverOutput.byteOffset, result.driverOutput.byteLength);
    const expected = [63n, 4n, 16n, 16n, 16n, 11n, 57n, 2n, 0n, 65n, 4n, 1n, 2n, 0x51494e4954574153n];
    expected.forEach((value, index) => {
        const actual = driver.getBigUint64((index + 1) * 8, true);
        if (actual !== value) {
            fail(`${label} driver output word ${index + 1}: ${actual} != ${value}`);
        }
    });
    const callee = new DataView(result.calleeOutput.buffer, result.calleeOutput.byteOffset, result.calleeOutput.byteLength);
    const calleeExpected = [65n, 4n, 0x43414c4c45455741n];
    calleeExpected.forEach((value, index) => {
        const actual = callee.getBigUint64(index * 8, true);
        if (actual !== value) {
            fail(`${label} callee output word ${index}: ${actual} != ${value}`);
        }
    });
}

await initK12();
console.log("CMake proof", JSON.stringify(assertCoreBuildProfile(core, ["build-node", "build-win-static", "build-win"])));
const coreRpc = new LiteRpc(rpcBaseUrl);
const registry = await coreRpc.dynRegistry();
if (registry.contracts.some((contract) => contract.armed)) {
    fail("core node must start with empty dynamic slots");
}
if (registry.slotCount < 4) {
    fail(`need four dynamic slots, node exposes ${registry.slotCount}`);
}
const slots = [0, 1, 2, 3].map((offset) => registry.slotBase + offset);

const qpiHeader = loadQpiHeader(core);
assertPinnedQpiHeader(qpiHeader);
const artifacts = [...(await compileTsPair(slots[0], slots[1], qpiHeader)), ...(await compileClangPair(slots[2], slots[3]))];
for (const item of artifacts) {
    console.log(`${item.compiler.padEnd(5)} ${item.role.padEnd(6)} slot ${item.slot}: ${item.wasm.length}B · ${item.hash}`);
}

const simulatorServer = new EngineServer(new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount }));
const simulator = await simulatorServer.start(0, 25);
try {
    const simulatorRpc = new LiteRpc(simulator.rpcBaseUrl);
    const simulatorSeed = (await simulatorRpc.fundedSeed()) ?? FALLBACK_SEED;
    const coreSeed = (await coreRpc.fundedSeed()) ?? FALLBACK_SEED;
    await deployAll(simulator.rpcBaseUrl, simulatorRpc, artifacts, simulatorSeed);
    await deployAll(rpcBaseUrl, coreRpc, artifacts, coreSeed);

    const runtimes = [
        ["simulator", simulator.rpcBaseUrl, simulatorRpc, simulatorSeed],
        ["core", rpcBaseUrl, coreRpc, coreSeed],
    ] as const;
    const results = new Map<string, Result>();
    for (const [name, base, rpc, seed] of runtimes) {
        for (const compiler of ["TS", "Clang"] as const) {
            const result = await execute(base, rpc, artifacts, compiler, seed);
            assertExpected(result, `${compiler}/${name}`);
            results.set(`${compiler}/${name}`, result);
        }
    }

    const canonical = results.get("TS/simulator")!;
    for (const [name, result] of results) {
        if (result.driverStateSize !== canonical.driverStateSize) {
            fail(`${name} driver state size ${result.driverStateSize} != ${canonical.driverStateSize}`);
        }
        if (result.calleeStateSize !== canonical.calleeStateSize) {
            fail(`${name} callee state size ${result.calleeStateSize} != ${canonical.calleeStateSize}`);
        }
        same(result.driverState, canonical.driverState, `${name} driver state`);
        same(result.calleeState, canonical.calleeState, `${name} callee state`);
        same(result.driverOutput, canonical.driverOutput, `${name} driver output`);
        same(result.calleeOutput, canonical.calleeOutput, `${name} callee output`);
        if (result.driverDigest !== canonical.driverDigest) {
            fail(`${name} driver digest ${result.driverDigest} != ${canonical.driverDigest}`);
        }
        if (result.calleeDigest !== canonical.calleeDigest) {
            fail(`${name} callee digest ${result.calleeDigest} != ${canonical.calleeDigest}`);
        }
    }
    if (nestedRecoveryRuns > 1) {
        for (const [, base, rpc, seed] of runtimes) {
            for (const compiler of ["TS", "Clang"] as const) {
                await soakRecoveries(base, rpc, artifacts, compiler, seed);
            }
        }
    }
    if (process.env.QINIT_QPI_DIGEST_FILE) {
        writeFileSync(process.env.QINIT_QPI_DIGEST_FILE, `${canonical.driverDigest} ${canonical.calleeDigest}\n`);
    }
    console.log(
        `QPI MATRIX OK — TS/Clang × simulator/core: ${canonical.driverState.length}B driver ${canonical.driverDigest}, ${canonical.calleeState.length}B callee ${canonical.calleeDigest}`,
    );
} finally {
    simulator.stop();
    rmSync(scratch, { recursive: true, force: true });
}
