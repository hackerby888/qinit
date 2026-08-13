// LiteRpc's explorer methods against a live EngineServer — the seam the `qinit explorer` TUI reads through.
// Covers the mapped response shapes, string-typed amounts, and 404-as-null on the two lookup routes.
import { test, expect, beforeAll } from "bun:test";
import { EngineServer } from "@qinit/engine/server";
import { VirtualNode } from "@qinit/engine";
import { LiteRpc, buildSignedTx, deriveIdentity, initK12 } from "@qinit/core";
import { contractAddress, encodeInput } from "@qinit/proto";
import { loadWasmFixture } from "../../../../test-utils/wasm-fixtures";

const SEED = "a".repeat(55);
const SLOT = 28;

beforeAll(async () => {
    await initK12();
});

// A server with one applied Counter.Inc transaction, plus the client that reads it back.
async function explorerFixture() {
    const engine = new VirtualNode();
    engine.deploy(SLOT, await loadWasmFixture("Counter"));

    const handle = await new EngineServer(engine).start(0);
    const tx = await buildSignedTx(SEED, {
        destination: contractAddress(SLOT),
        amount: 0,
        tick: engine.sim.currentTick + 1,
        inputType: 1,
        payload: await encodeInput(""),
    });
    await engine.broadcastTx(tx.bytes);
    engine.advanceTickN(2); // apply the queued tx deterministically

    const record = engine.sim.txByHash(tx.id)!;
    const { identity } = await deriveIdentity(SEED);
    return {
        rpc: new LiteRpc(handle.rpcBaseUrl),
        stop: handle.stop,
        engine,
        txTick: record.tick,
        identity,
    };
}

test("explorerData maps the dashboard payload", async () => {
    const { rpc, stop, engine } = await explorerFixture();
    try {
        // The server keeps ticking, so the reported tick is only guaranteed to fall between the readings
        // either side of the request — comparing it to a single live sample is a race.
        const before = engine.sim.currentTick;
        const data = await rpc.explorerData();
        const after = engine.sim.currentTick;

        expect(data.header.tick).toBeGreaterThanOrEqual(before);
        expect(data.header.tick).toBeLessThanOrEqual(after);
        expect(data.recentTicks.length).toBeGreaterThan(0);
        expect(typeof data.spectrum.circulatingSupply).toBe("string");
        expect(BigInt(data.spectrum.circulatingSupply)).toBeGreaterThan(0n);
        expect(data.mempool.totalPending).toBe(0);
    } finally {
        stop();
    }
});

test("getTickData returns a tick header and null for a tick with none", async () => {
    const { rpc, stop, txTick } = await explorerFixture();
    try {
        const tickData = await rpc.getTickData(txTick);
        expect(tickData?.tickNumber).toBe(txTick);
        expect(Number(tickData?.timestamp)).toBeGreaterThan(0);
        expect(tickData?.transactionDigests.length).toBe(1);

        expect(await rpc.getTickData(999999)).toBeNull();
    } finally {
        stop();
    }
});

test("explorerTickTransactions returns full transactions with string amounts", async () => {
    const { rpc, stop, txTick } = await explorerFixture();
    try {
        const [tx] = await rpc.explorerTickTransactions(txTick);

        expect(tx.tickNumber).toBe(txTick);
        expect(tx.source).toMatch(/^[A-Z]{60}$/);
        expect(tx.destination).toMatch(/^[A-Z]{60}$/);
        expect(typeof tx.amount).toBe("string");
        expect(tx.inputType).toBe(1);
    } finally {
        stop();
    }
});

test("getTransactionByHash resolves a known hash and nulls an unknown one", async () => {
    const { rpc, stop, txTick } = await explorerFixture();
    try {
        const [tx] = await rpc.explorerTickTransactions(txTick);

        const found = await rpc.getTransactionByHash(tx.hash, txTick);
        expect(found?.hash).toBe(tx.hash);

        expect(await rpc.getTransactionByHash("z".repeat(60))).toBeNull();
    } finally {
        stop();
    }
});

test("getTransfersForIdentity reports the sender's outgoing transfer", async () => {
    const { rpc, stop, identity } = await explorerFixture();
    try {
        const { count, transactions } = await rpc.getTransfersForIdentity(identity);

        expect(count).toBeGreaterThan(0);
        expect(transactions[0].direction).toBe("out");
        expect(transactions[0].source).toBe(identity);
    } finally {
        stop();
    }
});

test("getContractCalls pages calls and getContracts lists the deployment", async () => {
    const { rpc, stop, engine } = await explorerFixture();
    try {
        const page = await rpc.getContractCalls({
            fromTick: 0,
            toTick: engine.sim.currentTick,
            pageSize: 50,
        });
        expect(page.total).toBeGreaterThan(0);
        expect(page.transactions[0].contractIndex).toBe(SLOT);

        const { contracts } = await rpc.getContracts();
        expect(contracts.some((c) => c.index === SLOT && c.stateSize > 0)).toBe(true);
    } finally {
        stop();
    }
});
