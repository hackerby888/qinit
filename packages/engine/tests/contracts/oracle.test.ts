// Oracle — a wasm contract queries / subscribes to the Mock interface (value -> {echoed, doubled}); the engine
// records the query as opaque bytes and, on resolve (manual or via a provider), fires the contract's
import { test, expect } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

function cid(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}

function i64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigInt64(0, true);
}

function u64(b: Uint8Array): bigint {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getBigUint64(0, true);
}

// Mock::OracleQuery { uint64 value } padded to the {uint64;uint32} input structs (value@0, period/timeout@8).
function queryIn(value: bigint, ms: number): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, value, true);
  dv.setUint32(8, ms, true);
  return b;
}

// Mock::OracleReply { uint64 echoedValue; uint64 doubledValue }
function mockReply(echoed: bigint, doubled: bigint): Uint8Array {
  const b = new Uint8Array(16);
  const dv = new DataView(b.buffer);
  dv.setBigUint64(0, echoed, true);
  dv.setBigUint64(8, doubled, true);
  return b;
}

function statusIn(queryId: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, queryId, true);
  return b;
}

function subIdIn(subscriptionId: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, subscriptionId, true);
  return b;
}

function u32(b: Uint8Array): number {
  return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(0, true);
}

const OQ_UNKNOWN = 0n;
const OQ_PENDING = 1n;
const OQ_SUCCESS = 3n;
const QUERY = 2;
const SUBSCRIBE = 3;
const UNSUB = 4;
const LAST = 1;
const STATUS = 2;

async function deployProbe(): Promise<Sim> {
  await initK12();
  const sim = new Sim();
  sim.deploy(29, await wasm("OracleProbe"));
  sim.fund(cid(29), 1_000_000n); // spectrum balance to burn for query/subscription fees
  return sim;
}

test("query -> manual resolve fires the notification procedure with the reply", async () => {
  const sim = await deployProbe();

  const qid = i64(sim.procedure(29, QUERY, queryIn(21n, 60000)));
  expect(qid).toBeGreaterThan(0n);
  expect(u64(sim.query(29, STATUS, statusIn(qid)))).toBe(OQ_PENDING);
  expect(i64(sim.query(29, LAST, new Uint8Array(0)))).toBe(0n); // not delivered yet

  expect(sim.resolveOracle(qid, mockReply(21n, 42n))).toBe(true);
  expect(u64(sim.query(29, STATUS, statusIn(qid)))).toBe(OQ_SUCCESS);
  expect(i64(sim.query(29, LAST, new Uint8Array(0)))).toBe(42n); // OnReply stored reply.doubledValue
});

test("an unknown queryId does not resolve", async () => {
  const sim = await deployProbe();
  expect(sim.resolveOracle(999n, mockReply(1n, 2n))).toBe(false);
});

test("a provider auto-resolves pending queries on advance()", async () => {
  const sim = await deployProbe();
  sim.setOracleProvider((_iface, q) => {
    const v = new DataView(q.buffer, q.byteOffset, q.byteLength).getBigUint64(0, true);
    return mockReply(v, v * 2n);
  });

  const qid = i64(sim.procedure(29, QUERY, queryIn(100n, 60000)));
  expect(u64(sim.query(29, STATUS, statusIn(qid)))).toBe(OQ_PENDING); // pending until a tick pumps it

  sim.advance();
  expect(u64(sim.query(29, STATUS, statusIn(qid)))).toBe(OQ_SUCCESS);
  expect(i64(sim.query(29, LAST, new Uint8Array(0)))).toBe(200n);
});

test("a subscription re-fires every period through the provider", async () => {
  const sim = await deployProbe();
  let calls = 0;
  sim.setOracleProvider((_iface, q) => {
    calls++;
    const v = new DataView(q.buffer, q.byteOffset, q.byteLength).getBigUint64(0, true);
    return mockReply(v, v * 2n);
  });

  const subId = i64(sim.procedure(29, SUBSCRIBE, queryIn(7n, 50))); // period 50ms = 1 tick (tickDuration 50)
  expect(subId).toBeGreaterThanOrEqual(0n);

  sim.advance();
  sim.advance();
  sim.advance();
  expect(calls).toBeGreaterThanOrEqual(3); // first query at subscribe + one per tick
  expect(i64(sim.query(29, LAST, new Uint8Array(0)))).toBe(14n); // 7 * 2
});

test("unsubscribe stops further subscription queries", async () => {
  const sim = await deployProbe();
  let calls = 0;
  sim.setOracleProvider((_iface, q) => {
    calls++;
    const v = new DataView(q.buffer, q.byteOffset, q.byteLength).getBigUint64(0, true);
    return mockReply(v, v * 2n);
  });

  const subId = i64(sim.procedure(29, SUBSCRIBE, queryIn(5n, 50)));
  expect(u32(sim.procedure(29, UNSUB, subIdIn(Number(subId))))).toBe(1); // unsubscribe before any tick
  sim.advance(); // resolves only the query already emitted at subscribe time
  sim.advance();
  sim.advance();
  expect(calls).toBe(1); // no further emissions after unsubscribe
});

test("getOracleQueryStatus is UNKNOWN for a queryId that was never issued", async () => {
  const sim = await deployProbe();
  expect(u64(sim.query(29, STATUS, statusIn(424242n)))).toBe(OQ_UNKNOWN);
});
