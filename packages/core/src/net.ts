// fetch with a connect/response timeout (AbortController). The timer guards only until the response
// HEADERS arrive (cleared in finally), so a slow/large body STREAM is not killed — only a hung
// connection (node accepts the socket but never replies) is aborted instead of hanging the CLI forever.
export async function fetchT(url: string, init?: RequestInit, ms = 10000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); }
  catch (e: any) { if (ac.signal.aborted) throw new Error(`request timed out after ${ms}ms: ${url}`); throw e; }
  finally { clearTimeout(timer); }
}

// Read a response body fully with an INACTIVITY watchdog: if no chunk arrives for `stallMs`, abort.
// fetchT's timeout only guards until the headers arrive — this guards the body, so a stalled stream
// (slow-loris / dropped mid-download) is killed instead of hanging forever. A slow-but-progressing
// large download is fine (the timer resets on every chunk). onProgress streams bytes for a progress bar.
export async function readBody(r: Response, stallMs = 60000, onProgress?: (recv: number, total: number) => void): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const total = Number(r.headers.get("content-length") ?? 0);
  const reader = r.body.getReader();
  const parts: Uint8Array[] = [];
  let recv = 0, stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; reader.cancel().catch(() => {}); }, stallMs); };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      parts.push(value); recv += value.length; onProgress?.(recv, total);
    }
  } finally { clearTimeout(timer); }
  if (stalled) throw new Error(`download stalled — no data for ${stallMs}ms`);
  const buf = new Uint8Array(recv);
  let off = 0; for (const p of parts) { buf.set(p, off); off += p.length; }
  return buf;
}

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
    r = await fetchT(rpcBase + "/live/v1/broadcast-transaction", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ encodedTransaction: b64 }),
    }, 15000);
  } catch (e: any) { throw new Error(`node unreachable at ${rpcBase} — is it running? (qinit node run)  [${e?.message ?? e}]`); }
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
