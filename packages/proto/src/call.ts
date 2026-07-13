// Contract call/invoke, qubic-cli style, over the built-in RPC.
//   function (read)  -> POST /live/v1/querySmartContract
import { LiteRpc, buildSignedTx, broadcastTx, type BroadcastResult } from "@qinit/core";
import { encodeInput, decodeOutput } from "./abi-fmt";

// Resolve which slot to deploy a contract to, by name — the user never picks a slot.
// Reuse the slot a same-named contract already occupies (upgrade); else the first free slot.
export async function resolveSlot(
  rpc: LiteRpc,
  name: string,
  override?: number,
): Promise<{ slot: number; reused: boolean }> {
  if (override !== undefined && !Number.isNaN(override)) return { slot: override, reused: false };
  const reg = await rpc.dynRegistry();
  const cs = reg.contracts ?? [];
  const mine = cs.find((c) => c.armed && c.name === name);
  if (mine) return { slot: mine.index, reused: true };
  const free = cs.find((c) => !c.armed);
  if (free) return { slot: free.index, reused: false };
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
  fnId: number,
  inFmt: string,
  outFmt: string,
): Promise<any> {
  const out = await rpc.querySmartContract(contractIndex, fnId, await encodeInput(inFmt));
  return await decodeOutput(out, outFmt);
}

// Invoke a contract procedure (signed tx). tick must be a near-future, accepted tick.
// confirm: poll the tx-status RPC until the tx is processed (Anchor .rpc()-style) — exact
export async function invokeProcedure(opts: {
  seed: string;
  rpcBase: string;
  contractIndex: number;
  procId: number;
  amount: number;
  inFmt: string;
  tick: number;
  confirm?: boolean;
  rpc?: LiteRpc;
  confirmTimeoutMs?: number;
  onProgress?: (i: { tick: number; target: number }) => void; // live network-tick vs target while confirming
}): Promise<
  BroadcastResult & {
    txId?: string;
    tick?: number;
    confirmed?: boolean;
    included?: boolean;
    moneyFlew?: boolean;
  }
> {
  const tx = await buildSignedTx(opts.seed, {
    destination: contractAddress(opts.contractIndex),
    amount: opts.amount,
    tick: opts.tick,
    inputType: opts.procId,
    payload: await encodeInput(opts.inFmt),
  });
  const r = await broadcastTx(tx.bytes, opts.rpcBase);
  const res = { ...r, txId: tx.id, tick: opts.tick };
  if (!opts.confirm) return res;
  const rpc = opts.rpc ?? new LiteRpc(opts.rpcBase);
  const deadline = Date.now() + (opts.confirmTimeoutMs ?? 30000);
  const sleep = (ms: number) => new Promise((s) => setTimeout(s, ms));
  for (;;) {
    try {
      const st = await rpc.txStatus(opts.tick, tx.id);
      opts.onProgress?.({ tick: st.currentTick ?? 0, target: opts.tick });
      if (st.processed)
        return { ...res, confirmed: true, included: st.found, moneyFlew: st.moneyFlew };
    } catch {
      // addon missing — degrade to a tick-margin wait (node passed the target tick)
      try {
        const ti = await rpc.tickInfo();
        const cur = ti.tick ?? 0;
        opts.onProgress?.({ tick: cur, target: opts.tick });
        if (cur > opts.tick) return { ...res, confirmed: false };
      } catch {}
    }
    if (Date.now() > deadline) return { ...res, confirmed: false };
    await sleep(300);
  }
}
