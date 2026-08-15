// Qubic peer-protocol TCP server backed by an in-process VirtualNode.
// Lets external clients communicate with the simulation over TCP.
import { VirtualNode } from "./transport";
import { initK12, toHex } from "./support/k12";
import { DEFAULT_PEER_PORT, LOOPBACK_HOST } from "@qinit/core";
import * as codec from "./protocol/peer-codec";
import { MSG } from "./protocol/peer-codec";
import { concatBytes } from "./support/bytes";
import { unpackAssetName } from "./ledger/assets";

interface PeerConnectionState {
    buf: Uint8Array;
}

export interface PeerServerHandle {
    port: number;
    tickMs: number;
    stop: () => void;
}

export class PeerServer {
    readonly engine: VirtualNode;
    private server: { stop(closeActiveConnections?: boolean): void; readonly port: number } | null = null;
    private ticker: ReturnType<typeof setInterval> | null = null;

    constructor(engine: VirtualNode = new VirtualNode()) {
        this.engine = engine;
    }

    private stopTicker(): void {
        if (this.ticker) {
            clearInterval(this.ticker);
            this.ticker = null;
        }
    }

    private advanceTick(count = 1): void {
        try {
            this.engine.advanceTick(count);
        } catch (error) {
            this.stopTicker();

            if (!this.engine.sim.isFaulted()) {
                console.error("peer ticker stopped:", error);
            }
        }
    }

    async start(port = DEFAULT_PEER_PORT, tickMs = 50, autoTick = true): Promise<PeerServerHandle> {
        await initK12();
        await this.engine.seedFaucet();
        this.engine.sim.tickDuration = tickMs;

        if (autoTick && this.engine.sim.currentEpoch === 0 && this.engine.sim.currentTick === 0 && this.engine.sim.contracts.size === 0) {
            this.engine.sim.bootstrapEpoch(1);
        }

        const self = this;
        const server = Bun.listen<PeerConnectionState>({
            hostname: LOOPBACK_HOST,
            port,
            socket: {
                open(socket) {
                    socket.data = { buf: new Uint8Array(0) };
                    socket.write(codec.exchangePublicPeers());
                },
                data(socket, chunk) {
                    void self.onData(socket, chunk);
                },
            },
        });
        this.server = server;

        if (autoTick) {
            this.advanceTick(5);
            if (!this.engine.sim.isFaulted()) {
                this.ticker = setInterval(() => this.advanceTick(), tickMs);
            }
        }

        return { port: server.port, tickMs, stop: () => this.stop() };
    }

    stop(): void {
        this.stopTicker();
        if (this.server) {
            this.server.stop(true);
            this.server = null;
        }
    }

    // Reassemble the TCP stream into complete [header|payload] frames and dispatch each. Leftover bytes (a partial
    // frame) are retained for the next chunk.
    private async onData(
        socket: {
            data: PeerConnectionState;
            write: (bytes: Uint8Array) => void;
            end: () => void;
        },
        chunk: Uint8Array<ArrayBufferLike>,
    ): Promise<void> {
        let buf = concatBytes([socket.data.buf, new Uint8Array(chunk)]);

        while (true) {
            const header = codec.readHeader(buf);
            if (!header) {
                break;
            }
            if (header.size < codec.HEADER_SIZE || header.size > 0xffffff) {
                socket.end();
                buf = new Uint8Array(0);
                break;
            }
            if (buf.length < header.size) break;

            const payload = buf.subarray(codec.HEADER_SIZE, header.size);
            try {
                if (process.env.QINIT_PEER_DEBUG) {
                    const req = `type=${header.type} size=${header.size} dejavu=${header.dejavu}`;
                    console.error(`peer request ${req}`);
                }
                const resp = await this.dispatch(header.type, payload, header.dejavu);
                if (resp) {
                    if (process.env.QINIT_PEER_DEBUG) {
                        const kind = codec.readHeader(resp)?.type;
                        console.error(`peer response type=${kind} size=${resp.length}`);
                    }
                    socket.write(resp);
                }
            } catch (e) {
                // A malformed request must not kill the connection — drop it and keep serving. The
                // failure is still reported, because this also catches bugs in the respond* handlers,
                // and swallowing those silently leaves the peer waiting for a response that never comes.
                const reason = String((e as Error)?.message ?? e);
                console.error(`peer request type=${header.type} failed: ${reason}`);
            }

            buf = buf.subarray(header.size);
        }

        socket.data.buf = buf.slice();
    }

    private async dispatch(type: number, payload: Uint8Array, dejavu: number): Promise<Uint8Array | null> {
        if (this.engine.sim.isFaulted()) {
            switch (type) {
                case MSG.REQUEST_CURRENT_TICK_INFO:
                case MSG.REQUEST_LOG:
                case MSG.REQUEST_LOG_ID_RANGE_FROM_TX:
                case MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX:
                case MSG.REQUEST_LOG_STATE_DIGEST:
                case MSG.REQUEST_TX_STATUS:
                case MSG.REQUEST_TICK_TRANSACTIONS:
                case MSG.REQUEST_TICK_DATA:
                case MSG.REQUEST_TRANSACTION_INFO:
                case MSG.REQUEST_QUORUM_TICK:
                    break;
                case MSG.BROADCAST_TRANSACTION:
                    return null;
                default:
                    return codec.endResponse(dejavu);
            }
        }

        switch (type) {
            case MSG.REQUEST_CURRENT_TICK_INFO:
                return this.respondTickInfo(dejavu);
            case MSG.REQUEST_ENTITY:
                return this.respondEntity(payload, dejavu);
            case MSG.REQUEST_CONTRACT_FUNCTION:
                return this.respondContractFunction(payload, dejavu);
            case MSG.BROADCAST_TRANSACTION:
                await this.engine.broadcastTx(payload); // broadcast — no response
                return null;
            case MSG.REQUEST_SYSTEM_INFO:
                return this.respondSystemInfo(dejavu);
            case MSG.REQUEST_LOG:
                return this.respondLog(payload, dejavu);
            case MSG.REQUEST_LOG_ID_RANGE_FROM_TX:
                return this.respondLogRange(payload, dejavu);
            case MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX:
                return this.respondAllLogRanges(payload, dejavu);
            case MSG.REQUEST_PRUNING_LOG:
                return this.respondPruneLog(payload, dejavu);
            case MSG.REQUEST_LOG_STATE_DIGEST:
                return this.respondLogDigest(payload, dejavu);
            case MSG.REQUEST_TX_STATUS:
                return this.respondTxStatus(payload, dejavu);
            case MSG.REQUEST_TICK_TRANSACTIONS:
                return this.respondTickTransactions(payload, dejavu);
            case MSG.REQUEST_TICK_DATA:
                return this.respondTickData(payload, dejavu);
            case MSG.REQUEST_TRANSACTION_INFO:
                return this.respondTxInfo(payload, dejavu);
            case MSG.REQUEST_COMPUTORS:
                return this.respondComputors(dejavu);
            case MSG.REQUEST_QUORUM_TICK:
                return this.respondQuorumTick(payload, dejavu);
            case MSG.REQUEST_OWNED_ASSETS:
                return this.respondOwnedAssets(payload, dejavu);
            case MSG.REQUEST_POSSESSED_ASSETS:
                return this.respondPossessedAssets(payload, dejavu);
            case MSG.REQUEST_ISSUED_ASSETS:
                return this.respondIssuedAssets(payload, dejavu);
            case MSG.REQUEST_ASSETS:
                return this.respondAssets(payload, dejavu);
            case MSG.PROCESS_SPECIAL_COMMAND:
                return codec.frame(MSG.PROCESS_SPECIAL_COMMAND, payload, dejavu); // ack: echo the command struct
            default:
                return null;
        }
    }

    private respondTickInfo(dejavu: number): Uint8Array {
        const sim = this.engine.sim;
        const fault = sim.faultInfo();
        const epoch = fault?.lastFinalizedEpoch ?? sim.currentEpoch;
        const tick = fault?.lastFinalizedTick ?? sim.currentTick;
        const payload = codec.encodeCurrentTickInfo({
            tickDuration: sim.tickDuration,
            epoch,
            tick,
            numberOfAlignedVotes: sim.alignedVotes(tick),
            numberOfMisalignedVotes: 0,
            initialTick: epoch * sim.epochLength,
        });
        return codec.frame(MSG.RESPOND_CURRENT_TICK_INFO, payload, dejavu);
    }

    private respondEntity(payload: Uint8Array, dejavu: number): Uint8Array {
        const sim = this.engine.sim;
        const id = payload.subarray(0, 32);
        const e = sim.entityOf(id);
        const fields = e ?? {
            incomingAmount: 0n,
            outgoingAmount: 0n,
            numberOfIncomingTransfers: 0,
            numberOfOutgoingTransfers: 0,
            latestIncomingTransferTick: 0,
            latestOutgoingTransferTick: 0,
        };
        const proof = sim.spectrumProof(id);
        const enc = codec.encodeRespondEntity(id, fields, sim.currentTick, proof.index, proof.siblings);
        return codec.frame(MSG.RESPOND_ENTITY, enc, dejavu);
    }

    private async respondContractFunction(payload: Uint8Array, dejavu: number): Promise<Uint8Array> {
        const req = codec.decodeContractFunction(payload);
        let out: Uint8Array = new Uint8Array(0);
        try {
            out = await this.engine.querySmartContract(req.contractIndex, req.inputType, req.input);
        } catch {
            out = new Uint8Array(0); // unknown contract / function -> empty output (a client reads it as a failed call)
        }
        return codec.frame(MSG.RESPOND_CONTRACT_FUNCTION, out, dejavu);
    }

    private respondSystemInfo(dejavu: number): Uint8Array {
        const sim = this.engine.sim;
        const fault = sim.faultInfo();
        const epoch = fault?.lastFinalizedEpoch ?? sim.currentEpoch;
        const tick = fault?.lastFinalizedTick ?? sim.currentTick;
        const payload = codec.encodeSystemInfo({
            version: 1,
            epoch,
            tick,
            initialTick: epoch * sim.epochLength,
            latestCreatedTick: tick,
            numberOfEntities: sim.entityCount(),
            numberOfTransactions: sim.txCount(),
        });
        return codec.frame(MSG.RESPOND_SYSTEM_INFO, payload, dejavu);
    }

    private respondLog(payload: Uint8Array, dejavu: number): Uint8Array {
        const req = codec.decodeRequestLog(payload);
        if (!req || req.from > req.to) return codec.endResponse(dejavu);
        const bytes = this.engine.logger.recordsBetween(req.from, req.to);
        return bytes ? codec.frame(MSG.RESPOND_LOG, bytes, dejavu) : codec.endResponse(dejavu);
    }

    private respondLogRange(payload: Uint8Array, dejavu: number): Uint8Array {
        const req = codec.decodeLogRangeRequest(payload);
        if (!req) return codec.endResponse(dejavu);
        const range = this.engine.logger.range(req.tick, req.txId);
        return codec.frame(MSG.RESPOND_LOG_ID_RANGE_FROM_TX, codec.encodeLogRange(range.fromLogId, range.length), dejavu);
    }

    private respondAllLogRanges(payload: Uint8Array, dejavu: number): Uint8Array {
        const tick = codec.decodeAllLogRangesRequest(payload);
        if (tick === null) return codec.endResponse(dejavu);
        return codec.frame(MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX, codec.encodeAllLogRanges(this.engine.logger.tickRanges(tick)), dejavu);
    }

    private respondPruneLog(payload: Uint8Array, dejavu: number): Uint8Array {
        const req = codec.decodePruneLogRequest(payload);
        if (!req) return codec.endResponse(dejavu);
        return codec.frame(MSG.RESPOND_PRUNING_LOG, codec.encodePruneResult(this.engine.logger.prune(req.from, req.to)), dejavu);
    }

    private respondLogDigest(payload: Uint8Array, dejavu: number): Uint8Array {
        const tick = codec.decodeLogDigestRequest(payload);
        if (tick === null) return codec.endResponse(dejavu);
        const digest = this.engine.logger.digest(tick);
        return digest ? codec.frame(MSG.RESPOND_LOG_STATE_DIGEST, digest, dejavu) : codec.endResponse(dejavu);
    }

    private respondTxStatus(payload: Uint8Array, dejavu: number): Uint8Array {
        const sim = this.engine.sim;
        const tick = codec.decodeTick(payload);
        const recs = sim.tickTransactions(tick);
        const digests = recs.map((record) => record.digest);
        const money = recs.map((r) => r.moneyFlew);
        const enc = codec.encodeTxStatus(sim.finalizedTick(), tick, digests, money);
        return codec.frame(MSG.RESPOND_TX_STATUS, enc, dejavu);
    }

    // Return the leader's signed TickData, or END_RESPONSE when none is retained.
    private respondTickData(payload: Uint8Array, dejavu: number): Uint8Array {
        const tick = codec.decodeTick(payload);
        const tickData = this.engine.sim.tickData(tick)?.bytes;
        return tickData ? codec.frame(MSG.BROADCAST_FUTURE_TICK_DATA, tickData, dejavu) : codec.endResponse(dejavu);
    }

    // Stream raw transactions whose request flags are clear, then END_RESPONSE.
    private respondTickTransactions(payload: Uint8Array, dejavu: number): Uint8Array | null {
        const request = codec.decodeTickTransactionsRequest(payload);
        if (!request) {
            return null;
        }

        const frames: Uint8Array[] = [];
        const transactions = this.engine.sim.tickTransactions(request.tick);
        for (let transactionIndex = 0; transactionIndex < transactions.length; transactionIndex++) {
            const flag = 1 << (transactionIndex & 7);
            if ((request.transactionFlags[transactionIndex >> 3] & flag) !== 0) {
                continue;
            }

            const raw = this.engine.rawTx(transactions[transactionIndex].txId);
            if (raw) {
                frames.push(codec.frame(MSG.BROADCAST_TRANSACTION, raw, dejavu));
            }
        }

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }

    // REQUEST_OWNED_ASSETS — stream a RespondOwnedAssets per holding the queried account owns, with
    // the asset's issuance record attached, then END_RESPONSE.
    private respondOwnedAssets(payload: Uint8Array, dejavu: number): Uint8Array {
        const owner = payload.subarray(0, 32);
        const frames: Uint8Array[] = [];

        for (const p of this.engine.sim.universeProofOwned(owner)) {
            const enc = codec.encodeRespondOwnedAssets(
                {
                    owner,
                    issuer: p.issuer,
                    name: unpackAssetName(p.name),
                    decimals: p.decimals,
                    shares: p.shares,
                    managingContractIndex: p.managingContractIndex,
                    tick: this.engine.sim.currentTick,
                    issuanceRecord: p.issuanceRecord,
                },
                p.index,
                p.siblings,
                p.record,
            );
            frames.push(codec.frame(MSG.RESPOND_OWNED_ASSETS, enc, dejavu));
        }

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }

    // REQUEST_POSSESSED_ASSETS — stream a RespondPossessedAssets per holding the queried account possesses (with
    // the possession's managing contract, the ownership record, and the issuance record), then END_RESPONSE.
    private respondPossessedAssets(payload: Uint8Array, dejavu: number): Uint8Array {
        const possessor = payload.subarray(0, 32);
        const frames: Uint8Array[] = [];

        for (const p of this.engine.sim.universeProofPossessed(possessor)) {
            const enc = codec.encodeRespondPossessedAssets(
                {
                    possessor,
                    owner: p.owner,
                    issuer: p.issuer,
                    name: unpackAssetName(p.name),
                    decimals: p.decimals,
                    shares: p.shares,
                    possessionManagingContract: p.possessionManagingContractIndex,
                    ownershipManagingContract: p.ownershipManagingContractIndex,
                    tick: this.engine.sim.currentTick,
                    ownershipRecord: p.ownershipRecord,
                    issuanceRecord: p.issuanceRecord,
                },
                p.index,
                p.siblings,
                p.record,
            );
            frames.push(codec.frame(MSG.RESPOND_POSSESSED_ASSETS, enc, dejavu));
        }

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }

    private respondIssuedAssets(payload: Uint8Array, dejavu: number): Uint8Array {
        const issuer = payload.subarray(0, 32);
        const frames = this.engine.sim.universeProofIssuances({ issuer }).map((proof) =>
            codec.frame(
                MSG.RESPOND_ISSUED_ASSETS,
                codec.encodeRespondAssets({
                    record: proof.record,
                    tick: this.engine.sim.currentTick,
                    universeIndex: proof.index,
                    siblings: proof.siblings,
                }),
                dejavu,
            ),
        );

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }

    private respondAssets(payload: Uint8Array, dejavu: number): Uint8Array {
        const request = codec.decodeAssetsRequest(payload);
        if (!request) {
            return codec.endResponse(dejavu);
        }

        const sim = this.engine.sim;
        let proofs: {
            record: Uint8Array;
            index: number;
            siblings: Uint8Array[];
        }[];

        switch (request.kind) {
            case "index": {
                const proof = sim.universeProofAt(request.universeIndex);
                proofs = proof ? [proof] : [];
                break;
            }
            case "issuance":
                proofs = sim.universeProofIssuances(request);
                break;
            case "ownership":
                proofs = sim.universeProofOwnerships(request);
                break;
            case "possession":
                proofs = sim.universeProofPossessions(request);
                break;
        }

        const frames = proofs.map((proof) =>
            codec.frame(
                MSG.RESPOND_ASSETS,
                codec.encodeRespondAssets({
                    record: proof.record,
                    tick: sim.currentTick,
                    universeIndex: proof.index,
                    siblings: request.includeSiblings ? proof.siblings : undefined,
                }),
                dejavu,
            ),
        );

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }

    private respondTxInfo(payload: Uint8Array, dejavu: number): Uint8Array {
        const raw = this.engine.rawTx(toHex(payload.subarray(0, 32)));
        if (!raw) {
            return codec.endResponse(dejavu);
        }
        return codec.frame(MSG.BROADCAST_TRANSACTION, raw, dejavu);
    }

    private respondComputors(dejavu: number): Uint8Array {
        // Arbitrator-signed Computors list, padded to the 676-slot computor list.
        const list = this.engine.sim.signedComputorList(codec.CLI_NUMBER_OF_COMPUTORS);
        return codec.frame(MSG.BROADCAST_COMPUTORS, list, dejavu);
    }

    private respondQuorumTick(payload: Uint8Array, dejavu: number): Uint8Array | null {
        const request = codec.decodeQuorumTickRequest(payload);
        if (!request) {
            return null;
        }

        const rec = this.engine.sim.tickRecord(request.tick);
        if (!rec) {
            return codec.endResponse(dejavu);
        }

        const frames: Uint8Array[] = [];
        for (let computorIndex = 0; computorIndex < rec.votes.length; computorIndex++) {
            const flag = 1 << (computorIndex & 7);
            if ((request.voteFlags[computorIndex >> 3] & flag) !== 0) {
                continue;
            }

            frames.push(codec.frame(MSG.BROADCAST_TICK, rec.votes[computorIndex].bytes, dejavu));
        }

        frames.push(codec.endResponse(dejavu));
        return concatBytes(frames);
    }
}
