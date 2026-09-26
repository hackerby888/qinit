// Contract call/invoke, qubic-cli style, over the built-in RPC — a function (read) goes to POST /live/v1/querySmartContract.
import {
    LiteRpc,
    buildSignedTx,
    broadcastTx,
    deriveIdentity,
    hexToBytes,
    type BroadcastResult,
    type DebugEntry,
    type EngineFaultInfo,
    type SignedTx,
} from "@qinit/core";
import { decodeAbi, encodeInputFormat, encodeInputJson } from "./abi";
import type { AbiType } from "./contract-idl";
import { TX_TICK_OFFSET } from "./protocol";

export interface TypedContractInput {
    type: AbiType;
    value: unknown;
}

// Resolve a deployment inside the node's advertised dynamic window: reuse a same-named contract's slot (upgrade), otherwise take the first free slot.
export async function resolveDeploymentSlot(rpc: LiteRpc, name: string, override?: number): Promise<{ slot: number; reused: boolean }> {
    const reg = await rpc.dynRegistry();
    const contracts = reg.contracts ?? [];
    const inDynamicRange = (slot: number): boolean => Number.isInteger(slot) && slot >= reg.slotBase && slot < reg.slotBase + reg.slotCount;

    if (override !== undefined && !Number.isNaN(override)) {
        if (!inDynamicRange(override)) {
            throw new Error(`slot ${override} is outside dynamic range ${reg.slotBase}..${reg.slotBase + reg.slotCount - 1}`);
        }

        const occupant = contracts.find((contract) => contract.index === override && contract.armed);
        if (occupant && occupant.name !== name) {
            throw new Error(`slot ${override} is occupied by '${occupant.name}', not '${name}'`);
        }

        const matching = contracts.find((contract) => inDynamicRange(contract.index) && contract.armed && contract.name === name);
        if (matching && matching.index !== override) {
            throw new Error(`'${name}' is already deployed at slot ${matching.index}, not requested slot ${override}`);
        }

        return { slot: override, reused: occupant?.name === name };
    }
    const mine = contracts.find((contract) => inDynamicRange(contract.index) && contract.armed && contract.name === name);
    if (mine) {
        return { slot: mine.index, reused: true };
    }
    const free = contracts.find((contract) => inDynamicRange(contract.index) && !contract.armed);
    if (free) {
        return { slot: free.index, reused: false };
    }
    throw new Error(`no free dynamic slot (all ${reg.slotCount ?? contracts.length} in use)`);
}

// A contract's address = id(contractIndex, 0, 0, 0).
export function contractAddress(contractIndex: number): Uint8Array {
    const a = new Uint8Array(32);
    new DataView(a.buffer).setBigUint64(0, BigInt(contractIndex), true);
    return a;
}

export async function callFunction(
    rpc: LiteRpc,
    contractIndex: number,
    functionId: number,
    input: string | Uint8Array | TypedContractInput,
    outputType: string | AbiType,
): Promise<any> {
    const encodedInput =
        typeof input === "string" ? await encodeInputFormat(input) : input instanceof Uint8Array ? input : await encodeInputJson(input.type, input.value);
    const output = await rpc.querySmartContract(contractIndex, functionId, encodedInput);
    return await decodeAbi(output, outputType);
}

// What every signed-tx submission returns: the broadcast result plus how far confirmation got.
export type SubmittedTx = BroadcastResult & {
    txId?: string;
    tick?: number;
    confirmed?: boolean;
    included?: boolean;
    moneyFlew?: boolean;
    fault?: EngineFaultInfo;
    traceEntry?: DebugEntry;
    failedCallees?: DebugEntry[];
    output?: unknown;
};

interface SubmitOptions {
    rpcBaseUrl: string;
    tick: number;
    confirm?: boolean;
    rpc?: LiteRpc;
    confirmTimeoutMs?: number;
    resends?: number; // how many times a tx that missed its tick is rebuilt for a later one (0 disables)
    onProgress?: (i: { tick: number; target: number }) => void; // live network-tick vs target while confirming
}

// A transaction is signed for one tick, so a missed tick means signing a new one rather than rebroadcasting.
type TransactionBuilder = (tick: number) => Promise<SignedTx>;

const MAX_TX_RESENDS = 3;
const TRACE_KIND_PROCEDURE = 1;
const TRACE_KIND_SYSTEM_PROCEDURE = 2;

// the frames a dispatch called directly. a node too old to record `children` leaves only the completion window,
// which can still catch an unrelated same-tick frame; sysprocs are the one kind a user dispatch never calls.
export function traceChildren(parent: DebugEntry, entries: readonly DebugEntry[], sinceSeq: number): DebugEntry[] {
    if (parent.children) {
        return entries.filter((entry) => parent.children!.includes(entry.seq));
    }
    return entries.filter(
        (entry) => entry.seq > sinceSeq && entry.seq < parent.seq && entry.tick === parent.tick && entry.kind !== TRACE_KIND_SYSTEM_PROCEDURE,
    );
}

// every frame under a dispatch with its depth, callees before their own callees' siblings: the order they completed in.
export function traceDescendants(parent: DebugEntry, entries: readonly DebugEntry[], sinceSeq: number, depth = 0): { entry: DebugEntry; depth: number }[] {
    return traceChildren(parent, entries, sinceSeq).flatMap((entry) => [{ entry, depth }, ...traceDescendants(entry, entries, sinceSeq, depth + 1)]);
}
const TRACE_POLL_ATTEMPTS = 10;
const POLL_INTERVAL_MS = 300;

type ProcessedVerdict = { found: boolean; moneyFlew: boolean } | { fault: EngineFaultInfo };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until the node has processed the tx's target tick. Undefined means the node cannot say, so the tx's fate is unknown and must not be assumed.
async function awaitProcessed(rpc: LiteRpc, txId: string, tick: number, opts: SubmitOptions): Promise<ProcessedVerdict | undefined> {
    const deadline = Date.now() + (opts.confirmTimeoutMs ?? 30000);
    let faultRouteServed = true;
    for (;;) {
        try {
            const status = await rpc.txStatus(tick, txId);
            opts.onProgress?.({ tick: status.currentTick ?? 0, target: tick });
            if (status.processed) {
                return { found: status.found, moneyFlew: status.moneyFlew };
            }

            // a halted node never passes the target tick, so ask why instead of waiting out the deadline.
            if (faultRouteServed) {
                try {
                    const fault = await rpc.faultInfo();
                    if (fault) {
                        return { fault };
                    }
                } catch {
                    faultRouteServed = false;
                }
            }
        } catch {
            // addon missing — degrade to a tick-margin wait (node passed the target tick)
            try {
                const tickInfo = await rpc.tickInfo();
                const current = tickInfo.tick ?? 0;
                opts.onProgress?.({ tick: current, target: tick });
                if (current > tick) {
                    return undefined;
                }
            } catch {}
        }
        if (Date.now() > deadline) {
            return undefined;
        }
        await sleep(POLL_INTERVAL_MS);
    }
}

// Broadcast a signed tx, polling its target tick when asked. A processed-but-unincluded tx is resent; an unknown fate never is — a resend could run it twice.
async function broadcastAndConfirm(buildTx: TransactionBuilder, opts: SubmitOptions): Promise<SubmittedTx> {
    const rpc = opts.rpc ?? new LiteRpc(opts.rpcBaseUrl);
    const resends = opts.resends ?? MAX_TX_RESENDS;
    let tick = opts.tick;

    for (let attempt = 0; ; attempt++) {
        const tx = await buildTx(tick);
        const broadcast = await broadcastTx(tx.bytes, opts.rpcBaseUrl);
        const result = { ...broadcast, txId: tx.id, tick };

        // The tx is in the mempool now, so a dev node can be pulled straight past the tick that executes it.
        const hurried = rpc.hurryToTick(tick + 1);
        if (!opts.confirm) {
            await hurried;
            return result;
        }

        // not awaited: an older node that halts on this tx holds the advance open for its whole time budget.
        const processed = await awaitProcessed(rpc, tx.id, tick, opts);
        if (!processed) {
            return { ...result, confirmed: false };
        }

        if ("fault" in processed) {
            return { ...result, confirmed: false, fault: processed.fault };
        }

        if (processed.found || attempt >= resends) {
            return {
                ...result,
                confirmed: true,
                included: processed.found,
                moneyFlew: processed.moneyFlew,
            };
        }

        // The tick came and went without the tx, so it is lost rather than pending: sign a fresh one further out.
        tick = (await rpc.tickInfo()).tick + TX_TICK_OFFSET;
    }
}

// Send QU from a seed to a destination public key — a plain transfer, so no contract and no payload.
export async function sendTransfer(
    opts: SubmitOptions & {
        seed: string;
        destination: Uint8Array;
        amount: number | bigint;
    },
): Promise<SubmittedTx> {
    const buildTx = (tick: number) =>
        buildSignedTx(opts.seed, {
            destination: opts.destination,
            amount: opts.amount,
            tick,
            inputType: 0,
            payload: new Uint8Array(0),
        });

    return broadcastAndConfirm(buildTx, opts);
}

// The newest trace seq before dispatch, or undefined when the node serves no trace.
async function armTrace(rpc: LiteRpc): Promise<number | undefined> {
    try {
        await rpc.setDebug(true);
        const newest = (await rpc.debugTrace(0, 1)).entries ?? [];

        return newest.length ? newest[newest.length - 1].seq : 0;
    } catch {
        return undefined;
    }
}

interface TraceMatch {
    sinceSeq: number;
    tick: number;
    contractIndex: number;
    procedureId: number;
    invocatorHex: string;
}

// Find the dispatch a confirmed tx caused. Tick plus signer identifies it, so parallel calls to one procedure do not cross.
async function collectTrace(rpc: LiteRpc, match: TraceMatch): Promise<{ traceEntry: DebugEntry; failedCallees: DebugEntry[] } | undefined> {
    for (let attempt = 0; attempt < TRACE_POLL_ATTEMPTS; attempt++) {
        let entries: DebugEntry[];
        try {
            entries = (await rpc.debugTrace(match.sinceSeq, 200)).entries ?? [];
        } catch {
            return undefined;
        }

        const traceEntry = entries.find(
            (entry) =>
                entry.seq > match.sinceSeq &&
                entry.tick === match.tick &&
                entry.index === match.contractIndex &&
                entry.kind === TRACE_KIND_PROCEDURE &&
                entry.entry === match.procedureId &&
                entry.invocator.toLowerCase() === match.invocatorHex,
        );
        if (traceEntry) {
            const failedCallees = traceDescendants(traceEntry, entries, match.sinceSeq)
                .map((descendant) => descendant.entry)
                .filter((entry) => !entry.ok);

            return { traceEntry, failedCallees };
        }

        await sleep(POLL_INTERVAL_MS);
    }

    return undefined;
}

// Invoke a contract procedure (signed tx); tick must be a near-future accepted tick. With confirmation, poll tx status or fall back to tick advancement.
export async function invokeProcedure(
    opts: SubmitOptions & {
        seed: string;
        contractIndex: number;
        procedureId: number;
        amount: number | bigint;
        inputFormat?: string;
        input?: Uint8Array | TypedContractInput;
        trace?: boolean; // read the dispatch back from the node's debug trace (dev nodes only)
        outputType?: string | AbiType;
    },
): Promise<SubmittedTx> {
    if (opts.input && opts.inputFormat !== undefined) {
        throw new Error("procedure input must use either typed input or inputFormat");
    }
    const payload =
        opts.input instanceof Uint8Array
            ? opts.input
            : opts.input
              ? await encodeInputJson(opts.input.type, opts.input.value)
              : await encodeInputFormat(opts.inputFormat ?? "");
    const buildTx = (tick: number) =>
        buildSignedTx(opts.seed, {
            destination: contractAddress(opts.contractIndex),
            amount: opts.amount,
            tick,
            inputType: opts.procedureId,
            payload,
        });

    const rpc = opts.rpc ?? new LiteRpc(opts.rpcBaseUrl);
    const sinceSeq = opts.trace ? await armTrace(rpc) : undefined;
    const submitted = await broadcastAndConfirm(buildTx, { ...opts, rpc });
    if (sinceSeq === undefined || !submitted.included || submitted.tick === undefined) {
        return submitted;
    }

    const traced = await collectTrace(rpc, {
        sinceSeq,
        tick: submitted.tick,
        contractIndex: opts.contractIndex,
        procedureId: opts.procedureId,
        invocatorHex: (await deriveIdentity(opts.seed)).publicKeyHex.toLowerCase(),
    });
    if (!traced) {
        return submitted;
    }

    const decodable = traced.traceEntry.ok && opts.outputType !== undefined;
    const output = decodable ? await decodeAbi(hexToBytes(traced.traceEntry.outHex), opts.outputType!) : undefined;

    return { ...submitted, ...traced, output };
}
