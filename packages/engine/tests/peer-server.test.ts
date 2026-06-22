// Peer-protocol server — integration over a real TCP socket. Starts a PeerServer on an ephemeral port, connects
// with Bun.connect, sends raw request packets, and asserts the decoded responses: the handshake,
// current-tick-info (with real aligned votes), entity balance, a contract-function call, and the
// arbitrator-signed computor list.
import { test, expect } from "bun:test";
import { initK12, k12Bytes, toHex, verifySync } from "../src/k12";
import { InProcessEngine } from "../src/transport";
import { PeerServer } from "../src/peer-server";
import * as codec from "../src/peer-codec";
import { MSG } from "../src/peer-codec";
import { TICKDATA_SIZE, TICK_SIZE, tickDataMessage, tickDataSignature, tickVoteMessage, tickVoteSignature } from "../src/consensus";

const FIX = import.meta.dir + "/fixtures";

async function wasm(name: string): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(`${FIX}/${name}.wasm`).arrayBuffer());
}

interface Frame {
  type: number;
  payload: Uint8Array;
}

// Connect, send `request`, collect the stream for a short window, and split it into frames (the leading
// ExchangePublicPeers handshake is included — callers filter by type).
async function exchange(port: number, request: Uint8Array): Promise<Frame[]> {
  const chunks: Uint8Array[] = [];
  const sock = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      open(s) {
        s.write(request);
      },
      data(_s, d) {
        chunks.push(new Uint8Array(d));
      },
    },
  });

  await new Promise((r) => setTimeout(r, 150));
  sock.end();

  let total = 0;
  for (const c of chunks) {
    total += c.length;
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.length;
  }

  const frames: Frame[] = [];
  let off = 0;
  while (off + codec.HEADER_SIZE <= buf.length) {
    const h = codec.readHeader(buf, off);
    if (!h || off + h.size > buf.length) {
      break;
    }
    frames.push({ type: h.type, payload: buf.subarray(off + codec.HEADER_SIZE, off + h.size) });
    off += h.size;
  }
  return frames;
}

function dv(b: Uint8Array): DataView {
  return new DataView(b.buffer, b.byteOffset, b.byteLength);
}

test("handshake + current-tick-info returns the live tick with aligned votes", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.advanceTick(3); // a few finalized ticks so the response carries a real tick + quorum record

    const frames = await exchange(port, codec.frame(MSG.REQUEST_CURRENT_TICK_INFO, new Uint8Array(0), 1));
    expect(frames.some((f) => f.type === MSG.EXCHANGE_PUBLIC_PEERS)).toBe(true); // handshake

    const tickFrame = frames.find((f) => f.type === MSG.RESPOND_CURRENT_TICK_INFO)!;
    expect(tickFrame).toBeDefined();
    const d = dv(tickFrame.payload);
    expect(d.getUint32(4, true)).toBeGreaterThanOrEqual(3); // tick advanced
    expect(d.getUint16(8, true)).toBe(8); // numberOfAlignedVotes == default committee size
  } finally {
    stop();
  }
});

test("entity request returns the funded balance", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const id = new Uint8Array(32).fill(0x22);
  engine.fund(id, 5000n);

  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    const frames = await exchange(port, codec.frame(MSG.REQUEST_ENTITY, id, 2));
    const f = frames.find((x) => x.type === MSG.RESPOND_ENTITY)!;
    expect(f).toBeDefined();
    const d = dv(f.payload);
    expect(f.payload.subarray(0, 32)).toEqual(id);
    expect(d.getBigInt64(32, true)).toBe(5000n); // incomingAmount
  } finally {
    stop();
  }
});

test("contract-function request runs a Counter query through the engine", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.deploy(28, await wasm("Counter"));

    const p = new Uint8Array(8);
    const d = dv(p);
    d.setUint32(0, 28, true); // contractIndex
    d.setUint16(4, 1, true); // inputType = Get
    d.setUint16(6, 0, true); // inputSize

    const frames = await exchange(port, codec.frame(MSG.REQUEST_CONTRACT_FUNCTION, p, 3));
    const f = frames.find((x) => x.type === MSG.RESPOND_CONTRACT_FUNCTION)!;
    expect(f).toBeDefined();
    expect(dv(f.payload).getBigUint64(0, true)).toBe(0n); // Counter starts at 0
  } finally {
    stop();
  }
});

test("computor-list request returns the arbitrator-signed 676-slot list", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    const frames = await exchange(port, codec.frame(MSG.REQUEST_COMPUTORS, new Uint8Array(0), 4));
    const f = frames.find((x) => x.type === MSG.BROADCAST_COMPUTORS)!;
    expect(f).toBeDefined();
    // epoch(2) + 676 pubkeys*32 + signature(64)
    expect(f.payload.length).toBe(2 + codec.CLI_NUMBER_OF_COMPUTORS * 32 + 64);
  } finally {
    stop();
  }
});

test("tick-data request returns the signed TickData and its leader signature verifies", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.advanceTick(4);
    const tick = 3;
    const req = new Uint8Array(4);
    dv(req).setUint32(0, tick, true);

    const frames = await exchange(port, codec.frame(MSG.REQUEST_TICK_DATA, req, 7));
    const f = frames.find((x) => x.type === MSG.BROADCAST_FUTURE_TICK_DATA)!;
    expect(f).toBeDefined();
    expect(f.payload.length).toBe(TICKDATA_SIZE); // 139376

    const leaderIndex = dv(f.payload).getUint16(0, true);
    expect(leaderIndex).toBe(tick % 8); // default committee size
    const leader = engine.sim.getCommittee().computors[leaderIndex];
    expect(verifySync(leader.publicKey, tickDataMessage(f.payload), tickDataSignature(f.payload))).toBe(true);
  } finally {
    stop();
  }
});

test("quorum-tick request streams the committee's verifiable Tick votes", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.advanceTick(4);
    const req = new Uint8Array(4);
    dv(req).setUint32(0, 3, true);

    const frames = await exchange(port, codec.frame(MSG.REQUEST_QUORUM_TICK, req, 8));
    const votes = frames.filter((x) => x.type === MSG.BROADCAST_TICK);
    expect(votes.length).toBe(8); // one vote per computor
    expect(frames.some((x) => x.type === MSG.END_RESPONSE)).toBe(true);

    const committee = engine.sim.getCommittee();
    for (const v of votes) {
      expect(v.payload.length).toBe(TICK_SIZE); // 352
      const idx = dv(v.payload).getUint16(0, true);
      expect(verifySync(committee.computors[idx].publicKey, tickVoteMessage(v.payload), tickVoteSignature(v.payload))).toBe(true);
    }
  } finally {
    stop();
  }
});

test("system-info request reports epoch/tick and entity count", async () => {
  await initK12();
  const engine = new InProcessEngine();
  engine.fund(new Uint8Array(32).fill(0x44), 10n);
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.advanceTick(2);

    const frames = await exchange(port, codec.frame(MSG.REQUEST_SYSTEM_INFO, new Uint8Array(0), 9));
    const f = frames.find((x) => x.type === MSG.RESPOND_SYSTEM_INFO)!;
    expect(f).toBeDefined();
    const d = dv(f.payload);
    expect(d.getUint32(4, true)).toBeGreaterThanOrEqual(2); // tick
    expect(d.getUint32(24, true)).toBeGreaterThanOrEqual(1); // numberOfEntities (the funded id)
  } finally {
    stop();
  }
});

test("transaction-info request returns the stored raw tx by its digest", async () => {
  await initK12();
  const engine = new InProcessEngine(); // verifySigs off -> a well-formed tx is accepted without a real signature
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    const tx = new Uint8Array(144); // source(32) dest(32) amount(8) tick(4) inputType(2) inputSize(2) ... sig(64)
    tx.fill(0x05, 0, 32);
    tx.fill(0x06, 32, 64);
    dv(tx).setUint32(72, 1, true); // tick
    await engine.broadcastTx(tx);

    const full = k12Bytes(tx); // K12(full tx incl. sig) — one of the three keys rawTxs is indexed by
    const frames = await exchange(port, codec.frame(MSG.REQUEST_TRANSACTION_INFO, full, 10));
    const f = frames.find((x) => x.type === MSG.BROADCAST_TRANSACTION)!;
    expect(f).toBeDefined();
    expect(toHex(f.payload)).toBe(toHex(tx));
  } finally {
    stop();
  }
});

test("a malformed request does not kill the connection", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.advanceTick(2);

    // a truncated contract-function frame (the decoder reads past its 2-byte body) followed by a valid request
    const garbage = codec.frame(MSG.REQUEST_CONTRACT_FUNCTION, new Uint8Array(2), 11);
    const good = codec.frame(MSG.REQUEST_CURRENT_TICK_INFO, new Uint8Array(0), 12);
    const both = new Uint8Array(garbage.length + good.length);
    both.set(garbage, 0);
    both.set(good, garbage.length);

    const frames = await exchange(port, both);
    expect(frames.some((x) => x.type === MSG.RESPOND_CURRENT_TICK_INFO)).toBe(true);
  } finally {
    stop();
  }
});

test("possessed-assets request streams the possession records the account holds", async () => {
  await initK12();
  const engine = new InProcessEngine();
  const server = new PeerServer(engine);
  const { port, stop } = await server.start(0);

  try {
    engine.deploy(28, await wasm("Token"));
    const issueIn = new Uint8Array(16); // { uint64 name; sint64 shares }
    new DataView(issueIn.buffer).setBigUint64(0, 0x4e454b4f54n, true); // "TOKEN"
    new DataView(issueIn.buffer).setBigInt64(8, 1000n, true);
    engine.sim.procedure(28, 1, issueIn); // id(28) possesses 1000, managed by contract 28

    const id28 = new Uint8Array(32);
    new DataView(id28.buffer).setBigUint64(0, 28n, true);

    const frames = await exchange(port, codec.frame(MSG.REQUEST_POSSESSED_ASSETS, id28, 13));
    const recs = frames.filter((x) => x.type === MSG.RESPOND_POSSESSED_ASSETS);
    expect(recs.length).toBe(1);
    expect(frames.some((x) => x.type === MSG.END_RESPONSE)).toBe(true);

    const d = dv(recs[0].payload);
    expect(recs[0].payload[32]).toBe(3); // possession record type
    expect(d.getUint16(34, true)).toBe(28); // managed by the issuing contract
    expect(d.getBigInt64(40, true)).toBe(1000n); // shares
  } finally {
    stop();
  }
});
