// The explorer HTTP routes (server.ts) — core-lite's /explorer/data and /query/v1/* shapes served by the
// simulator, so the TUI explorer works against either backend. Drives a real signed tx into a contract so
// the tick, transaction, transfer, and contract-call views all have something to report.
import { test, expect, beforeAll } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { VirtualNode } from "../../src/transport";
import { EngineServer } from "../../src/server";
import { buildSignedTx, deriveIdentity } from "@qinit/core";
import { contractAddress, encodeInput } from "@qinit/proto";

const SEED = "a".repeat(55);
const SLOT = 28;

beforeAll(async () => {
  await initK12();
});

// Boot a server whose chain already contains one Counter.Inc transaction, and report where it landed.
async function serveWithTx(): Promise<{
  base: string;
  stop: () => void;
  engine: VirtualNode;
  txTick: number;
  identity: string;
}> {
  const engine = new VirtualNode();
  engine.deploy(SLOT, await wasm("Counter"));

  const server = new EngineServer(engine);
  const handle = await server.start(0);

  const tx = await buildSignedTx(SEED, {
    destination: contractAddress(SLOT),
    amount: 0,
    tick: engine.sim.currentTick + 1,
    inputType: 1,
    payload: await encodeInput(""),
  });
  expect((await engine.broadcastTx(tx.bytes)).ok).toBe(true);

  // A broadcast tx is queued for its stamped tick, so advance past it instead of racing the auto-ticker,
  // then read back where it actually landed.
  engine.advanceTickN(2);
  const record = engine.sim.txByHash(tx.id);
  expect(record).toBeDefined();

  const { identity } = await deriveIdentity(SEED);
  return {
    base: handle.rpcBaseUrl,
    stop: handle.stop,
    engine,
    txTick: record!.tick,
    identity,
  };
}

const post = async (base: string, path: string, body: unknown) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("/explorer/data reports the header, recent ticks, mempool, and spectrum", async () => {
  const { base, stop, engine } = await serveWithTx();
  try {
    const r = await fetch(`${base}/explorer/data`);
    expect(r.status).toBe(200);

    const data = await r.json();
    expect(data.header.tick).toBe(engine.sim.currentTick);
    expect(data.header.epoch).toBe(engine.sim.currentEpoch);
    expect(data.header.ticksInCurrentEpoch).toBe(
      data.header.tick - data.header.initialTick,
    );
    expect(data.recentTicks.length).toBeGreaterThan(0);
    expect(data.recentTicks.length).toBeLessThanOrEqual(20);
    // Every recent tick names its leader as a 60-char identity.
    for (const t of data.recentTicks) expect(t.leader).toMatch(/^[A-Z]{60}$/);
    expect(typeof data.mempool.totalPending).toBe("number");
    expect(BigInt(data.spectrum.circulatingSupply)).toBeGreaterThan(0n);
    expect(data.spectrum.activeAddresses).toBeGreaterThan(0);
  } finally {
    stop();
  }
});

test("getTickData returns the tick header and 404s a tick with no data", async () => {
  const { base, stop, txTick } = await serveWithTx();
  try {
    const found = await post(base, "/query/v1/getTickData", { tickNumber: txTick });
    expect(found.status).toBe(200);

    const tickData = await found.json();
    expect(tickData.tickNumber).toBe(txTick);
    expect(tickData.transactionDigests.length).toBe(1);
    expect(tickData.signature.length).toBeGreaterThan(0);

    const missing = await post(base, "/query/v1/getTickData", { tickNumber: 999999 });
    expect(missing.status).toBe(404);
    expect((await missing.json()).message).toBe("Tick data not found");
  } finally {
    stop();
  }
});

test("getTransactionsForTick returns identities and a hash", async () => {
  const { base, stop, txTick } = await serveWithTx();
  try {
    const r = await post(base, "/query/v1/getTransactionsForTick", {
      tickNumber: txTick,
    });
    const [tx] = (await r.json()).transactions;

    expect(tx.hash.length).toBeGreaterThan(0);
    expect(tx.source).toMatch(/^[A-Z]{60}$/);
    expect(tx.destination).toMatch(/^[A-Z]{60}$/);
    expect(tx.tickNumber).toBe(txTick);
    expect(tx.inputType).toBe(1);
    // Broadcast txs keep their raw bytes, so the signature survives into the explorer view.
    expect(tx.signature.length).toBeGreaterThan(0);
    expect(typeof tx.amount).toBe("string");
  } finally {
    stop();
  }
});

test("getTransactionByHash finds a broadcast tx and 404s an unknown hash", async () => {
  const { base, stop, txTick } = await serveWithTx();
  try {
    const listed = await post(base, "/query/v1/getTransactionsForTick", {
      tickNumber: txTick,
    });
    const hash = (await listed.json()).transactions[0].hash;

    const found = await post(base, "/query/v1/getTransactionByHash", { hash });
    expect(found.status).toBe(200);
    expect((await found.json()).hash).toBe(hash);

    const missing = await post(base, "/query/v1/getTransactionByHash", {
      hash: "z".repeat(60),
    });
    expect(missing.status).toBe(404);
  } finally {
    stop();
  }
});

test("getTransfersForIdentity tags the sender's transfer as outgoing", async () => {
  const { base, stop, identity } = await serveWithTx();
  try {
    const r = await post(base, "/query/v1/getTransfersForIdentity", {
      identity,
      direction: "both",
      limit: 50,
    });
    const body = await r.json();

    expect(body.identity).toBe(identity);
    expect(body.count).toBeGreaterThan(0);
    expect(body.transactions[0].direction).toBe("out");
    expect(body.transactions[0].source).toBe(identity);
  } finally {
    stop();
  }
});

test("getContractCalls finds the call by its contract slot", async () => {
  const { base, stop, engine } = await serveWithTx();
  try {
    const r = await post(base, "/query/v1/getContractCalls", {
      fromTick: 0,
      toTick: engine.sim.currentTick,
      page: 0,
      pageSize: 50,
    });
    const page = await r.json();

    expect(page.total).toBeGreaterThan(0);
    expect(page.transactions[0].contractIndex).toBe(SLOT);

    // Filtering to another slot excludes it.
    const other = await post(base, "/query/v1/getContractCalls", {
      fromTick: 0,
      toTick: engine.sim.currentTick,
      contractIndex: SLOT + 1,
    });
    expect((await other.json()).total).toBe(0);
  } finally {
    stop();
  }
});

test("getContracts lists the deployed contract with its state size", async () => {
  const { base, stop } = await serveWithTx();
  try {
    const r = await fetch(`${base}/query/v1/getContracts`);
    expect(r.status).toBe(200);

    const { contracts } = await r.json();
    const counter = contracts.find((c: { index: number }) => c.index === SLOT);
    expect(counter).toBeDefined();
    expect(counter.stateSize).toBeGreaterThan(0);
  } finally {
    stop();
  }
});
