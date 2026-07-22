// Fetch with a timeout until response headers arrive; body streaming has its own watchdog.
export async function fetchT(url: string, init?: RequestInit, ms = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e: any) {
    if (controller.signal.aborted) {
      throw new Error(`request timed out after ${ms}ms: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Read a response body with an inactivity watchdog that resets after every chunk.
export async function readBody(
  r: Response,
  stallMs = 60000,
  onProgress?: (recv: number, total: number) => void,
): Promise<Uint8Array> {
  if (!r.body) return new Uint8Array(await r.arrayBuffer());
  const total = Number(r.headers.get("content-length") ?? 0);
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      reader.cancel().catch(() => {});
    }, stallMs);
  };
  try {
    arm();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      arm();
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
  } finally {
    clearTimeout(timer);
  }
  if (stalled) {
    throw new Error(`download stalled — no data for ${stallMs}ms`);
  }
  const body = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

// Broadcast a base64-encoded signed transaction through the node's built-in RPC.
export interface BroadcastResult {
  ok: boolean;
  transactionId?: string;
  code?: number;
  message?: string;
  // In-process engine metadata; moneyFlew is meaningful only when queued is false.
  moneyFlew?: boolean;
  queued?: boolean;
}

export async function broadcastTx(
  txBytes: Uint8Array,
  rpcBase = "http://127.0.0.1:41841",
): Promise<BroadcastResult> {
  const encodedTransaction = Buffer.from(txBytes).toString("base64");
  let response: Response;
  try {
    response = await fetchT(
      rpcBase + "/live/v1/broadcast-transaction",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ encodedTransaction }),
      },
      15000,
    );
  } catch (e: any) {
    throw new Error(
      `node unreachable at ${rpcBase} — is it running? (qinit node run)  [${e?.message ?? e}]`,
    );
  }
  const payload: any = await response.json().catch(() => ({}));
  return {
    ok: response.ok && payload.peersBroadcasted >= 1 && payload.code == null,
    transactionId: payload.transactionId,
    code: payload.code,
    message: payload.message,
  };
}

export async function broadcastTxs(
  txList: Uint8Array[],
  rpcBase = "http://127.0.0.1:41841",
): Promise<BroadcastResult[]> {
  const out: BroadcastResult[] = [];
  for (const tx of txList) {
    out.push(await broadcastTx(tx, rpcBase));
  }
  return out;
}
