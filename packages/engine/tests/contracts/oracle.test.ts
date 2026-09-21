import { expect, test } from "bun:test";
import { loadWasmFixture as wasm } from "../../../../test-utils/wasm-fixtures";
import { initK12 } from "../../src/support/k12";
import { QubicSimulator } from "../../src/qubic-simulator";
import { contractId, readInt32LE, readInt64LE, readUint64LE } from "../support/helpers";

const SLOT = 29;
const QUERY = 2;
const SUBSCRIBE = 3;
const UNSUBSCRIBE = 4;
const LAST = 1;
const STATUS = 2;
const OQ_UNKNOWN = 0n;
const OQ_PENDING = 1n;
const OQ_COMMITTED = 2n;
const OQ_SUCCESS = 3n;

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

function last(sim: QubicSimulator) {
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

async function deployProbe(): Promise<QubicSimulator> {
    await initK12();
    const sim = new QubicSimulator();
    sim.tickDuration = 60_000;
    sim.deploy(SLOT, await wasm("OracleProbe"));
    sim.fund(contractId(SLOT), 1_000_000n);
    return sim;
}

test("Price query resolves through its notification procedure", async () => {
    const sim = await deployProbe();
    const queryId = readInt64LE(sim.procedure(SLOT, QUERY, priceInput(60_000)));

    expect(queryId).toBeGreaterThan(0n);
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_PENDING);
    expect(sim.balance(contractId(SLOT))).toBe(999_990n);
    expect(sim.resolveOracle(queryId, priceReply(42n, 1n))).toBe(true);
    // the reply is committed on arrival and revealed on the next tick, as a node's reveal transaction does it.
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_COMMITTED);
    expect(last(sim).status).toBe(Number(OQ_UNKNOWN));

    sim.advance();
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_SUCCESS);
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
    sim.setOracleProvider((interfaceIndex) => (interfaceIndex === 0 ? priceReply(100n, 3n) : null));
    const queryId = readInt64LE(sim.procedure(SLOT, QUERY, priceInput(60_000)));

    // one tick to answer the query, the next to reveal the reply and notify the contract.
    sim.advance();
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_COMMITTED);
    sim.advance();
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(queryId)))).toBe(OQ_SUCCESS);
    expect(last(sim).numerator).toBe(100n);
});

test("Price subscription uses whole-minute periods and charges once", async () => {
    const sim = await deployProbe();
    const timestamps: bigint[] = [];
    sim.setOracleProvider((_interfaceIndex, query) => {
        timestamps.push(new DataView(query.buffer, query.byteOffset, query.byteLength).getBigUint64(32, true));
        return priceReply(7n, 2n);
    });

    const subscriptionId = readInt32LE(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_000)));
    expect(subscriptionId).toBeGreaterThanOrEqual(0);
    expect(sim.balance(contractId(SLOT))).toBe(990_000n);

    sim.advance();
    sim.advance();
    sim.advance();
    expect(timestamps).toHaveLength(3);
    expect(new Set(timestamps).size).toBe(3);
    expect(sim.balance(contractId(SLOT))).toBe(990_000n);
    expect(last(sim).numerator).toBe(7n);
});

test("invalid Price subscription periods are refused with the fee handed back", async () => {
    const sim = await deployProbe();

    expect(readInt32LE(sim.procedure(SLOT, SUBSCRIBE, priceInput(59_000)))).toBe(-1);
    expect(readInt32LE(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_001)))).toBe(-1);
    expect(sim.balance(contractId(SLOT))).toBe(1_000_000n);
    expect(last(sim).status).toBe(Number(OQ_UNKNOWN));
});

test("unsubscribe stops future Price subscription queries", async () => {
    const sim = await deployProbe();
    let calls = 0;
    sim.setOracleProvider(() => {
        calls++;
        return priceReply(5n, 1n);
    });
    const subscriptionId = readInt32LE(sim.procedure(SLOT, SUBSCRIBE, priceInput(60_000)));

    expect(readInt32LE(sim.procedure(SLOT, UNSUBSCRIBE, subscriptionInput(subscriptionId)))).toBe(1);
    sim.advance();
    sim.advance();
    sim.advance();
    expect(calls).toBe(1);
});

test("unknown query ids stay UNKNOWN", async () => {
    const sim = await deployProbe();
    expect(readUint64LE(sim.query(SLOT, STATUS, statusInput(424242n)))).toBe(OQ_UNKNOWN);
    expect(sim.resolveOracle(424242n, priceReply(1n, 1n))).toBe(false);
});

const INLINE_QUERY = 2;
const INLINE_LAST = 1;

function inlineLast(sim: QubicSimulator) {
    const bytes = sim.query(SLOT, INLINE_LAST);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
        notifications: view.getBigUint64(0, true),
        seenInsideCall: view.getBigUint64(8, true),
        queryId: view.getBigInt64(16, true),
        subscriptionId: view.getInt32(24, true),
    };
}

function inlineQuery(sim: QubicSimulator) {
    const output = sim.procedure(SLOT, INLINE_QUERY, priceInput(60_000));
    const view = new DataView(output.buffer, output.byteOffset, output.byteLength);
    return { queryId: view.getBigInt64(0, true), notificationsAfter: view.getBigUint64(8, true), seenInsideCall: view.getBigUint64(16, true) };
}

// core notifies about a query it could not start before QUERY_ORACLE returns, so the contract sees its own notification inside the call.
for (const fees of ["off", "metered"] as const) {
    test(`a query the contract cannot pay for notifies inside the call (fees ${fees})`, async () => {
        await initK12();
        const sim = new QubicSimulator({ fees });
        sim.deploy(SLOT, await wasm("OracleInline"));

        expect(inlineQuery(sim)).toEqual({ queryId: -1n, notificationsAfter: 1n, seenInsideCall: 1n });
        expect(inlineLast(sim)).toEqual({ notifications: 1n, seenInsideCall: 1n, queryId: -1n, subscriptionId: -1 });

        // nothing was left queued for the next tick.
        sim.advance();
        expect(inlineLast(sim).notifications).toBe(1n);
    });
}

test("the inline notification agrees with a whole-state diff of the call that raised it", async () => {
    await initK12();
    const saved = process.env.QINIT_STATE_DIFF;
    process.env.QINIT_STATE_DIFF = "verify";
    try {
        const sim = new QubicSimulator();
        sim.deploy(SLOT, await wasm("OracleInline"));
        sim.setDebug(true);

        expect(inlineQuery(sim).seenInsideCall).toBe(1n);
    } finally {
        if (saved === undefined) {
            delete process.env.QINIT_STATE_DIFF;
        } else {
            process.env.QINIT_STATE_DIFF = saved;
        }
    }
});

test("a reply still arrives a tick after it is committed, never inside the call", async () => {
    await initK12();
    const sim = new QubicSimulator();
    sim.tickDuration = 60_000;
    sim.deploy(SLOT, await wasm("OracleInline"));
    sim.fund(contractId(SLOT), 1_000_000n);

    const started = inlineQuery(sim);
    expect(started.queryId).toBeGreaterThan(0n);
    expect(started).toMatchObject({ notificationsAfter: 0n, seenInsideCall: 0n });

    expect(sim.resolveOracle(started.queryId, priceReply(42n, 1n))).toBe(true);
    expect(inlineLast(sim).notifications).toBe(0n);

    sim.advance();
    expect(inlineLast(sim)).toEqual({ notifications: 1n, seenInsideCall: 0n, queryId: started.queryId, subscriptionId: -1 });
});
