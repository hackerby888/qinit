// HTTP adapter — serves an VirtualNode on the qubic-core-lite node's RPC routes (Bun.serve). This is how
// TS engine is a drop-in node: deploy-ops and spawned `bun test` runtime both use HTTP.
import { VirtualNode } from "./transport";
import { initK12 } from "@qinit/core";
import { PeerServer } from "./peer-server";

export interface EngineServerHandle {
  rpcBase: string;
  peerPort?: number;
  stop: () => void;
}

export class EngineServer {
  readonly engine: VirtualNode;
  private server: ReturnType<typeof Bun.serve> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private peer: PeerServer | null = null;
  private tickMs = 50;

  constructor(engine: VirtualNode = new VirtualNode()) {
    this.engine = engine;
  }

  // (Re)start the auto-ticker at `ms` between ticks — also the chain clock step (sim.tickDuration). Clamped to
  // >= 0 (0 = as fast as the event loop allows).
  private applyTickMs(ms: number): number {
    this.tickMs = Math.max(0, Number.isFinite(ms) ? ms : this.tickMs);
    this.engine.sim.tickDuration = this.tickMs;
    if (this.ticker) {
      clearInterval(this.ticker);
    }
    this.ticker = setInterval(() => this.engine.advanceTick(1), this.tickMs);
    return this.tickMs;
  }

  // Change the tick interval on a RUNNING node — no respawn (the /live/v1/dev/tick-ms route backs `qinit tick rate`).
  setTickMs(ms: number): number {
    return this.applyTickMs(ms);
  }

  // Serve on an ephemeral port (0) by default; auto-advances ticks so deploy's "is it ticking?" polls pass.
  async start(port = 0, tickMs = 50, peerPort?: number): Promise<EngineServerHandle> {
    await initK12(); // the engine's digest / codeHash / lh_k12 need the crypto module resolved
    const eng = this.engine;
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

    await eng.seedFaucet(); // pre-fund the funded-seed account so regular txs have balance

    this.applyTickMs(tickMs); // start the auto-ticker (live-adjustable via setTickMs)

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
          if (path === "/live/v1/dev/tick-ms") return json({ tickMs: this.setTickMs(Number(q.get("ms"))) });
          if (path === "/live/v1/dev/debug") return json(await eng.setDebug(q.get("on") === "1"));
          if (path === "/live/v1/debug-trace") return json(await eng.debugTrace());
          if (path === "/live/v1/dev/oracle-pending") {
            const qs = await eng.oraclePending();
            return json({ queries: qs.map((qq) => ({ queryId: qq.queryId.toString(), slot: qq.slot, interfaceIndex: qq.interfaceIndex, query: Buffer.from(qq.query).toString("base64") })) });
          }
          if (path === "/live/v1/dev/oracle-resolve" && req.method === "POST") {
            const body = (await req.json()) as { queryId: string; reply?: string; status?: number };
            return json(await eng.oracleResolve(BigInt(body.queryId), new Uint8Array(Buffer.from(body.reply ?? "", "base64")), body.status));
          }
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
          // Single-authority direct deploy: drop wasm straight into a slot (no chunk-upload / consensus). Used by
          // `qinit system add` (seed a system contract) and the virtual fast path in deploy-ops.
          if (path === "/live/v1/dev/deploy" && req.method === "POST") {
            const body = (await req.json()) as { slot: number; wasm?: string; name?: string };
            const wasm = Uint8Array.from(Buffer.from(body.wasm ?? "", "base64"));
            eng.deploy(Number(body.slot), wasm, body.name || "Contract");
            return json({ ok: true, slot: Number(body.slot), digest: eng.sim.digest(Number(body.slot)) });
          }
          if (path === "/live/v1/dev/undeploy" && req.method === "POST") {
            return json({ ok: eng.undeploy(Number(q.get("slot"))) });
          }
          return json({ code: 404, message: "no engine route: " + path }, 404);
        } catch (e: any) {
          return json({ code: 500, message: String(e?.message ?? e) }, 500);
        }
      },
    });
    this.server = server;
    let boundPeerPort: number | undefined;
    if (peerPort !== undefined) {
      this.peer = new PeerServer(this.engine);
      boundPeerPort = (await this.peer.start(peerPort, tickMs, false)).port;
    }
    return { rpcBase: `http://127.0.0.1:${server.port}`, peerPort: boundPeerPort, stop: () => this.stop() };
  }

  stop(): void {
    if (this.peer) {
      this.peer.stop();
      this.peer = null;
    }
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
