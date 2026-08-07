// Contract call/invoke, qubic-cli style, over the built-in RPC.
//   function (read)  -> POST /live/v1/querySmartContract
import {
  LiteRpc,
  buildSignedTx,
  broadcastTx,
  type BroadcastResult,
  type SignedTx,
} from "@qinit/core";
import { decodeOutput, encodeInput, encodeInputJson } from "./abi-fmt";
import type { AbiType } from "./contract-idl";

export interface TypedContractInput {
  type: AbiType;
  value: unknown;
}

// Resolve which slot to deploy a contract to, by name — the user never picks a slot.
// Reuse the slot a same-named contract already occupies (upgrade); else the first free slot.
export async function resolveDeploymentSlot(
  rpc: LiteRpc,
  name: string,
  override?: number,
): Promise<{ slot: number; reused: boolean }> {
  if (override !== undefined && !Number.isNaN(override)) {
    return { slot: override, reused: false };
  }
  const reg = await rpc.dynRegistry();
  const cs = reg.contracts ?? [];
  const mine = cs.find((c) => c.armed && c.name === name);
  if (mine) {
    return { slot: mine.index, reused: true };
  }
  const free = cs.find((c) => !c.armed);
  if (free) {
    return { slot: free.index, reused: false };
  }
  throw new Error(`no free dynamic slot (all ${reg.slotCount ?? cs.length} in use)`);
}

// A contract's address = id(contractIndex, 0, 0, 0).
export function contractAddress(contractIndex: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(contractIndex), true);
  return a;
}

// Call a contract function and return the decoded output.
export async function callFunction(
  rpc: LiteRpc,
  contractIndex: number,
  functionId: number,
  input: string | Uint8Array | TypedContractInput,
  outputFormat: string | AbiType,
): Promise<any> {
  const encodedInput = typeof input === "string"
    ? await encodeInput(input)
    : input instanceof Uint8Array
      ? input
      : await encodeInputJson(input.type, input.value);
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
  onProgress?: (i: { tick: number; target: number }) => void; // live network-tick vs target while confirming
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Broadcast a signed tx and, when asked, poll until its target tick has executed. Shared by every
// submission path — a contract procedure and a plain transfer differ only in how the tx was built.
async function broadcastAndConfirm(tx: SignedTx, opts: SubmitOptions): Promise<SubmittedTx> {
  const broadcast = await broadcastTx(tx.bytes, opts.rpcBaseUrl);
  const result = { ...broadcast, txId: tx.id, tick: opts.tick };
  if (!opts.confirm) {
    return result;
  }

  const rpc = opts.rpc ?? new LiteRpc(opts.rpcBaseUrl);
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 30000);
  for (;;) {
    try {
      const status = await rpc.txStatus(opts.tick, tx.id);
      opts.onProgress?.({ tick: status.currentTick ?? 0, target: opts.tick });
      if (status.processed) {
        return {
          ...result,
          confirmed: true,
          included: status.found,
          moneyFlew: status.moneyFlew,
        };
      }
    } catch {
      // addon missing — degrade to a tick-margin wait (node passed the target tick)
      try {
        const tickInfo = await rpc.tickInfo();
        const current = tickInfo.tick ?? 0;
        opts.onProgress?.({ tick: current, target: opts.tick });
        if (current > opts.tick) {
          return { ...result, confirmed: false };
        }
      } catch {}
    }
    if (Date.now() > deadline) {
      return { ...result, confirmed: false };
    }
    await sleep(300);
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
  const tx = await buildSignedTx(opts.seed, {
    destination: opts.destination,
    amount: opts.amount,
    tick: opts.tick,
    inputType: 0,
    payload: new Uint8Array(0),
  });

  return broadcastAndConfirm(tx, opts);
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
  const payload = opts.input instanceof Uint8Array
    ? opts.input
    : opts.input
      ? await encodeInputJson(opts.input.type, opts.input.value)
      : await encodeInput(opts.inputFormat ?? "");
  const tx = await buildSignedTx(opts.seed, {
    destination: contractAddress(opts.contractIndex),
    amount: opts.amount,
    tick: opts.tick,
    inputType: opts.procedureId,
    payload,
  });
  return broadcastAndConfirm(tx, opts);
}
