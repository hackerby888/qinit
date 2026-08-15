import { LOOPBACK_HOST, initK12, type DirectDeploymentKind } from "@qinit/core";
import { VirtualNode } from "./transport";
import { PeerServer } from "./peer-server";
import { EngineFaultedError } from "./qubic-simulator";
import { NodeTicker } from "./support/node-ticker";

export interface EngineServerHandle {
    rpcBaseUrl: string;
    peerPort?: number;
    stop: () => void;
}

const json = (data: unknown, status = 200): Response =>
    new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });

export class EngineServer {
    readonly engine: VirtualNode;
    private server: ReturnType<typeof Bun.serve> | null = null;
    private readonly ticker: NodeTicker;
    private peer: PeerServer | null = null;
    private tickMs = 50;

    constructor(engine: VirtualNode = new VirtualNode()) {
        this.engine = engine;
        this.ticker = new NodeTicker(engine, "engine");
    }

    private applyTickMs(ms: number): number {
        this.engine.sim.assertOperational();
        this.tickMs = Math.max(0, Number.isFinite(ms) ? ms : this.tickMs);
        this.engine.sim.tickDuration = this.tickMs;
        this.ticker.start(this.tickMs);
        return this.tickMs;
    }

    setTickMs(ms: number): number {
        return this.applyTickMs(ms);
    }

    // HTTP: tick info, identity, registry, and upload status. Answers null when the path is not one of its own.
    private async nodeStatusRoutes(_request: Request, url: URL): Promise<Response | null> {
        const engine = this.engine;
        const path = url.pathname;

        if (path === "/tick-info" || path === "/latest-created-tick-info") {
            return json(await engine.tickInfo());
        }

        if (path === "/live/v1/whoami") {
            return json({ backend: "simulator" });
        }

        if (path === "/live/v1/dev/fault") {
            return json(await engine.faultInfo());
        }

        if (path === "/live/v1/dyn-registry") {
            return json(await engine.dynRegistry());
        }

        if (path === "/live/v1/dyn-upload") {
            engine.sim.assertOperational();
            return json(await engine.dynUpload());
        }

        return null;
    }

    // HTTP: the dev-only chain controls: seeds, epoch and tick advancement, debug capture. Answers null when the path is not one of its own.
    private async devControlRoutes(request: Request, url: URL): Promise<Response | null> {
        const engine = this.engine;
        const path = url.pathname;
        const query = url.searchParams;

        if (path === "/live/v1/dev/funded-seed") {
            engine.sim.assertOperational();
            return json({ seed: await engine.fundedSeed() });
        }

        if (path === "/live/v1/dev/funded-seeds") {
            engine.sim.assertOperational();
            return json(await engine.fundedSeeds(Number(query.get("limit") ?? 32)));
        }

        if (path === "/live/v1/dev/epoch-info") {
            return json(engine.epochInfo());
        }

        if (path === "/live/v1/dev/advance-tick") {
            return json(engine.advanceTickN(Number(query.get("n") ?? 1)));
        }

        if (path === "/live/v1/dev/advance-to-last") {
            return json(engine.advanceToLast(Number(query.get("gap") ?? 3)));
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
            return json(await engine.setDebug(query.get("on") === "1"));
        }

        if (path === "/live/v1/debug-trace") {
            const sinceSeq = Number(query.get("since")) || 0;
            const entryLimit = Number(query.get("limit") ?? 64);

            return json(await engine.debugTrace(sinceSeq, entryLimit));
        }

        if (path === "/live/v1/dev/oracle-pending") {
            engine.sim.assertOperational();
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

        if (path === "/live/v1/dev/oracle-resolve" && request.method === "POST") {
            const body = (await request.json()) as {
                queryId: string;
                reply?: string;
                status?: number;
            };

            return json(await engine.oracleResolve(BigInt(body.queryId), new Uint8Array(Buffer.from(body.reply ?? "", "base64")), body.status));
        }

        if (path === "/live/v1/dev/state-read") {
            return json(await engine.stateRead(Number(query.get("slot")), Number(query.get("off") ?? 0), Number(query.get("len") ?? 0)));
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

        return null;
    }

    // HTTP: balances and the explorer/query read models. Answers null when the path is not one of its own.
    private async explorerRoutes(request: Request, url: URL): Promise<Response | null> {
        const engine = this.engine;
        const path = url.pathname;

        if (path.startsWith("/live/v1/balances/")) {
            engine.sim.assertOperational();
            return json({
                balance: await engine.balance(decodeURIComponent(path.slice("/live/v1/balances/".length))),
            });
        }

        if (path === "/query/v1/getTransactionsForTick" && request.method === "POST") {
            const body = (await request.json()) as {
                tickNumber?: number;
                tick?: number;
            };

            return json({
                transactions: await engine.explorerTickTransactions(Number(body.tickNumber ?? body.tick ?? 0)),
            });
        }

        // ---- Explorer routes, mirroring core-lite's shapes so one client works against both backends.

        if (path === "/explorer/data") {
            engine.sim.assertOperational();
            return json(await engine.explorerData());
        }

        if (path === "/query/v1/getTickData" && request.method === "POST") {
            const body = (await request.json()) as { tickNumber?: number };
            const tickData = await engine.explorerTickData(Number(body.tickNumber ?? 0));

            return tickData ? json(tickData) : json({ code: 404, message: "Tick data not found" }, 404);
        }

        if (path === "/query/v1/getTransactionByHash" && request.method === "POST") {
            const body = (await request.json()) as { hash?: string };
            const transaction = await engine.explorerTxByHash(body.hash ?? "");

            return transaction ? json(transaction) : json({ code: 404, message: "Transaction not found" }, 404);
        }

        if (path === "/query/v1/getTransfersForIdentity" && request.method === "POST") {
            const body = (await request.json()) as {
                identity?: string;
                direction?: "in" | "out" | "both";
                limit?: number;
            };

            return json(await engine.explorerTransfersForIdentity(body.identity ?? "", body.direction ?? "both", Number(body.limit ?? 50)));
        }

        if (path === "/query/v1/getContractCalls" && request.method === "POST") {
            const body = (await request.json()) as {
                fromTick?: number;
                toTick?: number;
                contractIndex?: number;
                page?: number;
                pageSize?: number;
            };

            return json(
                await engine.explorerContractCalls({
                    fromTick: Number(body.fromTick ?? 0),
                    toTick: Number(body.toTick ?? engine.sim.currentTick),
                    contractIndex: body.contractIndex,
                    page: body.page,
                    pageSize: body.pageSize,
                }),
            );
        }

        if (path === "/query/v1/getContracts") {
            return json(await engine.explorerContracts());
        }

        return null;
    }

    // HTTP: transaction status, broadcast, contract queries, and deployment. Answers null when the path is not one of its own.
    private async chainWriteRoutes(request: Request, url: URL): Promise<Response | null> {
        const engine = this.engine;
        const path = url.pathname;
        const query = url.searchParams;

        if (path.startsWith("/live/v1/tx-status/")) {
            const parts = path.split("/");

            return json(await engine.txStatus(Number(parts[4]), parts[5] ?? ""));
        }

        if (path === "/live/v1/broadcast-transaction" && request.method === "POST") {
            const body = (await request.json()) as {
                encodedTransaction?: string;
            };
            const bytes = Uint8Array.from(Buffer.from(body.encodedTransaction ?? "", "base64"));
            const result = await engine.broadcastTx(bytes);

            return json({
                ok: result.ok,
                peersBroadcasted: result.ok ? 1 : 0,
                transactionId: result.transactionId,
                code: result.ok ? undefined : 1,
                message: result.message,
            });
        }
        if (path === "/live/v1/querySmartContract" && request.method === "POST") {
            engine.sim.assertOperational();
            const body = (await request.json()) as {
                contractIndex: number;
                inputType: number;
                requestData?: string;
            };
            const input = Uint8Array.from(Buffer.from(body.requestData ?? "", "base64"));
            const output = await engine.querySmartContract(Number(body.contractIndex), Number(body.inputType), input);

            return json({
                responseData: Buffer.from(output).toString("base64"),
            });
        }

        if (path === "/live/v1/dev/contract-source" && request.method === "POST") {
            await engine.putContractSource(Number(query.get("slot")), await request.text());

            return json({ ok: true });
        }

        if (path === "/live/v1/dev/deploy" && request.method === "POST") {
            const body = (await request.json()) as {
                slot: number;
                wasm?: string;
                name?: string;
                kind?: DirectDeploymentKind;
            };
            const slot = Number(body.slot);
            const name = body.name || "Contract";
            const kind = body.kind ?? "dynamic";
            const dynamicEnd = engine.slotBase + engine.slotCount;
            const validDynamicSlot = Number.isInteger(slot) && slot >= engine.slotBase && slot < dynamicEnd;
            const validSystemSlot = Number.isInteger(slot) && slot >= 1 && slot < engine.slotBase;

            if (kind !== "dynamic" && kind !== "system") {
                return json(
                    {
                        ok: false,
                        message: `unknown deployment kind '${String(kind)}'`,
                    },
                    400,
                );
            }
            if (kind === "dynamic" && !validDynamicSlot) {
                return json(
                    {
                        ok: false,
                        message: `dynamic slot ${slot} is outside ${engine.slotBase}..${dynamicEnd - 1}`,
                    },
                    400,
                );
            }
            if (kind === "system" && !validSystemSlot) {
                return json(
                    {
                        ok: false,
                        message: `system slot ${slot} is outside 1..${engine.slotBase - 1}`,
                    },
                    400,
                );
            }

            const deployed = (await engine.dynRegistry()).contracts.find((contract) => contract.index === slot && contract.armed);
            if (engine.sim.contracts.has(slot) && deployed?.name !== name) {
                return json(
                    {
                        ok: false,
                        message: `slot ${slot} is occupied by '${deployed?.name ?? "unknown"}'`,
                    },
                    409,
                );
            }

            const wasm = Uint8Array.from(Buffer.from(body.wasm ?? "", "base64"));

            engine.deploy(slot, wasm, name);

            return json({
                ok: true,
                slot,
                digest: engine.sim.digest(slot),
            });
        }

        if (path === "/live/v1/dev/undeploy" && request.method === "POST") {
            return json({
                ok: engine.undeploy(Number(query.get("slot"))),
            });
        }

        return null;
    }

    private get routeGroups(): ((request: Request, url: URL) => Promise<Response | null>)[] {
        return [
            (request, url) => this.nodeStatusRoutes(request, url),
            (request, url) => this.devControlRoutes(request, url),
            (request, url) => this.explorerRoutes(request, url),
            (request, url) => this.chainWriteRoutes(request, url),
        ];
    }

    async start(port = 0, tickMs = 50, peerPort?: number): Promise<EngineServerHandle> {
        await initK12();

        // A node records from boot: a debugger attached later still finds the calls that already ran. The
        // ring is bounded, and `setDebug(false)` over RPC remains for anyone who wants the cycles back.
        this.engine.setDebug(true);

        const engine = this.engine;

        await engine.seedFaucet();
        if (engine.sim.currentEpoch === 0 && engine.sim.currentTick === 0 && engine.sim.contracts.size === 0) {
            engine.sim.bootstrapEpoch(1);
        }

        const server = Bun.serve({
            port,
            idleTimeout: 60,
            fetch: async (request: Request): Promise<Response> => {
                const url = new URL(request.url);
                const path = url.pathname;

                try {
                    for (const route of this.routeGroups) {
                        const response = await route(request, url);
                        if (response) {
                            return response;
                        }
                    }

                    return json({ code: 404, message: "no engine route: " + path }, 404);
                } catch (error) {
                    const message = String((error as Error)?.message ?? error);
                    const status = error instanceof EngineFaultedError ? 503 : 500;

                    if (status === 503) {
                        this.ticker.stop();
                    }

                    return json({ code: status, message }, status);
                }
            },
        });

        this.server = server;
        let boundPeerPort: number | undefined;

        if (peerPort !== undefined) {
            this.peer = new PeerServer(this.engine);
            boundPeerPort = (await this.peer.start(peerPort, tickMs, false)).port;
        }

        this.applyTickMs(tickMs);

        return {
            rpcBaseUrl: `http://${LOOPBACK_HOST}:${server.port}`,
            peerPort: boundPeerPort,
            stop: () => this.stop(),
        };
    }

    stop(): void {
        if (this.peer) {
            this.peer.stop();
            this.peer = null;
        }

        this.ticker.stop();

        if (this.server) {
            this.server.stop(true);
            this.server = null;
        }
    }
}
