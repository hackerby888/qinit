// Every way a node refuses a DEPLOY, sent to the simulator and to a core node: both must record the same outcome on /live/v1/dyn-upload, so a
// client reads one reason whichever node it talks to.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, initK12, k12Hex, LiteRpc, WASM_ABI_VERSION, type DeployOutcome } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, loadQpiHeader } from "@qinit/compiler";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { buildUploadTx, uploadContract } from "@qinit/cli/ops/deploy/upload";
import { encodeDeploy, LITE_TX, TX_TICK_OFFSET } from "@qinit/proto";
import { CORE_IO_CAPACITY_BYTES } from "@qinit/core/wasm/sizing";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE is required");
const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
// a refused upload session stays open until it goes stale, and the next case needs the node's one upload slot.
const TICKS_TO_STALE_UPLOAD = 40;
const OUTCOME_TIMEOUT_MS = 90_000;

function fail(message: string): never {
    throw new Error(`DEPLOY REFUSAL DUAL FAIL: ${message}`);
}

await initK12();
const coreRpc = new LiteRpc(rpcBaseUrl);
const registry = await coreRpc.dynRegistry();
const freeSlots = registry.contracts.filter((contract) => !contract.armed).map((contract) => contract.index);
if (freeSlots.length < 2) {
    fail("core node needs two free dynamic slots");
}
const [slot, otherSlot] = freeSlots;

async function compileFixture(contractName: string, targetSlot: number, arenaSizeBytes = DEFAULT_COMPILE_ARENA_SIZE_BYTES): Promise<Uint8Array> {
    const compiled = await compileContractWithTypeScript({
        source: readFileSync(resolve(`fixtures/${contractName}.h`), "utf8"),
        contractName,
        slot: targetSlot,
        qpiHeader: loadQpiHeader(core!),
        arenaSizeBytes,
    });
    if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR) || !compiled.wasm.length) {
        fail(`${contractName} did not compile`);
    }
    return compiled.wasm;
}

const counter = await compileFixture("Counter", slot);
const counterForOtherSlot = await compileFixture("Counter", otherSlot);
const counterWithSmallArena = await compileFixture("Counter", slot, 1024 * 1024);
// the one module that arms records the tick its INITIALIZE ran in, which dates the slot's construction against the DEPLOY.
const initWitness = await compileFixture("InitWitness", slot);
const junk = Uint8Array.from({ length: 64 }, (_, index) => (index * 37 + 11) & 0xff);

interface RefusalCase {
    name: string;
    module: Uint8Array;
    deploy: { targetSlot?: number; abiVersion?: number; finalHashHex?: string };
    code: DeployOutcome["code"];
}

const cases: RefusalCase[] = [
    { name: "a slot outside the dynamic range", module: counter, deploy: { targetSlot: registry.slotBase - 1 }, code: "bad-slot" },
    { name: "another ABI version", module: counter, deploy: { abiVersion: WASM_ABI_VERSION - 1 }, code: "abi-mismatch" },
    { name: "a digest the upload never announced", module: counter, deploy: { finalHashHex: "ff".repeat(32) }, code: "hash-mismatch" },
    { name: "bytes that are not a wasm module", module: junk, deploy: {}, code: "not-wasm" },
    { name: "a module built for another slot", module: counterForOtherSlot, deploy: {}, code: "load-failed" },
    { name: "a module whose io region is smaller than core's carve", module: counterWithSmallArena, deploy: {}, code: "load-failed" },
    { name: "a module the node can arm", module: initWitness, deploy: {}, code: "ok" },
];

async function runCases(name: string, rpc: LiteRpc): Promise<DeployOutcome[]> {
    const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
    const readTick = async () => (await rpc.tickInfo()).tick;
    const waitForTick = async (target: number, attempts = 300) => {
        let tick = await readTick();
        for (let attempt = 0; attempt < attempts && tick < target; attempt++) {
            if ((await rpc.hurryToTick(target)) < target) {
                await new Promise((resolveWait) => setTimeout(resolveWait, 500));
            }
            tick = await readTick();
        }
        return tick;
    };
    const outcomes: DeployOutcome[] = [];

    for (const refusal of cases) {
        await rpc.advanceTick(TICKS_TO_STALE_UPLOAD).catch(() => undefined);
        const hash = await k12Hex(refusal.module);
        const upload = await uploadContract({ rpc, seed, wasm: refusal.module, hash, emit: () => {}, readTick, waitForTick });
        if (!upload.ok) {
            fail(`${name} upload for ${refusal.name}: ${upload.error}`);
        }

        const deadline = Date.now() + OUTCOME_TIMEOUT_MS;
        let outcome: DeployOutcome | null | undefined;
        while (outcome?.sessionId !== String(upload.session)) {
            if (Date.now() > deadline) {
                fail(`${name} recorded no outcome for ${refusal.name} (last: ${JSON.stringify(outcome)})`);
            }
            // a DEPLOY names its tick, so one that missed it is simply sent again until the node has processed one.
            const tick = (await readTick()) + TX_TICK_OFFSET;
            const payload = encodeDeploy({ sessionId: upload.session, targetSlot: slot, finalHashHex: hash, name: "Counter", ...refusal.deploy });
            await rpc.broadcastTx(await buildUploadTx(seed, LITE_TX.DEPLOY, payload, tick)).catch(() => undefined);
            await waitForTick(tick + 1);
            outcome = (await rpc.dynUpload()).lastDeploy;
        }

        if (outcome.code !== refusal.code || outcome.ok !== (refusal.code === "ok")) {
            fail(`${name} answered ${refusal.name} with ${JSON.stringify(outcome)}, expected ${refusal.code}`);
        }
        outcomes.push(outcome);
    }

    // a DEPLOY only arms the slot; INITIALIZE runs at the head of the very next tick, on a core node and so on the simulator.
    const armedTick = outcomes[outcomes.length - 1].tick;
    await waitForTick(armedTick + 2);
    const seen = await rpc.querySmartContract(slot, 1, new Uint8Array(0));
    const initializeTick = Number(new DataView(seen.buffer, seen.byteOffset, seen.byteLength).getBigUint64(8, true));
    if (initializeTick !== armedTick + 1) {
        fail(`${name} armed the slot at tick ${armedTick} and ran INITIALIZE at tick ${initializeTick}, expected ${armedTick + 1}`);
    }

    return outcomes;
}

const simulatorServer = new EngineServer(new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount, minIoBytes: CORE_IO_CAPACITY_BYTES }));
const simulator = await simulatorServer.start(0, 25);

try {
    const simulated = await runCases("simulator", new LiteRpc(simulator.rpcBaseUrl));
    const native = await runCases("core", coreRpc);

    cases.forEach((refusal, index) => {
        const [left, right] = [simulated[index], native[index]];
        // each node runs its own sessions and ticks; the verdict and its wording are what has to agree.
        if (left.code !== right.code || left.ok !== right.ok || left.slot !== right.slot || left.message !== right.message) {
            fail(`${refusal.name}: simulator ${JSON.stringify(left)} != core ${JSON.stringify(right)}`);
        }
    });
    console.log(`DEPLOY REFUSAL DUAL OK — ${cases.length} outcomes identical: ${native.map((outcome) => outcome.code).join(", ")}`);
} finally {
    simulator.stop();
}
