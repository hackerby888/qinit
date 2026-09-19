// One epoch switch on the simulator and on a core node, seen from inside a contract. A core node boots at an arbitrary tick, so every
// number is compared as an offset from the epoch's own first tick.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, loadQpiHeader } from "@qinit/compiler";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { deployContract } from "@qinit/cli/ops/deploy";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE is required");
const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const contractPath = resolve("fixtures/EpochWitness.h");
// a core node walks its epoch at little more than a tick a second, so one switch is most of an hour.
const SWITCH_TIMEOUT_MS = Number(process.env.QINIT_EPOCH_SWITCH_TIMEOUT_MS ?? 90 * 60_000);
// the fast-forward stops this many ticks short, and the node walks the rest at its own pace so the switch itself is the ordinary one.
const TICKS_BEFORE_SWITCH = 3;

interface Reading {
    tick: number;
    epoch: number;
    initialTick: number;
}

function fail(message: string): never {
    throw new Error(`EPOCH DUAL FAIL: ${message}`);
}

await initK12();
const coreRpc = new LiteRpc(rpcBaseUrl);
const registry = await coreRpc.dynRegistry();
const slot = registry.contracts.find((contract) => !contract.armed)?.index;
if (slot === undefined) {
    fail("core node has no free dynamic slot");
}

const compiled = await compileContractWithTypeScript({
    source: readFileSync(contractPath, "utf8"),
    contractName: "EpochWitness",
    slot,
    qpiHeader: loadQpiHeader(core),
    arenaSizeBytes: DEFAULT_COMPILE_ARENA_SIZE_BYTES,
});
if (compiled.diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR) || !compiled.idl) {
    fail("EpochWitness did not compile");
}
const artifact = {
    wasm: compiled.wasm,
    hash: await k12Hex(compiled.wasm),
    registration: { functions: compiled.idl.functions.length, procedures: compiled.idl.procedures.length },
};

const simulatorServer = new EngineServer(new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount }));
const simulator = await simulatorServer.start(0, 25);

// everything a switch leaves behind, as offsets: [END_EPOCH tick, BEGIN_EPOCH tick, first BEGIN_TICK tick] from the epoch first tick each read,
// how far the first tick moved, the epoch each hook saw relative to the old one, and the node's own report of the new epoch.
async function crossOneEpoch(name: string, base: string, rpc: LiteRpc): Promise<number[]> {
    const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
    const deployed = await deployContract(
        { contractPath, name: "EpochWitness", core: core!, rpcBaseUrl: base, rpc, seed, slotOverride: slot, artifact },
        () => {},
    );
    if (!deployed.ok || !deployed.armed || !deployed.constructed) {
        fail(`${name} deploy: ${JSON.stringify(deployed)}`);
    }

    const before = await rpc.epochInfo();
    const deadline = Date.now() + SWITCH_TIMEOUT_MS;
    // each call fast-forwards for as long as the node allows one request to run.
    for (let advanced = await rpc.advanceToLast(TICKS_BEFORE_SWITCH); advanced.reached < advanced.target;) {
        if (Date.now() > deadline) {
            fail(`${name} stopped at tick ${advanced.reached}, short of ${advanced.target}`);
        }
        advanced = await rpc.advanceToLast(TICKS_BEFORE_SWITCH);
    }

    // the epoch number moves before the new epoch's first tick is processed, and BEGIN_EPOCH runs at the head of that tick.
    let after = await rpc.epochInfo();
    while (after.epoch === before.epoch || after.tick <= after.initialTick) {
        if (Date.now() > deadline) {
            fail(`${name} never left epoch ${before.epoch} (tick ${after.tick}, last ${after.epochLastTick})`);
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
        after = await rpc.epochInfo();
    }

    const output = await rpc.querySmartContract(slot!, 1, new Uint8Array(0));
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    const reading = (index: number): Reading => ({
        tick: Number(view.getBigUint64(index * 24, true)),
        epoch: Number(view.getBigUint64(index * 24 + 8, true)),
        initialTick: Number(view.getBigUint64(index * 24 + 16, true)),
    });
    const [endEpoch, beginEpoch, firstBeginTick] = [reading(0), reading(1), reading(2)];
    if (endEpoch.initialTick !== before.initialTick || endEpoch.epoch !== before.epoch) {
        fail(`${name} END_EPOCH ran in epoch ${endEpoch.epoch}/${endEpoch.initialTick}, the node reported ${before.epoch}/${before.initialTick}`);
    }

    return [
        endEpoch.tick - endEpoch.initialTick,
        beginEpoch.tick - beginEpoch.initialTick,
        firstBeginTick.tick - firstBeginTick.initialTick,
        beginEpoch.initialTick - endEpoch.initialTick,
        beginEpoch.epoch - endEpoch.epoch,
        firstBeginTick.epoch - endEpoch.epoch,
        before.duration,
        before.epochLastTick - before.initialTick,
        after.initialTick - beginEpoch.initialTick,
        after.epochLastTick - after.initialTick,
        Number(view.getBigUint64(72, true)),
    ];
}

try {
    const simulated = await crossOneEpoch("simulator", simulator.rpcBaseUrl, new LiteRpc(simulator.rpcBaseUrl));
    const native = await crossOneEpoch("core", rpcBaseUrl, coreRpc);
    const duration = native[6];
    // core measures the epoch on the tick it just finished: the switch follows the tick a full duration past the epoch's first, END_EPOCH
    // runs under the next tick number, and that number becomes the new epoch's first tick.
    const expected = [duration + 1, 0, 0, duration + 1, 1, 1, duration, duration - 1, 0, duration - 1, 1];

    if (JSON.stringify(native) !== JSON.stringify(expected)) {
        fail(`core ${JSON.stringify(native)} != expected ${JSON.stringify(expected)}`);
    }
    if (JSON.stringify(simulated) !== JSON.stringify(native)) {
        fail(`simulator ${JSON.stringify(simulated)} != core ${JSON.stringify(native)}`);
    }
    console.log(`EPOCH DUAL OK — switch ${duration} ticks after the epoch's first tick, hooks under core's tick numbers on both`);
} finally {
    simulator.stop();
}
