import { initK12 } from "@qinit/core";
import { VirtualNode } from "./transport";
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

  private applyTickMs(ms: number): number {
    this.tickMs = Math.max(0, Number.isFinite(ms) ? ms : this.tickMs);
    this.engine.sim.tickDuration = this.tickMs;

    if (this.ticker) {
      clearInterval(this.ticker);
    }

    this.ticker = setInterval(() => this.engine.advanceTick(1), this.tickMs);
    return this.tickMs;
  }

  setTickMs(ms: number): number {
    return this.applyTickMs(ms);
  }

  async start(
    port = 0,
    tickMs = 50,
    peerPort?: number,
  ): Promise<EngineServerHandle> {
    await initK12();

    const engine = this.engine;
    const json = (data: unknown, status = 200): Response =>
      new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
      });

    await engine.seedFaucet();
    this.applyTickMs(tickMs);

    const server = Bun.serve({
      port,
      idleTimeout: 60,
      fetch: async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const path = url.pathname;
        const query = url.searchParams;

        try {
          if (
            path === "/tick-info" ||
            path === "/latest-created-tick-info"
          ) {
            return json(await engine.tickInfo());
          }

          if (path === "/live/v1/dyn-registry") {
            return json(await engine.dynRegistry());
          }

          if (path === "/live/v1/dyn-upload") {
            return json(await engine.dynUpload());
          }

          if (path === "/live/v1/dev/funded-seed") {
            return json({ seed: await engine.fundedSeed() });
          }

          if (path === "/live/v1/dev/funded-seeds") {
            return json(
              await engine.fundedSeeds(
                Number(query.get("limit") ?? 32),
              ),
            );
          }

          if (path === "/live/v1/dev/epoch-info") {
            return json(engine.epochInfo());
          }

          if (path === "/live/v1/dev/advance-tick") {
            return json(
              engine.advanceTickN(Number(query.get("n") ?? 1)),
            );
          }

          if (path === "/live/v1/dev/advance-to-last") {
            return json(
              engine.advanceToLast(
                Number(query.get("gap") ?? 3),
              ),
            );
          }

          if (path === "/live/v1/dev/advance-epoch") {
            return json(engine.advanceEpoch());
          }

          if (path === "/live/v1/dev/tick-ms") {
            return json({
              tickMs: this.setTickMs(Number(query.get("ms"))),
            });
          }

          if (path === "/live/v1/dev/debug") {
            return json(
              await engine.setDebug(query.get("on") === "1"),
            );
          }

          if (path === "/live/v1/debug-trace") {
            return json(await engine.debugTrace());
          }

          if (path === "/live/v1/dev/oracle-pending") {
            const pendingQueries = await engine.oraclePending();

            return json({
              queries: pendingQueries.map((pending) => ({
                queryId: pending.queryId.toString(),
                slot: pending.slot,
                interfaceIndex: pending.interfaceIndex,
                query: Buffer.from(pending.query).toString("base64"),
              })),
            });
          }

          if (
            path === "/live/v1/dev/oracle-resolve" &&
            request.method === "POST"
          ) {
            const body = (await request.json()) as {
              queryId: string;
              reply?: string;
              status?: number;
            };

            return json(
              await engine.oracleResolve(
                BigInt(body.queryId),
                new Uint8Array(
                  Buffer.from(body.reply ?? "", "base64"),
                ),
                body.status,
              ),
            );
          }

          if (path === "/live/v1/dev/state-read") {
            return json(
              await engine.stateRead(
                Number(query.get("slot")),
                Number(query.get("off") ?? 0),
                Number(query.get("len") ?? 0),
              ),
            );
          }

          if (path === "/live/v1/dev/contract-digest") {
            const slot = Number(query.get("slot"));
            const contract = engine.sim.contracts.get(slot);

            if (!contract) {
              throw new Error(`no contract at slot ${slot}`);
            }

            return json({
              slot,
              stateSize: contract.stateSize,
              digest: engine.sim.digest(slot),
            });
          }

          if (path.startsWith("/live/v1/balances/")) {
            return json({
              balance: await engine.balance(
                decodeURIComponent(path.slice("/live/v1/balances/".length)),
              ),
            });
          }

          if (
            path === "/query/v1/getTransactionsForTick" &&
            request.method === "POST"
          ) {
            const body = (await request.json()) as {
              tickNumber?: number;
              tick?: number;
            };

            return json({
              transactions: await engine.tickTransactions(
                Number(body.tickNumber ?? body.tick ?? 0),
              ),
            });
          }

          if (path.startsWith("/live/v1/tx-status/")) {
            const parts = path.split("/");

            return json(
              await engine.txStatus(
                Number(parts[4]),
                parts[5] ?? "",
              ),
            );
          }

          if (
            path === "/live/v1/broadcast-transaction" &&
            request.method === "POST"
          ) {
            const body = (await request.json()) as {
              encodedTransaction?: string;
            };
            const bytes = Uint8Array.from(
              Buffer.from(
                body.encodedTransaction ?? "",
                "base64",
              ),
            );
            const result = await engine.broadcastTx(bytes);

            return json({
              ok: result.ok,
              peersBroadcasted: result.ok ? 1 : 0,
              transactionId: result.transactionId,
              code: result.ok ? undefined : 1,
              message: result.message,
            });
          }
          if (
            path === "/live/v1/querySmartContract" &&
            request.method === "POST"
          ) {
            const body = (await request.json()) as {
              contractIndex: number;
              inputType: number;
              requestData?: string;
            };
            const input = Uint8Array.from(
              Buffer.from(body.requestData ?? "", "base64"),
            );
            const output = await engine.querySmartContract(
              Number(body.contractIndex),
              Number(body.inputType),
              input,
            );

            return json({
              responseData: Buffer.from(output).toString("base64"),
            });
          }

          if (
            path === "/live/v1/dev/contract-source" &&
            request.method === "POST"
          ) {
            await engine.putContractSource(
              Number(query.get("slot")),
              await request.text(),
            );

            return json({ ok: true });
          }

          if (
            path === "/live/v1/dev/deploy" &&
            request.method === "POST"
          ) {
            const body = (await request.json()) as {
              slot: number;
              wasm?: string;
              name?: string;
            };
            const slot = Number(body.slot);
            const wasm = Uint8Array.from(
              Buffer.from(body.wasm ?? "", "base64"),
            );

            engine.deploy(slot, wasm, body.name || "Contract");

            return json({
              ok: true,
              slot,
              digest: engine.sim.digest(slot),
            });
          }

          if (
            path === "/live/v1/dev/undeploy" &&
            request.method === "POST"
          ) {
            return json({
              ok: engine.undeploy(Number(query.get("slot"))),
            });
          }

          return json({ code: 404, message: "no engine route: " + path }, 404);
        } catch (error) {
          const message = String(
            (error as Error)?.message ?? error,
          );

          return json({ code: 500, message }, 500);
        }
      },
    });

    this.server = server;
    let boundPeerPort: number | undefined;

    if (peerPort !== undefined) {
      this.peer = new PeerServer(this.engine);
      boundPeerPort = (await this.peer.start(peerPort, tickMs, false)).port;
    }

    return {
      rpcBase: `http://127.0.0.1:${server.port}`,
      peerPort: boundPeerPort,
      stop: () => this.stop(),
    };
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
