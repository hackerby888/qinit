// Broadcast a signed tx via the node's built-in RPC: POST /live/v1/broadcast-transaction
// with { encodedTransaction: <base64> }. The endpoint checkValidity + verifies the signature
// server-side, so its response also tells us whether our tx crafting/signing is correct.
export interface BroadcastResult {
  ok: boolean;
  transactionId?: string;
  code?: number;
  message?: string;
}

export async function broadcastTx(txBytes: Uint8Array, rpcBase = "http://127.0.0.1:41841"): Promise<BroadcastResult> {
  const b64 = Buffer.from(txBytes).toString("base64");
  let r: Response;
  try {
    r = await fetch(rpcBase + "/live/v1/broadcast-transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ encodedTransaction: b64 }),
    });
  } catch (e: any) { throw new Error(`node unreachable at ${rpcBase} — is it running? (qinit up)  [${e?.message ?? e}]`); }
  const j: any = await r.json().catch(() => ({}));
  return {
    ok: r.ok && j.peersBroadcasted >= 1 && j.code == null,
    transactionId: j.transactionId,
    code: j.code,
    message: j.message,
  };
}

export async function broadcastTxs(txList: Uint8Array[], rpcBase = "http://127.0.0.1:41841"): Promise<BroadcastResult[]> {
  const out: BroadcastResult[] = [];
  for (const tx of txList) out.push(await broadcastTx(tx, rpcBase));
  return out;
}
