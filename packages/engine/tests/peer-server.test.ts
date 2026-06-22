// qubic-cli peer bridge — integration over a real TCP socket (no C++ needed). Starts a PeerServer on an
// ephemeral port, connects with Bun.connect, sends raw request packets, and asserts the decoded responses: the
// handshake, current-tick-info (with real aligned votes), entity balance, a contract-function call, and the
// arbitrator-signed computor list.
import { test, expect } from "bun:test";
import { initK12 } from "../src/k12";
import { InProcessEngine } from "../src/transport";
import { PeerServer } from "../src/peer-server";
import * as codec from "../src/peer-codec";
import { MSG } from "../src/peer-codec";

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
