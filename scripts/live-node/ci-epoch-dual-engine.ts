// one epoch switch on the simulator and on a core node, seen from inside a contract. A core node boots at an arbitrary tick, so every
// number is compared as an offset from the epoch's own first tick.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, loadQpiHeader } from "@qinit/compiler";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { deployContract } from "@qinit/cli/ops/deploy";
import { CUSTOM_MESSAGE_OP, encodeCustomMessageLog, QUBIC_LOG_TYPE } from "@qinit/proto";
import { LOG_SC_INITIALIZE } from "@qinit/engine/logging/qubic-log-store";
import { readTickLogs, type TickLogRecord } from "./peer-log-reader";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE is required");
const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const contractPath = resolve("fixtures/EpochWitness.h");
// a core node walks its epoch at little more than a tick a second, so one switch is most of an hour.
const SWITCH_TIMEOUT_MS = Number(process.env.QINIT_EPOCH_SWITCH_TIMEOUT_MS ?? 90 * 60_000);
// the fast-forward stops this many ticks short, and the node walks the rest at its own pace so the switch itself is the ordinary one.
const TICKS_BEFORE_SWITCH = 3;
const peerHost = new URL(rpcBaseUrl).hostname;
const peerPort = Number(process.env.QINIT_PEER_PORT ?? "31841");
// what the simulator does not reproduce byte for byte, dropped by name so nothing else can hide behind it: dust burns, spectrum
// statistics, the phase fee deduction (measured time on core, a formula here), and every custom message but the two epoch markers.
const CORE_ONLY_LOG_TYPES: readonly number[] = [QUBIC_LOG_TYPE.DUST_BURNING, QUBIC_LOG_TYPE.SPECTRUM_STATS, QUBIC_LOG_TYPE.CONTRACT_RESERVE_DEDUCTION];
const EPOCH_MARKERS: readonly bigint[] = [CUSTOM_MESSAGE_OP.START_EPOCH, CUSTOM_MESSAGE_OP.END_EPOCH];

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
const simulator = await simulatorServer.start(0, 25, 0);

// everything a switch leaves behind, as offsets: [END_EPOCH tick, BEGIN_EPOCH tick, first BEGIN_TICK tick] from the epoch first tick each read,
// how far the first tick moved, the epoch each hook saw relative to the old one, and the node's own report of the new epoch.
type AdvanceToLast = (gap: number) => Promise<{ target: number; reached: number }>;

interface Crossing {
    offsets: number[];
    // the new epoch's first tick, as "range:type:payload" for every record both nodes are expected to write.
    firstTickLog: string[];
}

function modelledRecords(records: TickLogRecord[], firstDynamicSlot: number): string[] {
    return records
        .filter((record) => {
            if (CORE_ONLY_LOG_TYPES.includes(record.type)) {
                return false;
            }
            const view = new DataView(record.message.buffer, record.message.byteOffset, record.message.byteLength);
            if (record.type === QUBIC_LOG_TYPE.CUSTOM_MESSAGE) {
                return EPOCH_MARKERS.includes(view.getBigUint64(0, true));
            }
            // a contract message opens with its contract's index, and the node's own system contracts run only on core.
            const contractMessage = record.type >= QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE && record.type <= QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE;
            return !contractMessage || view.getUint32(0, true) >= firstDynamicSlot;
        })
        .map((record) => `${record.txIndex}:${record.type}:${Buffer.from(record.message).toString("hex")}`);
}

async function crossOneEpoch(name: string, base: string, rpc: LiteRpc, advanceToLast: AdvanceToLast, peer: { host: string; port: number }): Promise<Crossing> {
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
    let advanced = await advanceToLast(TICKS_BEFORE_SWITCH);
    while (advanced.reached < advanced.target) {
        if (Date.now() > deadline) {
            fail(`${name} stopped at tick ${advanced.reached}, short of ${advanced.target}`);
        }
        advanced = await advanceToLast(TICKS_BEFORE_SWITCH);
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

    const firstTickLog = modelledRecords(await readTickLogs(peer.host, peer.port, after.initialTick), registry.slotBase);

    const offsets = [
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
    return { offsets, firstTickLog };
}

try {
    // the simulator lives in this process, where a request that ticks through a whole epoch would hold up its own client; it is driven directly.
    const simulatedCrossing = await crossOneEpoch(
        "simulator",
        simulator.rpcBaseUrl,
        new LiteRpc(simulator.rpcBaseUrl),
        async (gap) => simulatorServer.engine.advanceToLast(gap),
        { host: "127.0.0.1", port: simulator.peerPort! },
    );
    const nativeCrossing = await crossOneEpoch("core", rpcBaseUrl, coreRpc, (gap) => coreRpc.advanceToLast(gap), { host: peerHost, port: peerPort });
    const [simulated, native] = [simulatedCrossing.offsets, nativeCrossing.offsets];
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
    // the switch empties the log, so the old epoch's closing marker is gone on both; the new epoch's log has to open the same way.
    const startOfEpoch = `${LOG_SC_INITIALIZE}:${QUBIC_LOG_TYPE.CUSTOM_MESSAGE}:${Buffer.from(encodeCustomMessageLog(CUSTOM_MESSAGE_OP.START_EPOCH)).toString("hex")}`;
    if (nativeCrossing.firstTickLog[0] !== startOfEpoch) {
        fail(`core's new epoch opens with ${nativeCrossing.firstTickLog[0]}, expected ${startOfEpoch}`);
    }
    if (JSON.stringify(simulatedCrossing.firstTickLog) !== JSON.stringify(nativeCrossing.firstTickLog)) {
        fail(`first tick log: simulator ${JSON.stringify(simulatedCrossing.firstTickLog)} != core ${JSON.stringify(nativeCrossing.firstTickLog)}`);
    }
    console.log(`EPOCH DUAL OK — switch after the tick ${duration} past the epoch's first, hooks and first-tick log identical on both`);
} finally {
    simulator.stop();
}
