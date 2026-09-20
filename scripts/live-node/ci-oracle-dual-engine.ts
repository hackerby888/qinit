// Answer an oracle query and run an OC invocation on the WAMR node and in QubicSimulator through the same dev routes, then compare what the contracts saw.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, inspectWasmModule, loadQpiHeader } from "@qinit/compiler";
import { VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { deployContract } from "@qinit/cli/ops/deploy";
import { abiTypeFromFormat, encodeInputFormatAs, invokeProcedure, OC_INVOCATION_STATUS, ORACLE_STATUS } from "@qinit/proto";
import { ORACLE_INTERFACES } from "@qinit/engine/oracle-interfaces/registry";
import { assertCoreBuildProfile, assertPinnedQpiHeader } from "./core-proof";

const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");

const FALLBACK_SEED = "a".repeat(55);
const QUERY_TIMEOUT_MS = 3_600_000;
const SHORT_TIMEOUT_MS = 4_000;
const REPLY_TEXT = "123456sint64, 1000sint64";
// a reply needs the commit, quorum and reveal rounds on a node; the simulator reveals on the next tick.
const REVEAL_BUDGET_MS = 60_000;

// a status seen twice in a row is one observation, so a slower engine does not read as a different sequence.
const distinct = (statuses: number[]): number[] => statuses.filter((status, index) => index === 0 || statuses[index - 1] !== status);

const fail = (message: string): never => {
    throw new Error(`ORACLE DUAL FAIL: ${message}`);
};

type Artifact = { name: string; slot: number; wasm: Uint8Array; hash: string; path: string; functions: number; procedures: number };

// what a contract ends up seeing, on either engine: the fields a reply and an invocation leave behind.
type Observed = {
    querySequence: number[];
    notifiedStatus: number;
    numerator: bigint;
    denominator: bigint;
    balanceAfterQuery: bigint;
    unavailableSequence: number[];
    timeoutStatus: number;
    ocRefused: boolean;
    ocSequence: number[];
    ocInvocations: bigint;
    ocBalanceSpent: bigint;
    inlineNotifications: bigint;
    inlineSeenInsideCall: bigint;
    inlineQueryId: bigint;
};

async function compile(name: string, slot: number, qpiHeader: string): Promise<Artifact> {
    const path = resolve(`fixtures/${name}.h`);
    const compiled = await compileContractWithTypeScript({
        source: readFileSync(path, "utf8"),
        contractName: name,
        slot,
        qpiHeader,
        arenaSizeBytes: DEFAULT_COMPILE_ARENA_SIZE_BYTES,
    });
    const errors = compiled.diagnostics.filter((item) => item.severity === DiagnosticSeverity.ERROR);
    if (errors.length || !compiled.wasm.length) fail(`${name}: ${errors.map((item) => item.message).join("; ") || "empty artifact"}`);
    if (!compiled.idl) fail(`${name}: successful compile returned no IDL`);

    const inspection = inspectWasmModule(compiled.wasm);
    if (!inspection.ok) fail(`${name}: ${inspection.diagnostics.map((item) => item.message).join("; ")}`);
    if (inspection.imports.some((item) => item.module !== "lhost")) fail(`${name}: artifact has a non-lhost import`);

    return {
        name,
        slot,
        wasm: compiled.wasm,
        hash: await k12Hex(compiled.wasm),
        path,
        functions: compiled.idl!.functions.length,
        procedures: compiled.idl!.procedures.length,
    };
}

async function deployAll(base: string, rpc: LiteRpc, artifacts: Artifact[], seed: string): Promise<void> {
    for (const artifact of artifacts) {
        const deployed = await deployContract(
            {
                contractPath: artifact.path,
                name: artifact.name,
                core: core!,
                rpcBaseUrl: base,
                rpc,
                seed,
                slotOverride: artifact.slot,
                artifact: {
                    wasm: artifact.wasm,
                    hash: artifact.hash,
                    registration: { functions: artifact.functions, procedures: artifact.procedures },
                },
            },
            () => {},
        );
        if (!deployed.ok || !deployed.armed || !deployed.constructed) fail(`${artifact.name} deploy did not become ready: ${JSON.stringify(deployed)}`);
    }
}

function priceInput(timeoutMillisec: number): Uint8Array {
    const input = new Uint8Array(112);
    input.set(new TextEncoder().encode("mock"), 0);
    input.set(new TextEncoder().encode("BTC"), 40);
    input.set(new TextEncoder().encode("USD"), 72);
    new DataView(input.buffer).setUint32(104, timeoutMillisec, true);
    return input;
}

function u64Input(value: bigint): Uint8Array {
    const input = new Uint8Array(8);
    new DataView(input.buffer).setBigUint64(0, value, true);
    return input;
}

function i64Input(value: bigint): Uint8Array {
    const input = new Uint8Array(8);
    new DataView(input.buffer).setBigInt64(0, value, true);
    return input;
}

async function call(rpc: LiteRpc, slot: number, functionId: number, input: Uint8Array): Promise<DataView> {
    const output = await rpc.querySmartContract(slot, functionId, input);
    return new DataView(output.buffer, output.byteOffset, output.byteLength);
}

async function send(base: string, rpc: LiteRpc, seed: string, slot: number, procedureId: number, amount: number, input: Uint8Array): Promise<void> {
    const tick = (await rpc.tickInfo()).tick + 6;
    const invoked = await invokeProcedure({
        seed,
        rpcBaseUrl: base,
        rpc,
        contractIndex: slot,
        procedureId,
        amount,
        input,
        tick,
        confirm: true,
        confirmTimeoutMs: 60_000,
    });
    if (!invoked.ok || !invoked.included) fail(`procedure ${procedureId} on slot ${slot} was not included: ${JSON.stringify(invoked)}`);
}

// poll a status function and keep every distinct value, so the sequence a contract could observe is compared and not one snapshot of it.
async function watchStatus(rpc: LiteRpc, slot: number, functionId: number, id: bigint, done: (status: number) => boolean, budgetMs: number): Promise<number[]> {
    const sequence: number[] = [];
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const status = Number((await call(rpc, slot, functionId, i64Input(id))).getBigUint64(0, true));
        if (sequence.at(-1) !== status) sequence.push(status);
        if (done(status) || Date.now() > deadline) return sequence;
        await new Promise((wake) => setTimeout(wake, 250));
    }
}

// the notification runs in a later tick than the reply, so the state it writes is waited for rather than read once.
async function waitNotified(rpc: LiteRpc, slot: number, status: number, budgetMs = REVEAL_BUDGET_MS): Promise<DataView> {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const last = await call(rpc, slot, 1, new Uint8Array(0));
        if (last.getUint8(28) === status || Date.now() > deadline) return last;
        await new Promise((wake) => setTimeout(wake, 250));
    }
}

async function pendingQuery(rpc: LiteRpc, slot: number, budgetMs: number) {
    const deadline = Date.now() + budgetMs;
    for (;;) {
        const pending = (await rpc.oraclePending()).filter((entry) => entry.slot === slot);
        if (pending.length) return pending[0];
        if (Date.now() > deadline) return fail(`no pending query appeared for slot ${slot}`);
        await new Promise((wake) => setTimeout(wake, 250));
    }
}

async function observe(base: string, rpc: LiteRpc, seed: string, oracleSlot: number, ocSlot: number, inlineSlot: number): Promise<Observed> {
    const priceReply = await encodeInputFormatAs(abiTypeFromFormat(ORACLE_INTERFACES[0].replyFormat), REPLY_TEXT);
    const contractBalance = async (slot: number) => BigInt((await rpc.balance(await contractIdentity(slot))).balance);

    // one answered query: the status sequence, the reply the notification carried, and the fee that left the contract
    const beforeQuery = await contractBalance(oracleSlot);
    await send(base, rpc, seed, oracleSlot, 2, 1_000, priceInput(QUERY_TIMEOUT_MS));
    const answered = await pendingQuery(rpc, oracleSlot, 30_000);
    const balanceAfterQuery = await contractBalance(oracleSlot);
    const beforeReply = Number((await call(rpc, oracleSlot, 2, i64Input(answered.queryId))).getBigUint64(0, true));
    const resolved = await rpc.oracleResolve(answered.queryId, priceReply, ORACLE_STATUS.SUCCESS);
    if (!resolved.ok) fail(`the reply was refused: ${JSON.stringify(resolved)}`);
    const querySequence = distinct([
        beforeReply,
        ...(await watchStatus(rpc, oracleSlot, 2, answered.queryId, (status) => status === ORACLE_STATUS.SUCCESS, REVEAL_BUDGET_MS)),
    ]);
    const last = await waitNotified(rpc, oracleSlot, ORACLE_STATUS.SUCCESS);

    // a query the oracle cannot answer: the machine reports it has no value, and the query ends at its own timeout
    await send(base, rpc, seed, oracleSlot, 2, 1_000, priceInput(SHORT_TIMEOUT_MS));
    const unanswered = await pendingQuery(rpc, oracleSlot, 30_000);
    const reported = await rpc.oracleResolve(unanswered.queryId, new Uint8Array(0), ORACLE_STATUS.UNRESOLVABLE);
    if (!reported.ok) fail(`the unavailable report was refused: ${JSON.stringify(reported)}`);
    const unavailableSequence = await watchStatus(
        rpc,
        oracleSlot,
        2,
        unanswered.queryId,
        (status) => status === ORACLE_STATUS.TIMEOUT || status === ORACLE_STATUS.UNRESOLVABLE,
        REVEAL_BUDGET_MS,
    );
    const timeoutStatus = (await waitNotified(rpc, oracleSlot, ORACLE_STATUS.TIMEOUT)).getUint8(28);

    // an oc invocation: refused while the contract cannot pay the fee, then authorized by the computors with no machine in sight
    await send(base, rpc, seed, ocSlot, 2, 0, u64Input(7n));
    const refused = await call(rpc, ocSlot, 1, new Uint8Array(0));
    const ocRefused = refused.getBigInt64(0, true) === -1n;

    const beforeInvoke = await contractBalance(ocSlot);
    await send(base, rpc, seed, ocSlot, 2, 1_000, u64Input(42n));
    const invoked = await call(rpc, ocSlot, 1, new Uint8Array(0));
    const invocationId = invoked.getBigInt64(0, true);
    if (invocationId < 0n) fail(`a funded oc invocation was refused on ${base}`);
    const ocSequence = await watchStatus(rpc, ocSlot, 2, invocationId, (status) => status === OC_INVOCATION_STATUS.AUTHORIZED, REVEAL_BUDGET_MS);
    if (ocSequence[0] !== OC_INVOCATION_STATUS.PENDING_AUTH) ocSequence.unshift(OC_INVOCATION_STATUS.PENDING_AUTH);
    const ocObserved = distinct(ocSequence);
    const afterInvoke = await contractBalance(ocSlot);

    // a query the contract cannot pay for: the notification about it runs before QUERY_ORACLE returns, so the procedure sees it in its own state
    await send(base, rpc, seed, inlineSlot, 2, 0, priceInput(QUERY_TIMEOUT_MS));
    const inline = await call(rpc, inlineSlot, 1, new Uint8Array(0));

    return {
        querySequence,
        notifiedStatus: last.getUint8(28),
        numerator: last.getBigInt64(0, true),
        denominator: last.getBigInt64(8, true),
        balanceAfterQuery: beforeQuery + 1_000n - balanceAfterQuery,
        unavailableSequence: distinct(unavailableSequence),
        timeoutStatus,
        ocRefused,
        ocSequence: ocObserved,
        ocInvocations: invoked.getBigUint64(8, true),
        ocBalanceSpent: beforeInvoke + 1_000n - afterInvoke,
        inlineNotifications: inline.getBigUint64(0, true),
        inlineSeenInsideCall: inline.getBigUint64(8, true),
        inlineQueryId: inline.getBigInt64(16, true),
    };
}

async function contractIdentity(slot: number): Promise<string> {
    const { bytesToIdentity } = await import("@qinit/core");
    const { contractAddress } = await import("@qinit/proto");
    return bytesToIdentity(contractAddress(slot));
}

await initK12();
assertCoreBuildProfile(core, ["build-node"], {
    CMAKE_BUILD_TYPE: "RelWithDebInfo",
    CMAKE_C_COMPILER: /clang-18$/,
    CMAKE_CXX_COMPILER: /clang\+\+-18$/,
});
const qpiHeader = loadQpiHeader(core);
assertPinnedQpiHeader(qpiHeader);

const coreRpc = new LiteRpc(rpcBaseUrl);
const registry = await coreRpc.dynRegistry();
const oracleSlot = registry.slotBase;
const ocSlot = registry.slotBase + 1;
const inlineSlot = registry.slotBase + 2;
const artifacts = [
    await compile("OracleProbe", oracleSlot, qpiHeader),
    await compile("OcProbe", ocSlot, qpiHeader),
    await compile("OracleInline", inlineSlot, qpiHeader),
];
for (const artifact of artifacts) {
    console.log(`${artifact.name.padEnd(12)} slot ${artifact.slot}: ${artifact.wasm.length}B · ${artifact.hash}`);
}

const simulatorServer = new EngineServer(new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount }));
const simulator = await simulatorServer.start(0, 1000);
try {
    const simulatorRpc = new LiteRpc(simulator.rpcBaseUrl);
    const simulatorSeed = (await simulatorRpc.fundedSeed()) ?? FALLBACK_SEED;
    const coreSeed = (await coreRpc.fundedSeed()) ?? FALLBACK_SEED;
    await deployAll(simulator.rpcBaseUrl, simulatorRpc, artifacts, simulatorSeed);
    await deployAll(rpcBaseUrl, coreRpc, artifacts, coreSeed);

    const observed = new Map<string, Observed>();
    observed.set("simulator", await observe(simulator.rpcBaseUrl, simulatorRpc, simulatorSeed, oracleSlot, ocSlot, inlineSlot));
    observed.set("core", await observe(rpcBaseUrl, coreRpc, coreSeed, oracleSlot, ocSlot, inlineSlot));

    const expected = {
        // pending, then the quorum's commit, then the revealed value
        querySequence: [ORACLE_STATUS.PENDING, ORACLE_STATUS.COMMITTED, ORACLE_STATUS.SUCCESS],
        notifiedStatus: ORACLE_STATUS.SUCCESS,
        numerator: 123456n,
        denominator: 1000n,
        balanceAfterQuery: 10n,
        unavailableSequence: [ORACLE_STATUS.PENDING, ORACLE_STATUS.TIMEOUT],
        timeoutStatus: ORACLE_STATUS.TIMEOUT,
        ocRefused: true,
        ocSequence: [OC_INVOCATION_STATUS.PENDING_AUTH, OC_INVOCATION_STATUS.AUTHORIZED],
        ocInvocations: 1n,
        ocBalanceSpent: 10n,
        inlineNotifications: 1n,
        inlineSeenInsideCall: 1n,
        inlineQueryId: -1n,
    };
    for (const [name, result] of observed) {
        const actual = JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
        const wanted = JSON.stringify(expected, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
        if (actual !== wanted) fail(`${name} differs\n  expected ${wanted}\n  actual   ${actual}`);
    }

    console.log(
        `ORACLE DUAL OK — simulator and core agree: query ${expected.querySequence.join("→")} with ${expected.numerator}/${expected.denominator}, ` +
            `an unanswered query ends ${expected.unavailableSequence.join("→")}, oc ${expected.ocSequence.join("→")}, both fees 10 QU`,
    );
} finally {
    simulator.stop();
}
