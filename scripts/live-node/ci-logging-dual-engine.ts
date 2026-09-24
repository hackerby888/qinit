// Compile Logger once, then compare exact LOG_* bytes from QubicSimulator and the release-configured core-lite WAMR node. Needs QINIT_CORE + QINIT_RPC.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_RPC_BASE, initK12, k12Hex, LiteRpc } from "@qinit/core";
import { compileContractWithTypeScript, DEFAULT_COMPILE_ARENA_SIZE_BYTES, DiagnosticSeverity, inspectWasmModule, loadQpiHeader } from "@qinit/compiler";
import { QubicSimulator, VirtualNode } from "@qinit/engine";
import { EngineServer } from "@qinit/engine/server";
import { identityToBytes } from "@qinit/core/crypto/qubic";
import { QUBIC_LOG_TYPE, TXS_PER_TICK } from "@qinit/proto";
import { packAssetName } from "@qinit/engine/ledger/assets";
import { readTickLogs, type TickLogRecord } from "./peer-log-reader";
import { deployContract } from "@qinit/cli/ops/deploy";
import { invokeProcedure, resolveDeploymentSlot } from "@qinit/proto";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");
const rpcBaseUrl = process.env.QINIT_RPC ?? DEFAULT_RPC_BASE;
const rpc = new LiteRpc(rpcBaseUrl);
const contractPath = resolve("fixtures/Logger.h");
const source = readFileSync(contractPath, "utf8");
const expectSameLogs = (left: Array<{ type: number; size: number; hex: string }>, right: Array<{ type: number; size: number; hex: string }>, label: string) => {
    const shape = (logs: typeof left) => logs.map((log) => [log.type, log.size, log.hex]);
    if (JSON.stringify(shape(left)) !== JSON.stringify(shape(right))) {
        throw new Error(`${label} differs: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
    }
};

await initK12();
const { slot } = await resolveDeploymentSlot(rpc, "LoggerDual");
const compiled = await compileContractWithTypeScript({
    source,
    contractName: "LoggerDual",
    slot,
    qpiHeader: loadQpiHeader(core),
    arenaSizeBytes: DEFAULT_COMPILE_ARENA_SIZE_BYTES,
});
const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR);
if (errors.length) {
    throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
}
if (!compiled.idl) {
    throw new Error("successful LoggerDual compile returned no IDL");
}
const inspection = inspectWasmModule(compiled.wasm);
if (!inspection.ok) {
    throw new Error(inspection.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
}

const sim = new QubicSimulator({ mempool: false, fees: "off" });
sim.setDebug(true);
sim.deploy(slot, compiled.wasm);
const input = new Uint8Array(8);
new DataView(input.buffer).setBigUint64(0, 2n, true);
sim.procedure(slot, 1, input);
const simLogs =
    sim
        .getTrace()
        .entries.filter((entry) => entry.index === slot && entry.kind === 1)
        .at(-1)?.logs ?? [];
if (simLogs.length !== 2) {
    throw new Error(`QubicSimulator emitted ${simLogs.length} logs, expected 2`);
}

const hash = await k12Hex(compiled.wasm);
const deployed = await deployContract(
    {
        contractPath,
        name: "LoggerDual",
        core,
        rpcBaseUrl,
        slotOverride: slot,
        artifact: {
            wasm: compiled.wasm,
            hash,
            registration: {
                functions: compiled.idl.functions.length,
                procedures: compiled.idl.procedures.length,
            },
        },
        rpc,
    },
    () => {},
);
if (!deployed.ok || !deployed.armed || !deployed.constructed) {
    throw new Error(`deploy failed: ${JSON.stringify(deployed)}`);
}

await rpc.setDebug(true);
const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tick = (await rpc.tickInfo()).tick + 6;
const invoked = await invokeProcedure({
    seed,
    rpcBaseUrl,
    contractIndex: slot,
    procedureId: 1,
    amount: 0,
    inputFormat: "2uint64",
    tick,
    confirm: true,
    confirmTimeoutMs: 60_000,
    rpc,
});
if (!invoked.ok || !invoked.confirmed || !invoked.included) {
    throw new Error(`invoke failed: ${JSON.stringify(invoked)}`);
}

let nodeLogs: typeof simLogs = [];
for (let i = 0; i < 10 && !nodeLogs.length; i++) {
    const trace = await rpc.debugTrace(0, 200);
    nodeLogs = trace.entries.filter((entry) => entry.index === slot && entry.kind === 1 && entry.logs.length).at(-1)?.logs ?? [];
    if (!nodeLogs.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
}
expectSameLogs(nodeLogs, simLogs, "LOG_* trace bytes");
console.log(`LOGGING DUAL OK — exact ${compiled.wasm.length}B artifact emitted ${nodeLogs.length} identical logs in QubicSimulator and WAMR at slot ${slot}`);

// native records — transfers, markers, management changes — never reach the debug trace, so both nodes are read over the peer log protocol.
const NATIVE_FIXTURES = ["Dividend", "ShareApprover", "ShareManager"] as const;
const DIVIDEND_PER_SHARE = 3n;
const peerHost = new URL(rpcBaseUrl).hostname;
const peerPort = Number(process.env.QINIT_PEER_PORT ?? "31841");

const registry = await rpc.dynRegistry();
const freeSlots = registry.contracts.filter((contract) => !contract.armed && contract.index !== slot).map((contract) => contract.index);
if (freeSlots.length < NATIVE_FIXTURES.length) {
    throw new Error(`native log parity needs ${NATIVE_FIXTURES.length} free dynamic slots, node has ${freeSlots.length}`);
}
const nativeSlots = Object.fromEntries(NATIVE_FIXTURES.map((name, index) => [name, freeSlots[index]])) as Record<(typeof NATIVE_FIXTURES)[number], number>;

const simulatorServer = new EngineServer(new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount }));
const simulator = await simulatorServer.start(0, 25, 0);
const simulatorRpc = new LiteRpc(simulator.rpcBaseUrl);
const simulatorSeed = (await simulatorRpc.fundedSeed()) ?? seed;

try {
    // core's testnet hands one share of every contract's asset to each computor, in list order; the simulator's ledger is given the same holders.
    const explorer = (await (await fetch(`${rpcBaseUrl}/explorer/data`)).json()) as { computors: { index: number; publicKey: string }[] };
    const computors = explorer.computors.sort((left, right) => left.index - right.index).map((computor) => identityToBytes(computor.publicKey));
    if (!computors.length) {
        throw new Error("core lists no computors");
    }

    const runtimes = [
        { name: "simulator", base: simulator.rpcBaseUrl, client: simulatorRpc, signer: simulatorSeed, host: "127.0.0.1", port: simulator.peerPort! },
        { name: "core", base: rpcBaseUrl, client: rpc, signer: seed, host: peerHost, port: peerPort },
    ];
    const streams = new Map<string, Record<string, TickLogRecord[]>>();

    for (const runtime of runtimes) {
        for (const name of NATIVE_FIXTURES) {
            const fixturePath = resolve(`fixtures/${name}.h`);
            const built = await compileContractWithTypeScript({
                source: readFileSync(fixturePath, "utf8"),
                contractName: name,
                slot: nativeSlots[name],
                qpiHeader: loadQpiHeader(core),
                arenaSizeBytes: DEFAULT_COMPILE_ARENA_SIZE_BYTES,
            });
            if (built.diagnostics.some((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR) || !built.idl) {
                throw new Error(`${name} compile failed`);
            }
            const result = await deployContract(
                {
                    contractPath: fixturePath,
                    name: `Native${name}`,
                    core,
                    rpcBaseUrl: runtime.base,
                    rpc: runtime.client,
                    seed: runtime.signer,
                    slotOverride: nativeSlots[name],
                    artifact: {
                        wasm: built.wasm,
                        hash: await k12Hex(built.wasm),
                        registration: { functions: built.idl.functions.length, procedures: built.idl.procedures.length },
                    },
                },
                () => {},
            );
            if (!result.ok || !result.armed || !result.constructed) {
                throw new Error(`${runtime.name} ${name} deploy failed: ${JSON.stringify(result)}`);
            }
        }

        if (runtime.name === "simulator") {
            const ledger = simulatorServer.engine.sim;
            const assetName = `LDYN${nativeSlots.Dividend - registry.slotBase}`;
            ledger.mintDeployShares(nativeSlots.Dividend, assetName, computors[0], BigInt(computors.length));
            for (const computor of computors.slice(1)) {
                ledger.host.transferShareOwnershipAndPossession(1, packAssetName(assetName), new Uint8Array(32), computors[0], computors[0], 1n, computor);
            }
        }

        const send = async (contractIndex: number, procedureId: number, amount: bigint, input: Uint8Array): Promise<number> => {
            const sent = await invokeProcedure({
                seed: runtime.signer,
                rpcBaseUrl: runtime.base,
                rpc: runtime.client,
                contractIndex,
                procedureId,
                amount,
                input,
                tick: (await runtime.client.tickInfo()).tick + 6,
                confirm: true,
                confirmTimeoutMs: 60_000,
            });
            if (!sent.ok || !sent.confirmed || !sent.included || sent.tick === undefined) {
                throw new Error(`${runtime.name} slot ${contractIndex} procedure ${procedureId} was not included: ${JSON.stringify(sent)}`);
            }
            return sent.tick;
        };
        // a core tick also carries the computors' own protocol transactions, so only the range opened by the transfer into the contract is compared.
        const transactionRecords = async (tick: number, contractIndex: number) => {
            const records = (await readTickLogs(runtime.host, runtime.port, tick)).filter((record) => record.txIndex < TXS_PER_TICK);
            const opening = records.find(
                (record) => record.type === QUBIC_LOG_TYPE.QU_TRANSFER && new DataView(record.message.buffer).getBigUint64(32, true) === BigInt(contractIndex),
            );
            // both engines book an execution fee once per phase, outside any transaction, so it never belongs to the compared range.
            return records.filter((record) => record.txIndex === opening?.txIndex && record.type !== QUBIC_LOG_TYPE.CONTRACT_RESERVE_DEDUCTION);
        };

        // the amount is measured time on core and a formula here, so only the record's shape can be compared.
        const deductions = async (ticks: number[]) => {
            const found: { tick: number; contractIndex: number; deductedAmount: bigint; remainingAmount: bigint }[] = [];
            for (const tick of ticks) {
                for (const record of await readTickLogs(runtime.host, runtime.port, tick)) {
                    if (record.type !== QUBIC_LOG_TYPE.CONTRACT_RESERVE_DEDUCTION) {
                        continue;
                    }
                    const view = new DataView(record.message.buffer, record.message.byteOffset, record.message.byteLength);
                    found.push({
                        tick,
                        deductedAmount: view.getBigUint64(0, true),
                        remainingAmount: view.getBigInt64(8, true),
                        contractIndex: view.getUint32(16, true),
                    });
                }
            }
            return found;
        };

        // funded in its own transaction, since the payout tick is compared byte for byte; both nodes debit one share per committee seat.
        await send(nativeSlots.Dividend, 1, DIVIDEND_PER_SHARE * BigInt(computors.length), new Uint8Array(0));
        const amountPerShare = new Uint8Array(8);
        new DataView(amountPerShare.buffer).setBigInt64(0, DIVIDEND_PER_SHARE, true);
        const payoutTick = await send(nativeSlots.Dividend, 2, 0n, amountPerShare);

        // ShareApprover.Issue { name, shares }, then ShareManager.Acquire { name, issuer, holder, shares, source manager, offered fee 0 }.
        const tokenName = 0x4e454b4f54n;
        const issue = new Uint8Array(16);
        new DataView(issue.buffer).setBigUint64(0, tokenName, true);
        new DataView(issue.buffer).setBigInt64(8, 1000n, true);
        await send(nativeSlots.ShareApprover, 1, 0n, issue);

        const approverId = new Uint8Array(32);
        new DataView(approverId.buffer).setBigUint64(0, BigInt(nativeSlots.ShareApprover), true);
        const acquire = new Uint8Array(96);
        const acquireView = new DataView(acquire.buffer);
        acquireView.setBigUint64(0, tokenName, true);
        acquire.set(approverId, 8);
        acquire.set(approverId, 40);
        acquireView.setBigInt64(72, 400n, true);
        acquireView.setUint16(80, nativeSlots.ShareApprover, true);
        // one qu rides along so the acquiring contract has a spectrum entry to send its zero-amount transfers from.
        const releaseTick = await send(nativeSlots.ShareManager, 2, 1n, acquire);

        streams.set(runtime.name, {
            payout: await transactionRecords(payoutTick, nativeSlots.Dividend),
            release: await transactionRecords(releaseTick, nativeSlots.ShareManager),
        });

        // a phase is one pass over the committee, 676 ticks, so the charge for the run above lands at the boundary after it: wait for that
        // tick (about eleven minutes on a node ticking once a second) before reading the deductions.
        const boundary = (Math.floor(releaseTick / computors.length) + 1) * computors.length;
        console.log(`${runtime.name}: waiting for phase boundary ${boundary} (${boundary - releaseTick} ticks after tick ${releaseTick})`);
        const deadline = Date.now() + 20 * 60_000;
        while ((await runtime.client.tickInfo()).tick <= boundary + 1) {
            if (Date.now() > deadline) {
                throw new Error(`${runtime.name} did not reach phase boundary ${boundary} within twenty minutes`);
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
        // the deduction lands on the boundary tick; reading every tick since the payout would be hundreds of peer requests for nothing.
        const boundaryTicks = [boundary - 1, boundary, boundary + 1];
        const charged = await deductions(boundaryTicks);
        if (!charged.length) {
            throw new Error(`${runtime.name} charged no execution fees across ticks ${payoutTick}..${releaseTick}`);
        }
        for (const row of charged) {
            if (row.deductedAmount <= 0n) {
                throw new Error(`${runtime.name} logged a ${row.deductedAmount} deduction for contract ${row.contractIndex}`);
            }
            const phaseOf = (tick: number) => Math.floor(tick / computors.length);
            const perPhase = charged.filter((other) => other.contractIndex === row.contractIndex && phaseOf(other.tick) === phaseOf(row.tick));
            if (perPhase.length > 1) {
                throw new Error(`${runtime.name} charged contract ${row.contractIndex} ${perPhase.length} times in phase ${phaseOf(row.tick)}`);
            }
        }
        // the records must describe the reserve they moved: each one lands exactly its own amount below the previous, and the
        // live reserve is at or below the last of them (nothing but a burn can raise it, and these fixtures do not burn).
        const reported = await runtime.client.dynRegistry();
        for (const contractIndex of new Set(charged.map((row) => row.contractIndex))) {
            const rows = charged.filter((row) => row.contractIndex === contractIndex);
            for (let index = 1; index < rows.length; index++) {
                const expected = rows[index - 1].remainingAmount - rows[index].deductedAmount;
                if (rows[index].remainingAmount !== expected) {
                    throw new Error(
                        `${runtime.name} contract ${contractIndex} left ${rows[index].remainingAmount} after taking ${rows[index].deductedAmount}, expected ${expected}`,
                    );
                }
            }
            const live = reported.contracts.find((contract) => contract.index === contractIndex)?.feeReserve;
            if (live !== undefined && BigInt(live) > rows.at(-1)!.remainingAmount) {
                throw new Error(
                    `${runtime.name} contract ${contractIndex} reports reserve ${live}, above the ${rows.at(-1)!.remainingAmount} its last deduction left`,
                );
            }
        }
        console.log(
            `${runtime.name}: ${charged.length} execution-fee deductions over ticks ${boundaryTicks[0]}..${boundaryTicks[2]}, at most one per contract per phase`,
        );
    }

    const shape = (records: TickLogRecord[]) => records.map((record) => `${record.type}:${Buffer.from(record.message).toString("hex")}`);
    for (const scenario of ["payout", "release"]) {
        const simulated = shape(streams.get("simulator")![scenario]);
        const native = shape(streams.get("core")![scenario]);
        if (!simulated.length || JSON.stringify(simulated) !== JSON.stringify(native)) {
            const length = Math.max(simulated.length, native.length);
            const firstDifference = Array.from({ length }, (_, index) => index).find((index) => simulated[index] !== native[index]);
            throw new Error(
                `${scenario} log records differ at ${firstDifference} (simulator ${simulated.length}, core ${native.length}): ` +
                    `${simulated[firstDifference!] ?? "nothing"} != ${native[firstDifference!] ?? "nothing"}`,
            );
        }
    }
    console.log(
        `NATIVE LOG DUAL OK — ${streams.get("core")!.payout.length} payout and ${streams.get("core")!.release.length} zero-fee release records byte-identical`,
    );
} finally {
    simulator.stop();
}
