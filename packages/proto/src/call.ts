// Contract call/invoke, qubic-cli style, over the built-in RPC.
//   function (read)  -> POST /live/v1/querySmartContract
//   procedure (write)-> signed tx to the contract address, POST /live/v1/broadcast-transaction
import { LiteRpc, buildSignedTx, broadcastTx, type BroadcastResult } from "@qinit/core";
import { encodeInput, decodeOutput } from "./abi-fmt";

// A contract's address = id(contractIndex, 0, 0, 0).
export function contractAddress(contractIndex: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(contractIndex), true);
  return a;
}

// Call a contract function and return the decoded output.
export async function callFunction(
  rpc: LiteRpc, contractIndex: number, fnId: number, inFmt: string, outFmt: string,
): Promise<any> {
  const out = await rpc.querySmartContract(contractIndex, fnId, await encodeInput(inFmt));
  return await decodeOutput(out, outFmt);
}

// Invoke a contract procedure (signed tx). tick must be a near-future, accepted tick.
export async function invokeProcedure(opts: {
  seed: string; rpcBase: string; contractIndex: number; procId: number;
  amount: number; inFmt: string; tick: number;
}): Promise<BroadcastResult & { txId?: string }> {
  const tx = await buildSignedTx(opts.seed, {
    destination: contractAddress(opts.contractIndex),
    amount: opts.amount,
    tick: opts.tick,
    inputType: opts.procId,
    payload: await encodeInput(opts.inFmt),
  });
  const r = await broadcastTx(tx.bytes, opts.rpcBase);
  return { ...r, txId: tx.id };
}
