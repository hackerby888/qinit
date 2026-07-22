import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/k12";
import { Sim } from "../../src/sim";

const SLOT = 29;
const QUERY = 2;
const SUBSCRIBE = 3;
const UNSUBSCRIBE = 4;
const LAST = 1;
const STATUS = 2;
const OQ_UNKNOWN = 0n;
const OQ_PENDING = 1n;
const OQ_SUCCESS = 3n;

function cid(slot: number): Uint8Array {
  const id = new Uint8Array(32);
  new DataView(id.buffer).setBigUint64(0, BigInt(slot), true);
  return id;
}

function priceInput(milliseconds: number, notifyPrevious = false): Uint8Array {
  const input = new Uint8Array(112);
  input.set(new TextEncoder().encode("mock"), 0);
  input.set(new TextEncoder().encode("BTC"), 40);
  input.set(new TextEncoder().encode("USD"), 72);
  new DataView(input.buffer).setUint32(104, milliseconds, true);
  input[108] = notifyPrevious ? 1 : 0;
  return input;
}

function priceReply(numerator: bigint, denominator: bigint): Uint8Array {
  const reply = new Uint8Array(16);
  const view = new DataView(reply.buffer);
  view.setBigInt64(0, numerator, true);
  view.setBigInt64(8, denominator, true);
  return reply;
}

function statusInput(queryId: bigint): Uint8Array {
  const input = new Uint8Array(8);
  new DataView(input.buffer).setBigInt64(0, queryId, true);
  return input;
}

function subscriptionInput(subscriptionId: number): Uint8Array {
  const input = new Uint8Array(4);
  new DataView(input.buffer).setInt32(0, subscriptionId, true);
  return input;
}

function i64(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(0, true);
}

function i32(bytes: Uint8Array): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(0, true);
}

function u64(bytes: Uint8Array): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(0, true);
}

function last(sim: Sim) {
  const bytes = sim.query(SLOT, LAST);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    numerator: view.getBigInt64(0, true),
    denominator: view.getBigInt64(8, true),
    queryId: view.getBigInt64(16, true),
    subscriptionId: view.getInt32(24, true),
    status: bytes[28],
  };
}

async function deployProbe(): Promise<Sim> {
  await initK12();
  const sim = new Sim();
  sim.tickDuration = 60_000;
  sim.deploy(SLOT, await wasm("OracleProbe"));
  sim.fund(cid(SLOT), 1_000_000n);
  return sim;
}

test("Price query resolves through its notification procedure", async () => {
  const sim = await deployProbe();
  const queryId = i64(sim.procedure(SLOT, QUERY, priceInput(60_000)));

  expect(queryId).toBeGreaterThan(0n);
  expect(u64(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_PENDING);
  expect(sim.balance(cid(SLOT))).toBe(999_990n);
  expect(sim.resolveOracle(queryId, priceReply(42n, 1n))).toBe(true);
  expect(u64(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_SUCCESS);
  expect(last(sim)).toEqual({
    numerator: 42n,
    denominator: 1n,
    queryId,
    subscriptionId: -1,
    status: Number(OQ_SUCCESS),
  });
});

test("Price provider resolves pending queries on advance", async () => {
  const sim = await deployProbe();
  sim.setOracleProvider((interfaceIndex) =>
    interfaceIndex === 0 ? priceReply(100n, 3n) : null,
  );
  const queryId = i64(sim.procedure(SLOT, QUERY, priceInput(60_000)));

  sim.advance();
  expect(u64(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_SUCCESS);
  expect(last(sim).numerator).toBe(100n);
});

test("Price subscription uses whole-minute periods and charges once", async () => {
  const sim = await deployProbe();
  const timestamps: bigint[] = [];
  sim.setOracleProvider((_interfaceIndex, query) => {
    timestamps.push(
      new DataView(query.buffer, query.byteOffset, query.byteLength).getBigUint64(32, true),
    );
    return priceReply(7n, 2n);
  });

  const subscriptionId = i32(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_000)));
  expect(subscriptionId).toBeGreaterThanOrEqual(0);
  expect(sim.balance(cid(SLOT))).toBe(990_000n);

  sim.advance();
  sim.advance();
  sim.advance();
  expect(timestamps).toHaveLength(3);
  expect(new Set(timestamps).size).toBe(3);
  expect(sim.balance(cid(SLOT))).toBe(990_000n);
  expect(last(sim).numerator).toBe(7n);
});

test("invalid Price subscription periods fail without charging", async () => {
  const sim = await deployProbe();

  expect(i32(sim.procedure(SLOT, SUBSCRIBE, priceInput(59_000)))).toBe(-1);
  expect(i32(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_001)))).toBe(-1);
  expect(sim.balance(cid(SLOT))).toBe(1_000_000n);
  expect(last(sim).status).toBe(Number(OQ_UNKNOWN));
});

test("unsubscribe stops future Price subscription queries", async () => {
  const sim = await deployProbe();
  let calls = 0;
  sim.setOracleProvider(() => {
    calls++;
    return priceReply(5n, 1n);
  });
  const subscriptionId = i32(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_000)));

  expect(i32(sim.procedure(SLOT, UNSUBSCRIBE, subscriptionInput(subscriptionId)))).toBe(1);
  sim.advance();
  sim.advance();
  sim.advance();
  expect(calls).toBe(1);
});

test("unknown query ids stay UNKNOWN", async () => {
  const sim = await deployProbe();
  expect(u64(sim.query(SLOT, STATUS, statusInput(424242n)))).toBe(OQ_UNKNOWN);
  expect(sim.resolveOracle(424242n, priceReply(1n, 1n))).toBe(false);
});
