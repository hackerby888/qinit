// Contract call/invoke, qubic-cli style, over the built-in RPC.
//   function (read)  -> POST /live/v1/querySmartContract
import { LiteRpc, buildSignedTx, broadcastTx, type BroadcastResult, type SignedTx } from "@qinit/core";
import { decodeOutput, encodeInput, encodeInputJson } from "./abi-fmt";
import type { AbiType } from "./contract-idl";
import { TX_TICK_OFFSET } from "./protocol";

export interface TypedContractInput {
    type: AbiType;
    value: unknown;
}

// Resolve a deployment inside the node's advertised dynamic window.
// Reuse a same-named contract's slot (upgrade); otherwise use the first free slot.
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
    outputFormat: string | AbiType,
): Promise<any> {
    const encodedInput =
        typeof input === "string" ? await encodeInput(input) : input instanceof Uint8Array ? input : await encodeInputJson(input.type, input.value);
    const output = await rpc.querySmartContract(contractIndex, functionId, encodedInput);
    return await decodeOutput(output, outputFormat);
}

// What every signed-tx submission returns: the broadcast result plus how far confirmation got.
export type SubmittedTx = BroadcastResult & {
    txId?: string;
    tick?: number;
    confirmed?: boolean;
    included?: boolean;
    moneyFlew?: boolean;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll until the node has processed the tx's target tick. Undefined means the node cannot say: it has no
// tx-status route, or the wait ran out — either way the tx's fate is unknown and must not be assumed.
async function awaitProcessed(rpc: LiteRpc, txId: string, tick: number, opts: SubmitOptions): Promise<{ found: boolean; moneyFlew: boolean } | undefined> {
    const deadline = Date.now() + (opts.confirmTimeoutMs ?? 30000);
    for (;;) {
        try {
            const status = await rpc.txStatus(tick, txId);
            opts.onProgress?.({ tick: status.currentTick ?? 0, target: tick });
            if (status.processed) {
                return { found: status.found, moneyFlew: status.moneyFlew };
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
        await sleep(300);
    }
}

// Broadcast a signed tx and, when asked, poll until its target tick has executed. Shared by every
// submission path — a contract procedure and a plain transfer differ only in how the tx was built.
// A tx the node processed without including is resent for a later tick; an unknown fate never is,
// because a blind resend of a tx that did land would execute it twice.
async function broadcastAndConfirm(buildTx: TransactionBuilder, opts: SubmitOptions): Promise<SubmittedTx> {
    const rpc = opts.rpc ?? new LiteRpc(opts.rpcBaseUrl);
    const resends = opts.resends ?? MAX_TX_RESENDS;
    let tick = opts.tick;

    for (let attempt = 0; ; attempt++) {
        const tx = await buildTx(tick);
        const broadcast = await broadcastTx(tx.bytes, opts.rpcBaseUrl);
        const result = { ...broadcast, txId: tx.id, tick };

        // The tx is in the mempool now, so a dev node can be pulled straight past the tick that executes it.
        await rpc.hurryToTick(tick + 1);
        if (!opts.confirm) {
            return result;
        }

        const processed = await awaitProcessed(rpc, tx.id, tick, opts);
        if (!processed) {
            return { ...result, confirmed: false };
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
        amount: number;
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

// Invoke a contract procedure (signed tx). tick must be a near-future, accepted tick.
// With confirmation, poll tx status until processed or fall back to tick advancement.
export async function invokeProcedure(
    opts: SubmitOptions & {
        seed: string;
        contractIndex: number;
        procedureId: number;
        amount: number;
        inputFormat?: string;
        input?: Uint8Array | TypedContractInput;
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
              : await encodeInput(opts.inputFormat ?? "");
    const buildTx = (tick: number) =>
        buildSignedTx(opts.seed, {
            destination: contractAddress(opts.contractIndex),
            amount: opts.amount,
            tick,
            inputType: opts.procedureId,
            payload,
        });

    return broadcastAndConfirm(buildTx, opts);
}
