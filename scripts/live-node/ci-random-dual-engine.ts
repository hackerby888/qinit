// Compile once, execute the exact artifact on the release-configured WAMR node,
// then replay the node's captured chain context in QubicSimulator and compare state bytes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, hexToBytes, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, inspectWasmModule, loadQpiHeader } from "@qinit/compiler";
import { QubicSimulator } from "@qinit/engine";
import { deployContract } from "@qinit/cli/ops/deploy";
import { invokeProcedure, resolveDeploymentSlot } from "@qinit/proto";
import { assertCoreBuildProfile, assertPinnedQpiHeader } from "./core-proof";

const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");
const fixture = resolve("fixtures/RandomDual.h");
const source = readFileSync(fixture, "utf8");
const rpc = new LiteRpc(rpcBaseUrl);
const fail = (message: string): never => {
    throw new Error(`RANDOM DUAL FAIL: ${message}`);
};
const same = (left: Uint8Array, right: Uint8Array, label: string) => {
    if (!Buffer.from(left).equals(Buffer.from(right))) fail(`${label} differs`);
};

function input(nonce: bigint): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigUint64(0, nonce, true);
    return out;
}

await initK12();
assertCoreBuildProfile(core, ["build-node"], {
    CMAKE_BUILD_TYPE: "RelWithDebInfo",
    CMAKE_C_COMPILER: /clang-18$/,
    CMAKE_CXX_COMPILER: /clang\+\+-18$/,
});
const { slot } = await resolveDeploymentSlot(rpc, "RandomDual");
const qpiHeader = loadQpiHeader(core);
assertPinnedQpiHeader(qpiHeader);
const compiled = await compileContractWithTypeScript({
    source,
    contractName: "RandomDual",
    slot,
    qpiHeader,
    arenaSizeBytes: DEFAULT_COMPILE_ARENA_SIZE_BYTES,
});
const errors = compiled.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
if (errors.length || !compiled.wasm.length) {
    fail(errors.map((item) => item.message).join("; ") || "empty artifact");
}
const idl = compiled.idl;
if (!idl) {
    throw new Error("RANDOM DUAL FAIL: successful compile returned no IDL");
}
const inspection = inspectWasmModule(compiled.wasm);
if (!inspection.ok) {
    fail(inspection.diagnostics.map((item) => item.message).join("; "));
}
if (inspection.imports.some((item) => item.module !== "lhost")) {
    fail("artifact has a non-lhost import");
}

const hash = await k12Hex(compiled.wasm);
const deployed = await deployContract(
    {
        contractPath: fixture,
        name: "RandomDual",
        core,
        rpcBaseUrl,
        slotOverride: slot,
        artifact: {
            wasm: compiled.wasm,
            hash,
            registration: { functions: idl.functions.length, procedures: idl.procedures.length },
        },
    },
    () => {},
);
if (!deployed.ok || !deployed.armed || !deployed.constructed) {
    fail(`deploy did not become ready: ${JSON.stringify(deployed)}`);
}

const preRead = await rpc.stateRead(slot, 0, idl.state.size);
const preState = hexToBytes(preRead.hex);
await rpc.setDebug(true);
const beforeTrace = await rpc.debugTrace(0, 256);
const since = beforeTrace.entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
const nonce = 0x1020304050607080n;
const payload = input(nonce);
const fundedSeed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tick = (await rpc.tickInfo()).tick + 6;
const invoked = await invokeProcedure({
    seed: fundedSeed,
    rpcBaseUrl,
    contractIndex: slot,
    procedureId: 1,
    amount: 0,
    inputFormat: `${nonce}uint64`,
    tick,
    confirm: true,
    confirmTimeoutMs: 60_000,
    rpc,
});
if (!invoked.ok || !invoked.confirmed || !invoked.included) {
    fail(`Run was not included: ${JSON.stringify(invoked)}`);
}

const trace = (await rpc.debugTrace(since, 64)).entries.filter((entry) => entry.index === slot && entry.entry === 1 && entry.kind === 1 && entry.ok).at(-1);
if (!trace) throw new Error("RANDOM DUAL FAIL: node emitted no successful procedure trace");
const postRead = await rpc.stateRead(slot, 0, idl.state.size);
const nodeState = hexToBytes(postRead.hex);
const prevSpectrum = nodeState.slice(0, 32);
const invocator = hexToBytes(trace.invocator);

const replay = (): Uint8Array => {
    const sim = new QubicSimulator({ mempool: false, fees: "off", liteTicking: true });
    sim.currentTick = trace.tick;
    sim.prevSpectrumDigestOverride = prevSpectrum;
    const contract = sim.deploy(slot, compiled.wasm);
    contract.writeState(preState);
    sim.procedure(slot, 1, payload, {
        invocator,
        originator: invocator,
        reward: BigInt(trace.invocationReward),
    });
    return contract.state();
};

const simState = replay();
same(simState, nodeState, "resident state");
same(replay(), simState, "identical replay");
const first = simState.slice(32, 64);
const second = simState.slice(64, 96);
const third = simState.slice(96, 128);
if (first.every((value) => value === 0) || second.every((value) => value === 0) || third.every((value) => value === 0)) {
    fail("random id is zero");
}
if (Buffer.from(first).equals(Buffer.from(second)) || Buffer.from(second).equals(Buffer.from(third))) {
    fail("random sequence did not advance");
}
const view = new DataView(simState.buffer, simState.byteOffset, simState.byteLength);
if (view.getUint32(160, true) !== 1 || view.getUint32(164, true) !== 1 || view.getUint32(168, true) !== 1) {
    fail("rdrand success result differs");
}
await rpc.setDebug(false);
console.log(`RANDOM DUAL OK — exact ${compiled.wasm.length}B artifact, tick ${trace.tick}, ${nodeState.length} state bytes match in WAMR and QubicSimulator`);
