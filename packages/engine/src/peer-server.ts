// qubic-cli TCP bridge — a Bun.listen server that speaks the Qubic peer protocol and drives an InProcessEngine,
// so the official C++ client (`qubic-cli -nodeip 127.0.0.1 -nodeport <port> ...`) runs against the in-process
// sim. On connect it sends the ExchangePublicPeers handshake, then for each framed request it dispatches by
// message type to the engine + consensus (Part A) and writes the matching response. Bun-only (Bun.listen); kept
// out of the browser barrel (separate "@qinit/engine/peer" entry).
import { InProcessEngine } from "./transport";
import { initK12, toHex } from "./k12";
import { identityToBytes } from "@qinit/core";
import * as codec from "./peer-codec";
import { MSG } from "./peer-codec";

interface ConnState {
  buf: Uint8Array;
}

export interface PeerServerHandle {
  port: number;
  tickMs: number;
  stop: () => void;
}

export class PeerServer {
  readonly engine: InProcessEngine;
  private server: { stop(closeActiveConnections?: boolean): void; readonly port: number } | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(engine: InProcessEngine = new InProcessEngine()) {
    this.engine = engine;
  }

  // Listen on `port` (21841 = the cli's default node port). Auto-advances one tick every `tickMs` so gettick
  // moves + broadcast txs land; `tickMs` is also reported as the chain's tickDuration. Pre-funds the funded seed.
  async start(port = 21841, tickMs = 50): Promise<PeerServerHandle> {
    await initK12();
    await this.engine.seedFaucet();
    this.engine.sim.tickDuration = tickMs;

    // Present a realistic, ticking chain to the cli: a non-zero epoch (qubic-cli treats epoch 0 as "no data")
    // and a few finalized ticks so the very first query already carries a tick + quorum votes.
    if (this.engine.sim.epochN === 0) {
      this.engine.sim.epochN = 1;
    }
    this.engine.advanceTick(5);

    this.ticker = setInterval(() => {
      this.engine.advanceTick(1);
    }, tickMs);

    const self = this;
    const server = Bun.listen<ConnState>({
      hostname: "127.0.0.1",
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

    return { port: server.port, tickMs, stop: () => this.stop() };
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

  // Reassemble the TCP stream into complete [header|payload] frames and dispatch each. Leftover bytes (a partial
  // frame) are retained for the next chunk.
  private async onData(socket: { data: ConnState; write: (b: Uint8Array) => void }, chunk: Uint8Array<ArrayBufferLike>): Promise<void> {
    let buf = concat(socket.data.buf, new Uint8Array(chunk));

    while (true) {
      const header = codec.readHeader(buf);
      if (!header || buf.length < header.size) {
        break;
      }

      const payload = buf.subarray(codec.HEADER_SIZE, header.size);
      try {
        const resp = await this.dispatch(header.type, payload, header.dejavu);
        if (resp) {
          socket.write(resp);
        }
      } catch {
        // a malformed request must not kill the connection — drop it and keep serving
      }

      buf = buf.subarray(header.size);
    }

    socket.data.buf = buf.slice();
  }

  private async dispatch(type: number, payload: Uint8Array, dejavu: number): Promise<Uint8Array | null> {
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
      case MSG.REQUEST_ISSUED_ASSETS:
      case MSG.REQUEST_OWNED_ASSETS:
      case MSG.REQUEST_POSSESSED_ASSETS:
        return codec.endResponse(dejavu); // asset streaming over the peer protocol — empty for now (HTTP has it)
      case MSG.PROCESS_SPECIAL_COMMAND:
        return codec.frame(MSG.PROCESS_SPECIAL_COMMAND, payload, dejavu); // ack: echo the command struct
      default:
        return null;
    }
  }

  private respondTickInfo(dejavu: number): Uint8Array {
    const sim = this.engine.sim;
    const payload = codec.encodeCurrentTickInfo({
      tickDuration: sim.tickDuration,
      epoch: sim.epochN,
      tick: sim.tickN,
      numberOfAlignedVotes: sim.alignedVotes(),
      numberOfMisalignedVotes: 0,
      initialTick: 0,
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
    const enc = codec.encodeRespondEntity(id, fields, sim.tickN, e ? 0 : -1);
    return codec.frame(MSG.RESPOND_ENTITY, enc, dejavu);
  }

  private async respondContractFunction(payload: Uint8Array, dejavu: number): Promise<Uint8Array> {
    const req = codec.decodeContractFunction(payload);
    let out: Uint8Array = new Uint8Array(0);
    try {
      out = await this.engine.querySmartContract(req.contractIndex, req.inputType, req.input);
    } catch {
      out = new Uint8Array(0); // unknown contract / function -> empty output (cli reads it as a failed call)
    }
    return codec.frame(MSG.RESPOND_CONTRACT_FUNCTION, out, dejavu);
  }

  private respondSystemInfo(dejavu: number): Uint8Array {
    const sim = this.engine.sim;
    const payload = codec.encodeSystemInfo({
      version: 1,
      epoch: sim.epochN,
      tick: sim.tickN,
      initialTick: sim.epochN * sim.epochLength,
      latestCreatedTick: sim.tickN,
      numberOfEntities: sim.entityCount(),
      numberOfTransactions: sim.txCount(),
    });
    return codec.frame(MSG.RESPOND_SYSTEM_INFO, payload, dejavu);
  }

  private respondTxStatus(payload: Uint8Array, dejavu: number): Uint8Array {
    const sim = this.engine.sim;
    const tick = codec.decodeTick(payload);
    const recs = sim.tickTransactions(tick);
    const digests = recs.map((r) => identityToBytes(r.txId));
    const money = recs.map((r) => r.moneyFlew);
    const enc = codec.encodeTxStatus(sim.tickN, tick, digests, money);
    return codec.frame(MSG.RESPOND_TX_STATUS, enc, dejavu);
  }

  private respondTickData(payload: Uint8Array, dejavu: number): Uint8Array {
    const sim = this.engine.sim;
    const tick = codec.decodeTick(payload);
    const recs = sim.tickTransactions(tick);
    const digests = recs.map((r) => identityToBytes(r.txId));
    const enc = codec.encodeTickData(sim.epochN, tick, digests);
    return codec.frame(MSG.BROADCAST_FUTURE_TICK_DATA, enc, dejavu);
  }

  // REQUEST_TICK_TRANSACTIONS — stream the tick's raw txs as BROADCAST_TRANSACTION packets, then END_RESPONSE
  // (the cli's -checktxontick / tick-data flow scans these for a tx hash).
  private respondTickTransactions(payload: Uint8Array, dejavu: number): Uint8Array {
    const tick = codec.decodeTick(payload);
    const frames: Uint8Array[] = [];
    for (const r of this.engine.sim.tickTransactions(tick)) {
      const raw = this.engine.rawTx(r.txId);
      if (raw) {
        frames.push(codec.frame(MSG.BROADCAST_TRANSACTION, raw, dejavu));
      }
    }

    frames.push(codec.endResponse(dejavu));
    return concatAll(frames);
  }

  private respondTxInfo(payload: Uint8Array, dejavu: number): Uint8Array | null {
    const raw = this.engine.rawTx(toHex(payload.subarray(0, 32)));
    if (!raw) {
      return null;
    }
    return codec.frame(MSG.BROADCAST_TRANSACTION, raw, dejavu);
  }

  private respondComputors(dejavu: number): Uint8Array {
    // Arbitrator-signed Computors list (Part A), padded to the cli's 676-slot struct.
    const list = this.engine.sim.signedComputorList(codec.CLI_NUMBER_OF_COMPUTORS);
    return codec.frame(MSG.BROADCAST_COMPUTORS, list, dejavu);
  }

  private respondQuorumTick(payload: Uint8Array, dejavu: number): Uint8Array {
    const tick = codec.decodeTick(payload);
    const rec = this.engine.sim.tickRecord(tick);
    if (!rec) {
      return codec.endResponse(dejavu);
    }

    // Stream each computor's signed Tick vote (352 B, the cli's Tick layout) then END_RESPONSE.
    const frames = rec.votes.map((v) => codec.frame(MSG.BROADCAST_TICK, v, dejavu));
    frames.push(codec.endResponse(dejavu));
    return concatAll(frames);
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) {
    total += p.length;
  }

  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
