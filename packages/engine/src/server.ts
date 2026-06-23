// HTTP adapter — serves an InProcessEngine on the qubic-core-lite node's RPC routes (Bun.serve). This is how
// the TS engine becomes a drop-in node: qinit's deploy-ops AND the spawned `bun test` runtime both talk HTTP,
// so pointing QINIT_RPC at this server runs the whole flow against the engine with no node binary. Bun-only
// (start() touches Bun.serve); importing the class is browser-safe since nothing runs until start().
import { InProcessEngine } from "./transport";
import { initK12 } from "@qinit/core";

export interface EngineServerHandle {
  rpcBase: string;
  stop: () => void;
}

export class EngineServer {
  readonly engine: InProcessEngine;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(engine: InProcessEngine = new InProcessEngine()) {
    this.engine = engine;
  }

  // Serve on an ephemeral port (0) by default; auto-advances ticks so deploy's "is it ticking?" polls pass.
  async start(port = 0, tickMs = 50): Promise<EngineServerHandle> {
    await initK12(); // the engine's digest / codeHash / lh_k12 need the crypto module resolved
    const eng = this.engine;
    eng.sim.tickDuration = tickMs;
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    await eng.seedFaucet(); // pre-fund the funded-seed account so regular txs have balance

    this.ticker = setInterval(() => {
      eng.advanceTick(1);
    }, tickMs);

    const server = Bun.serve({
      port,
      idleTimeout: 60,
      fetch: async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname;
        const q = url.searchParams;
        try {
          if (path === "/tick-info" || path === "/latest-created-tick-info") return json(await eng.tickInfo());
          if (path === "/live/v1/dyn-registry") return json(await eng.dynRegistry());
          if (path === "/live/v1/dyn-upload") return json(await eng.dynUpload());
          if (path === "/live/v1/dev/funded-seed") return json({ seed: await eng.fundedSeed() });
          if (path === "/live/v1/dev/funded-seeds") return json(await eng.fundedSeeds(Number(q.get("limit") ?? 32)));
          if (path === "/live/v1/dev/epoch-info") return json(eng.epochInfo());
          if (path === "/live/v1/dev/advance-tick") return json(eng.advanceTickN(Number(q.get("n") ?? 1)));
          if (path === "/live/v1/dev/advance-to-last") return json(eng.advanceToLast(Number(q.get("gap") ?? 3)));
          if (path === "/live/v1/dev/advance-epoch") return json(eng.advanceEpoch());
          if (path === "/live/v1/dev/debug") return json(await eng.setDebug(q.get("on") === "1"));
          if (path === "/live/v1/debug-trace") return json(await eng.debugTrace());
          if (path === "/live/v1/dev/state-read") {
            return json(await eng.stateRead(Number(q.get("slot")), Number(q.get("off") ?? 0), Number(q.get("len") ?? 0)));
          }
          if (path === "/live/v1/dev/contract-digest") {
            return json({ digest: eng.sim.digest(Number(q.get("slot"))) });
          }
          if (path.startsWith("/live/v1/balances/")) {
            return json({ balance: await eng.balance(decodeURIComponent(path.slice("/live/v1/balances/".length))) });
          }
          if (path === "/query/v1/getTransactionsForTick" && req.method === "POST") {
            const body = (await req.json()) as { tickNumber?: number; tick?: number };
            return json({ transactions: await eng.tickTransactions(Number(body.tickNumber ?? body.tick ?? 0)) });
          }
          if (path.startsWith("/live/v1/tx-status/")) {
            const parts = path.split("/"); // ["", "live", "v1", "tx-status", tick, txId]
            return json(await eng.txStatus(Number(parts[4]), parts[5] ?? ""));
          }
          if (path === "/live/v1/broadcast-transaction" && req.method === "POST") {
            const body = (await req.json()) as { encodedTransaction?: string };
            const bytes = Uint8Array.from(Buffer.from(body.encodedTransaction ?? "", "base64"));
            const r = await eng.broadcastTx(bytes);
            return json({ ok: r.ok, peersBroadcasted: r.ok ? 1 : 0, transactionId: r.transactionId, code: r.ok ? undefined : 1, message: r.message });
          }
          if (path === "/live/v1/querySmartContract" && req.method === "POST") {
            const body = (await req.json()) as { contractIndex: number; inputType: number; requestData?: string };
            const input = Uint8Array.from(Buffer.from(body.requestData ?? "", "base64"));
            const out = await eng.querySmartContract(Number(body.contractIndex), Number(body.inputType), input);
            return json({ responseData: Buffer.from(out).toString("base64") });
          }
          if (path === "/live/v1/dev/contract-source" && req.method === "POST") {
            await eng.putContractSource(Number(q.get("slot")), await req.text());
            return json({ ok: true });
          }
          return json({ code: 404, message: "no engine route: " + path }, 404);
        } catch (e: any) {
          return json({ code: 500, message: String(e?.message ?? e) }, 500);
        }
      },
    });
    this.server = server;
    return { rpcBase: `http://127.0.0.1:${server.port}`, stop: () => this.stop() };
  }

  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    if (this.server) {
      this.server.stop(true);
      this.server = null;
    }
  }
}
