// Compile the same driver/callee sources with Qinit and Clang, deploy every exact artifact through both node RPC paths, and compare complete state.
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
const BURN_AMOUNT = 100n;
const BURN_FUNDING = 150;
const RIGHTS_FUNDING = 50;
const INVALID_AMOUNT = -(1n << 63n);
const driverPath = resolve("fixtures/QpiDual.h");
const calleePath = resolve("fixtures/QpiDualCallee.h");
const driverSource = readFileSync(driverPath, "utf8");
const calleeSource = readFileSync(calleePath, "utf8");
// the shareholder pair has no compile-time link: the proposer takes the receiver's slot as input.
const SHARE_CONTRACTS = {
    receiver: { name: "ShareReceiver", path: resolve("fixtures/ShareReceiver.h") },
    proposer: { name: "ShareProposer", path: resolve("fixtures/ShareProposer.h") },
} as const;
const scratch = mkdtempSync(join(tmpdir(), "qinit-qpi-matrix-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));

type CompilerBackendLabel = "TS" | "Clang";
type Role = "driver" | "callee" | "receiver" | "proposer";
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
    receiverOutput: Uint8Array;
    proposerOutput: Uint8Array;
    receiverDigest: string;
    proposerDigest: string;
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

function viewOf(bytes: Uint8Array): DataView {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function uint64(bytes: Uint8Array, index: number): bigint {
    return viewOf(bytes).getBigUint64(index * 8, true);
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

async function compileSharePair(compiler: CompilerBackendLabel, receiverSlot: number, proposerSlot: number, qpiHeader: string): Promise<Artifact[]> {
    const artifacts: Artifact[] = [];
    for (const [role, slot] of [
        ["receiver", receiverSlot],
        ["proposer", proposerSlot],
    ] as const) {
        const contract = SHARE_CONTRACTS[role];
        if (compiler === "TS") {
            const compiled = await compileContractWithTypeScript({
                source: readFileSync(contract.path, "utf8"),
                contractName: contract.name,
                slot,
                qpiHeader,
                arenaSizeBytes: ARENA_SIZE,
            });
            const errors = compiled.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
            if (errors.length || !compiled.wasm.length || !compiled.idl) {
                fail(`TS ${role} compile: ${errors.map((item) => item.message).join("; ") || "no artifact"}`);
            }
            artifacts.push(
                await artifact("TS", role, slot, compiled.wasm, { functions: compiled.idl.functions.length, procedures: compiled.idl.procedures.length }),
            );
            continue;
        }
        // the verify tool's parser rejects the shareholder callbacks, as the build corpus notes.
        const built = await buildContractWithClang({
            contractPath: contract.path,
            contractName: contract.name,
            slot,
            corePath: core!,
            outDir: join(scratch, `clang-${role}`),
            arenaSizeBytes: ARENA_SIZE,
            skipVerify: true,
        });
        if (!built.ok || !built.wasmPath || !built.idl) {
            fail(`Clang ${role} compile: ${built.stderr ?? "no artifact"}`);
        }
        artifacts.push(
            await artifact("Clang", role, slot, new Uint8Array(readFileSync(built.wasmPath)), {
                functions: built.idl.functions.length,
                procedures: built.idl.procedures.length,
            }),
        );
    }
    return artifacts;
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
        const contractPath = item.role === "driver" ? driverPath : item.role === "callee" ? calleePath : SHARE_CONTRACTS[item.role].path;
        const deployed = await deployContract(
            {
                contractPath,
                name: `Qpi${item.compiler}${item.role[0].toUpperCase()}${item.role.slice(1)}`,
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

// the driver checks the tick it runs in, so the transaction carries the tick it is scheduled for.
async function cheat(base: string, rpc: LiteRpc, slot: number, seed: string): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId: 3,
        amount: 0,
        inputFormat: `${tick}uint64`,
        tick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${base} slot ${slot} Cheat was not included: ${JSON.stringify(result)}`);
    }
}

// returns the procedure's three output words: remaining balance, own reserve delta, target reserve delta.
async function burn(base: string, rpc: LiteRpc, slot: number, burnedFor: number, seed: string, traceStart: number): Promise<{ words: bigint[]; seq: number }> {
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId: 4,
        amount: BURN_FUNDING,
        inputFormat: `${BURN_AMOUNT}sint64, ${burnedFor}uint64`,
        tick: (await rpc.tickInfo()).tick + 6,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${base} slot ${slot} Burn was not included: ${JSON.stringify(result)}`);
    }
    const trace = await rpc.debugTrace(traceStart, 32);
    const entry = trace.entries.find((candidate) => candidate.index === slot && candidate.entry === 4 && candidate.kind === 1 && candidate.ok);
    if (!entry) {
        fail(`${base} slot ${slot} Burn left no trace entry`);
    }
    const output = new DataView(hexToBytes(entry.outHex).buffer);

    return { words: [0, 8, 16].map((offset) => output.getBigInt64(offset, true)), seq: entry.seq };
}

// the proposer's two procedures take the receiver's slot: 1 sets a shareholder proposal there, 2 casts shareholder votes.
async function shareholderCall(base: string, rpc: LiteRpc, proposerSlot: number, procedureId: number, receiverSlot: number, seed: string): Promise<void> {
    const result = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: proposerSlot,
        procedureId,
        amount: 0,
        inputFormat: `${receiverSlot}uint16`,
        tick: (await rpc.tickInfo()).tick + 6,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!result.ok || !result.confirmed || !result.included) {
        fail(`${base} slot ${proposerSlot} shareholder procedure ${procedureId} was not included: ${JSON.stringify(result)}`);
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

    // each bit of the flags is one warp or prank scope check in the driver's Cheat procedure.
    const cheatTraceStart = recoveryTrace.entries.reduce((latest, entry) => Math.max(latest, entry.seq), recoveryTraceStart);
    await cheat(base, rpc, driver.slot, seed);
    const cheatTrace = await rpc.debugTrace(cheatTraceStart, 32);
    const cheatDriver = cheatTrace.entries.find((entry) => entry.index === driver.slot && entry.entry === 3 && entry.kind === 1 && entry.ok);
    const cheatFlags = cheatDriver ? uint64(hexToBytes(cheatDriver.outHex), 0) : undefined;
    if (cheatFlags !== 0x1ffn) {
        fail(`${base} ${compiler} cheat scope flags: ${cheatFlags === undefined ? "no trace" : `0x${cheatFlags.toString(16)}`} != 0x1ff`);
    }

    // a burn credits the reserve it names; an index at or past the node's contract count names the burning contract itself.
    const burnRows: [string, number, bigint, bigint][] = [
        ["self", driver.slot, BURN_AMOUNT, BURN_AMOUNT],
        ["callee", callee.slot, 0n, BURN_AMOUNT],
        ["past the contract count", 1023, BURN_AMOUNT, BURN_AMOUNT],
    ];
    let burnTraceStart = cheatTrace.entries.reduce((latest, entry) => Math.max(latest, entry.seq), cheatTraceStart);
    for (const [label, burnedFor, selfDelta, targetDelta] of burnRows) {
        const burned = await burn(base, rpc, driver.slot, burnedFor, seed, burnTraceStart);
        const [remaining, actualSelfDelta, actualTargetDelta] = burned.words;
        burnTraceStart = burned.seq;
        if (remaining < 0n || actualSelfDelta !== selfDelta || actualTargetDelta !== targetDelta) {
            fail(
                `${base} ${compiler} burn for ${label}: remaining ${remaining}, self ${actualSelfDelta} != ${selfDelta}, target ${actualTargetDelta} != ${targetDelta}`,
            );
        }
    }

    // a release to the callee and an acquire back, each under its own non-zero fee; the callee also tries a release from inside its callback.
    const rightsTick = (await rpc.tickInfo()).tick + 6;
    const rights = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: driver.slot,
        procedureId: 5,
        amount: RIGHTS_FUNDING,
        inputFormat: `${callee.slot}uint64`,
        tick: rightsTick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!rights.ok || !rights.confirmed || !rights.included) {
        fail(`${base} ${compiler} Rights was not included: ${JSON.stringify(rights)}`);
    }
    const rightsEntry = (await rpc.debugTrace(burnTraceStart, 64)).entries.find(
        (entry) => entry.index === driver.slot && entry.entry === 5 && entry.kind === 1 && entry.ok,
    );
    const rightsWords = rightsEntry ? new DataView(hexToBytes(rightsEntry.outHex).buffer) : undefined;
    const rightsExpected = [100n, 5n, 40n, 7n, 100n];
    rightsExpected.forEach((value, index) => {
        if (rightsWords?.getBigInt64(index * 8, true) !== value) {
            fail(`${base} ${compiler} rights output word ${index}: ${rightsWords?.getBigInt64(index * 8, true)} != ${value}`);
        }
    });
    const calleeRights = viewOf(await rpc.querySmartContract(callee.slot, 4, new Uint8Array(0)));
    if (calleeRights.getBigUint64(0, true) !== 4n || calleeRights.getBigInt64(8, true) !== 12n || calleeRights.getBigInt64(16, true) !== INVALID_AMOUNT) {
        fail(
            `${base} ${compiler} callee rights: ${calleeRights.getBigUint64(0, true)} callbacks, ${calleeRights.getBigInt64(8, true)} fees, nested ${calleeRights.getBigInt64(16, true)}`,
        );
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
    const receiver = artifacts.find((item) => item.compiler === compiler && item.role === "receiver")!;
    const proposer = artifacts.find((item) => item.compiler === compiler && item.role === "proposer")!;
    await shareholderCall(base, rpc, proposer.slot, 1, receiver.slot, seed);
    await shareholderCall(base, rpc, proposer.slot, 2, receiver.slot, seed);
    const receiverOutput = await rpc.querySmartContract(receiver.slot, 1, new Uint8Array(0));
    const proposerOutput = await rpc.querySmartContract(proposer.slot, 1, new Uint8Array(0));

    return {
        receiverOutput,
        proposerOutput,
        receiverDigest: (await rpc.contractDigest(receiver.slot)).digest.toLowerCase(),
        proposerDigest: (await rpc.contractDigest(proposer.slot)).digest.toLowerCase(),
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
    // the second word counts incoming transfers: the two runs, the cheat's self transfer, two plain transfers, three burns and the rights call.
    const expected = [63n, 9n, 16n, 16n, 16n, 11n, 57n, 2n, 0n, 65n, 4n, 1n, 2n, 0x51494e4954574153n];
    expected.forEach((value, index) => {
        const actual = driver.getBigUint64((index + 1) * 8, true);
        if (actual !== value) {
            fail(`${label} driver output word ${index + 1}: ${actual} != ${value}`);
        }
    });
    // receiver: proposal byte, proposals, votes, the vote's proposal index, and its refused call back into the proposer (INVALID_PROPOSAL_INDEX).
    const shareRows: [string, Uint8Array, bigint[]][] = [
        ["receiver", result.receiverOutput, [222n, 1n, 1n, 7n, 0xffffn]],
        ["proposer", result.proposerOutput, [7n, 1n]],
    ];
    for (const [role, output, words] of shareRows) {
        words.forEach((value, index) => {
            if (uint64(output, index) !== value) {
                fail(`${label} ${role} output word ${index}: ${uint64(output, index)} != ${value}`);
            }
        });
    }
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
if (registry.slotCount < 8) {
    fail(`need eight dynamic slots, node exposes ${registry.slotCount}`);
}
const slots = [0, 1, 2, 3, 4, 5, 6, 7].map((offset) => registry.slotBase + offset);

const qpiHeader = loadQpiHeader(core);
assertPinnedQpiHeader(qpiHeader);
const artifacts = [
    ...(await compileTsPair(slots[0], slots[1], qpiHeader)),
    ...(await compileClangPair(slots[2], slots[3])),
    ...(await compileSharePair("TS", slots[4], slots[5], qpiHeader)),
    ...(await compileSharePair("Clang", slots[6], slots[7], qpiHeader)),
];
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
        if (result.receiverDigest !== canonical.receiverDigest || result.proposerDigest !== canonical.proposerDigest) {
            fail(`${name} shareholder digests ${result.receiverDigest} ${result.proposerDigest} != ${canonical.receiverDigest} ${canonical.proposerDigest}`);
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
