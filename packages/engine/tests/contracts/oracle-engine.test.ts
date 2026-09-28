// core's test/oracle_engine.cpp scenarios against the engine port, step for step, plus what only the simulator can meet: tick 0.
import { beforeAll, expect, test } from "bun:test";
import {
    MAX_INPUT_SIZE,
    ORACLE_FLAG_BAD_SIZE_REPLY,
    ORACLE_FLAG_FAKE_COMMITS,
    ORACLE_FLAG_OM_DISAGREE,
    ORACLE_FLAG_ORACLE_UNAVAIL,
    ORACLE_FLAG_REPLY_RECEIVED,
    ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION,
    TXS_PER_TICK,
} from "@qinit/proto";
import { OracleEngine, ORACLE_STATUS, packTimestamp, type OracleEngineHost } from "../../src/chain/oracle-engine";
import { OracleQuery as MockOracleQuery, OracleReply as MockOracleReply } from "../../src/oracle-interfaces/mock";
import { OracleQuery as PriceOracleQuery, OracleReply as PriceOracleReply } from "../../src/oracle-interfaces/price";
import {
    OracleMachineReply,
    OracleNotificationInput,
    OracleReplyCommitTransactionItem,
    OracleReplyCommitTransactionPrefix,
    OracleReplyRevealTransactionPrefix,
    SIG_SIZE,
    Transaction,
} from "../../src/protocol/wire";
import { initK12, toHex } from "../../src/support/k12";

const NUMBER_OF_COMPUTORS = 676;
const QUORUM = 451;
const UINT32_MAX = 0xffffffff;
const MAX_TRANSACTION_SIZE = MAX_INPUT_SIZE + Transaction.HEADER_SIZE + SIG_SIZE;
const PRICE_INTERFACE_INDEX = 0;
const MOCK_INTERFACE_INDEX = 1;
const NOTIFICATION_PROC_ID = 12345;
const MINUTE = 60_000;

const QX_CONTRACT_INDEX = 1;
const QUOTTERY_CONTRACT_INDEX = 2;
const RANDOM_CONTRACT_INDEX = 3;
const QUTIL_CONTRACT_INDEX = 4;
const SWATCH_CONTRACT_INDEX = 7;
const CCF_CONTRACT_INDEX = 8;
const QEARN_CONTRACT_INDEX = 9;
const MSVAULT_CONTRACT_INDEX = 11;
const QBAY_CONTRACT_INDEX = 12;

beforeAll(async () => {
    await initK12();
});

function m256i(lane0: number, lane1: number, lane2: number, lane3: number): Uint8Array {
    const bytes = new Uint8Array(32);
    const view = new DataView(bytes.buffer);
    [lane0, lane1, lane2, lane3].forEach((lane, index) => view.setBigUint64(index * 8, BigInt(lane), true));
    return bytes;
}

// what core's engines read from globals, so the engines of one test share it.
class OracleEngineTest {
    tick = 1000;
    clock = Date.UTC(2025, 11, 15, 16, 51, 12);
    numberOfComputors = NUMBER_OF_COMPUTORS;
    quorum = QUORUM;
    readonly publicKeys = Array.from({ length: NUMBER_OF_COMPUTORS }, (_unused, computorIndex) => m256i(computorIndex * 2, 42, 13, 1337));
    readonly log: { type: number; message: Uint8Array }[] = [];
    private readonly computorIndices = new Map(this.publicKeys.map((publicKey, computorIndex) => [toHex(publicKey), computorIndex]));

    host(): OracleEngineHost {
        return {
            nowMs: () => this.clock,
            currentTick: () => this.tick,
            numberOfComputors: () => this.numberOfComputors,
            quorum: () => this.quorum,
            computorPublicKey: (computorIdx) => this.publicKeys[computorIdx],
            computorIndex: (publicKey) => this.computorIndices.get(toHex(publicKey)) ?? -1,
            log: (type, message) => this.log.push({ type, message: message.slice() }),
        };
    }

    advanceTimeAndTick(milliseconds: number): void {
        this.clock += milliseconds;
        ++this.tick;
    }

    contractOracleQueryId(tick: number, indexInTick: number): bigint {
        return (BigInt(tick) << 31n) | BigInt(indexInTick + TXS_PER_TICK);
    }
}

// one node of the network: it only signs for its own computors.
class OracleEngineOfNode extends OracleEngine {
    constructor(
        test: OracleEngineTest,
        private readonly ownComputorIdsBegin: number,
        private readonly ownComputorIdsEnd: number,
    ) {
        super(test.host());
    }

    override getReplyCommitTransaction(txBuffer: Uint8Array, computorIdx: number, txScheduleTick: number, startIdx = 0): number {
        expect(computorIdx).toBeGreaterThanOrEqual(this.ownComputorIdsBegin);
        expect(computorIdx).toBeLessThan(this.ownComputorIdsEnd);
        return super.getReplyCommitTransaction(txBuffer, computorIdx, txScheduleTick, startIdx);
    }

    checkPendingState(queryId: bigint, totalCommitTxExecuted: number, ownCommitTxExecuted: number, expectedStatus: number): void {
        const oqm = this.queries[this.queryIdToIndex.get(queryId)!];
        const replyState = this.replyStates[oqm.statusVar.pending!.replyStateIndex]!;
        let executed = 0;
        for (let computorIdx = this.ownComputorIdsBegin; computorIdx < this.ownComputorIdsEnd; ++computorIdx) {
            if (replyState.replyCommitTicks[computorIdx]) {
                ++executed;
            }
        }

        expect([oqm.status, replyState.totalCommits, executed]).toEqual([expectedStatus, totalCommitTxExecuted, ownCommitTxExecuted]);
        expect(this.getOracleQueryStatus(queryId)).toBe(expectedStatus);
    }

    checkStatus(queryId: bigint, expectedStatus: number): void {
        expect(this.queries[this.queryIdToIndex.get(queryId)!].status).toBe(expectedStatus);
    }

    getQueryCount(): number {
        return this.queries.length;
    }

    failureOf(queryId: bigint): { totalCommits: number; agreeingCommits: number } | undefined {
        return this.queries[this.queryIdToIndex.get(queryId)!].statusVar.failure;
    }

    // the subscribers of a subscription in list order, as contract indices
    subscriberContracts(subscriptionId: number): number[] {
        const contracts: number[] = [];
        for (let index = this.subscriptions[subscriptionId].firstSubscriberIndex; index >= 0; index = this.subscribers[index].nextSubscriberIdx) {
            contracts.push(this.subscribers[index].contractIndex);
        }
        return contracts;
    }

    expectPriceSubscriptionQuery(queryIndex: number, queryTime: number, subscriptionId: number, notifiedContractIndices: number[], initialQuery: Uint8Array): bigint {
        const oqm = this.queries[queryIndex];
        expect([oqm.interfaceIndex, oqm.type]).toEqual([PRICE_INTERFACE_INDEX, ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION]);
        expect(oqm.typeVar.subscription).toMatchObject({ subscriptionId, subscriberCount: notifiedContractIndices.length });

        const expectedQuery = PriceOracleQuery.wrap(initialQuery.slice());
        expectedQuery.timestamp = packTimestamp(queryTime);
        const query = new Uint8Array(PriceOracleQuery.SIZE);
        expect(this.getOracleQuery(oqm.queryId, query)).toBe(true);
        expect(toHex(query)).toBe(toHex(expectedQuery.bytes));

        const notifiedContracts = this.getNotifiedSubscriberIndices(oqm).map((subscriberIdx) => {
            expect(this.subscribers[subscriberIdx].subscriptionId).toBe(subscriptionId);
            return this.subscribers[subscriberIdx].contractIndex;
        });
        expect(notifiedContracts.sort()).toEqual([...notifiedContractIndices].sort());
        expect(this.subscriptions[subscriptionId].interfaceIndex).toBe(PRICE_INTERFACE_INDEX);
        return oqm.queryId;
    }

    expectPriceNotification(contractIndex: number, queryId: bigint, status: number, subscriptionId = -1, numerator = 0n, denominator = 0n): void {
        this.expectPriceNotifications([contractIndex], queryId, status, subscriptionId, numerator, denominator);
    }

    expectPriceNotifications(contractIndices: number[], queryId: bigint, status: number, subscriptionId = -1, numerator = 0n, denominator = 0n): void {
        const notifiedContracts: number[] = [];
        for (let count = 0; count < contractIndices.length; ++count) {
            const notification = this.getNotification()!;
            expect(notification).not.toBeNull();
            expect([notification.procedureId, notification.inputSize]).toEqual([NOTIFICATION_PROC_ID, OracleNotificationInput.SIZE + PriceOracleReply.SIZE]);

            const input = OracleNotificationInput.wrap(notification.inputBuffer);
            const reply = PriceOracleReply.wrap(notification.inputBuffer, OracleNotificationInput.SIZE);
            expect([input.queryId, input.subscriptionId, input.status]).toEqual([queryId, subscriptionId, status]);
            expect([reply.numerator, reply.denominator]).toEqual([numerator, denominator]);
            notifiedContracts.push(notification.contractIndex);
        }
        expect(notifiedContracts.sort()).toEqual([...contractIndices].sort());
    }
}

function priceQuery(oracle: Uint8Array, currency1: Uint8Array, currency2: Uint8Array, timestamp: number): Uint8Array {
    const query = PriceOracleQuery.alloc();
    query.oracle = oracle;
    query.timestamp = packTimestamp(timestamp);
    query.currency1 = currency1;
    query.currency2 = currency2;
    return query.bytes;
}

function oracleMachineReply(queryId: bigint, reply: Uint8Array, oracleMachineErrorFlags = 0): Uint8Array {
    const message = new Uint8Array(OracleMachineReply.SIZE + reply.length);
    const metadata = OracleMachineReply.wrap(message);
    metadata.oracleQueryId = BigInt.asUintN(64, queryId);
    metadata.oracleMachineErrorFlags = oracleMachineErrorFlags;
    message.set(reply, OracleMachineReply.SIZE);
    return message;
}

function priceReply(numerator: bigint, denominator: bigint): Uint8Array {
    const reply = PriceOracleReply.alloc();
    reply.numerator = numerator;
    reply.denominator = denominator;
    return reply.bytes;
}

function revealQueryId(txBuffer: Uint8Array): bigint {
    return new DataView(txBuffer.buffer, txBuffer.byteOffset).getBigInt64(Transaction.HEADER_SIZE, true);
}

// one node holds every computor: all of them commit, then the reply is revealed in the scheduled tick.
function commitAndReveal(test: OracleEngineTest, engine: OracleEngine, txSlotInTickData = 0): void {
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    const transactions: Uint8Array[] = [];
    for (let computorIdx = 0; computorIdx < test.numberOfComputors; ++computorIdx) {
        let startIdx = 0;
        do {
            startIdx = engine.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 1, startIdx);
            if (startIdx) {
                transactions.push(txBuffer.slice());
            }
        } while (startIdx && startIdx !== UINT32_MAX);
    }

    ++test.tick;
    for (const transaction of transactions) {
        expect(engine.processOracleReplyCommitTransaction(transaction)).toBe(true);
    }

    const reveals: Uint8Array[] = [];
    for (let startIdx = engine.getReplyRevealTransaction(txBuffer, 0, test.tick + 1, 0); startIdx; startIdx = engine.getReplyRevealTransaction(txBuffer, 0, test.tick + 1, startIdx)) {
        reveals.push(txBuffer.slice());
    }

    ++test.tick;
    for (const reveal of reveals) {
        expect(engine.processOracleReplyRevealTransaction(reveal, txSlotInTickData++)).toBe(true);
    }
}

test("ContractQuerySuccess", () => {
    const test = new OracleEngineTest();

    // three nodes: one with 400 computor ids, one with 200, one with 76
    const allCompPubKeys = test.publicKeys;
    const oracleEngine1 = new OracleEngineOfNode(test, 0, 400);
    const oracleEngine2 = new OracleEngineOfNode(test, 400, 600);
    const oracleEngine3 = new OracleEngineOfNode(test, 600, 676);
    const engines = [oracleEngine1, oracleEngine2, oracleEngine3];

    const query = priceQuery(m256i(1, 2, 3, 4), m256i(2, 3, 4, 5), m256i(3, 4, 5, 6), test.clock);
    const contractIndex = 1;
    const timeout = 30000;

    const queryId = oracleEngine1.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, timeout, NOTIFICATION_PROC_ID);
    expect(queryId).toBe(test.contractOracleQueryId(test.tick, 0));
    expect(oracleEngine2.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, timeout, NOTIFICATION_PROC_ID)).toBe(queryId);
    expect(oracleEngine3.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, timeout, NOTIFICATION_PROC_ID)).toBe(queryId);

    const queryReturned = new Uint8Array(PriceOracleQuery.SIZE);
    expect(oracleEngine1.getOracleQuery(queryId, queryReturned)).toBe(true);
    expect(toHex(queryReturned)).toBe(toHex(query));

    const reply = oracleMachineReply(queryId, priceReply(1234n, 1n));
    engines.forEach((engine) => engine.processOracleMachineReply(reply));

    // a duplicate changes nothing, another value from another oracle machine is flagged
    oracleEngine1.processOracleMachineReply(reply);
    expect(oracleEngine1.getOracleQueryStatusFlags(queryId)).toBe(ORACLE_FLAG_REPLY_RECEIVED);
    oracleEngine1.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1233n, 1n)));
    expect(oracleEngine1.getOracleQueryStatusFlags(queryId)).toBe(ORACLE_FLAG_REPLY_RECEIVED | ORACLE_FLAG_OM_DISAGREE);

    // commit transaction of computor 0
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    const replyCommitTx = Transaction.wrap(txBuffer);
    expect(oracleEngine1.getReplyCommitTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(UINT32_MAX);
    expect(replyCommitTx.inputType).toBe(OracleReplyCommitTransactionPrefix.transactionType);
    expect(toHex(replyCommitTx.sourcePublicKey.bytes)).toBe(toHex(allCompPubKeys[0]));
    expect(replyCommitTx.destinationPublicKey.bytes.every((byte) => byte === 0)).toBe(true);
    expect(replyCommitTx.tick).toBe(test.tick + 3);
    expect(replyCommitTx.inputSize).toBe(OracleReplyCommitTransactionItem.SIZE);

    // second call in the same tick: no commits for the transaction
    expect(oracleEngine1.getReplyCommitTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(0);

    test.tick += 3;
    engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));

    // no reveal and no notification yet
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(0);
    expect(oracleEngine1.getNotification()).toBeNull();

    // the computors of node 3, processed by all nodes
    for (let computorIdx = 600; computorIdx < 676; ++computorIdx) {
        expect(oracleEngine3.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 3, 0)).toBe(UINT32_MAX);
        expect(toHex(replyCommitTx.sourcePublicKey.bytes)).toBe(toHex(allCompPubKeys[computorIdx]));
        const txFromNode3 = computorIdx - 600;
        oracleEngine1.checkPendingState(queryId, txFromNode3 + 1, 1, ORACLE_STATUS.PENDING);
        expect(oracleEngine1.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
        oracleEngine1.checkPendingState(queryId, txFromNode3 + 2, 1, ORACLE_STATUS.PENDING);
        oracleEngine2.checkPendingState(queryId, txFromNode3 + 1, 0, ORACLE_STATUS.PENDING);
        expect(oracleEngine2.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
        oracleEngine2.checkPendingState(queryId, txFromNode3 + 2, 0, ORACLE_STATUS.PENDING);
        oracleEngine3.checkPendingState(queryId, txFromNode3 + 1, txFromNode3, ORACLE_STATUS.PENDING);
        expect(oracleEngine3.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
        oracleEngine3.checkPendingState(queryId, txFromNode3 + 2, txFromNode3 + 1, ORACLE_STATUS.PENDING);
    }

    // the computors of node 2
    for (let computorIdx = 400; computorIdx < 600; ++computorIdx) {
        expect(oracleEngine2.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 3, 0)).toBe(UINT32_MAX);
        const txFromNode2 = computorIdx - 400;
        oracleEngine1.checkPendingState(queryId, txFromNode2 + 77, 1, ORACLE_STATUS.PENDING);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine1.checkPendingState(queryId, txFromNode2 + 78, 1, ORACLE_STATUS.PENDING);
        oracleEngine2.checkPendingState(queryId, txFromNode2 + 78, txFromNode2 + 1, ORACLE_STATUS.PENDING);
        oracleEngine3.checkPendingState(queryId, txFromNode2 + 78, 76, ORACLE_STATUS.PENDING);
    }

    // the computors of node 1, until the quorum stands
    for (let computorIdx = 1; computorIdx < 400; ++computorIdx) {
        const expectStatusCommitted = computorIdx + 276 >= QUORUM;
        expect(oracleEngine1.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 3, 0)).toBe(expectStatusCommitted ? 0 : UINT32_MAX);
        if (expectStatusCommitted) {
            oracleEngine1.checkPendingState(queryId, 451, 175, ORACLE_STATUS.COMMITTED);
            oracleEngine2.checkPendingState(queryId, 451, 200, ORACLE_STATUS.COMMITTED);
            oracleEngine3.checkPendingState(queryId, 451, 76, ORACLE_STATUS.COMMITTED);
            continue;
        }

        const newStatus = computorIdx + 276 < 450 ? ORACLE_STATUS.PENDING : ORACLE_STATUS.COMMITTED;
        oracleEngine1.checkPendingState(queryId, computorIdx + 276, computorIdx, ORACLE_STATUS.PENDING);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine1.checkPendingState(queryId, computorIdx + 277, computorIdx + 1, newStatus);
        oracleEngine2.checkPendingState(queryId, computorIdx + 277, 200, newStatus);
        oracleEngine3.checkPendingState(queryId, computorIdx + 277, 76, newStatus);
    }

    // one reveal transaction, and not the same one again
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(1);
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 1)).toBe(0);
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(0);
    expect(Transaction.wrap(txBuffer).inputType).toBe(OracleReplyRevealTransactionPrefix.transactionType);

    test.tick += 3;
    expect(oracleEngine1.processOracleReplyRevealTransaction(txBuffer, 10)).toBe(true);

    oracleEngine1.expectPriceNotification(contractIndex, revealQueryId(txBuffer), ORACLE_STATUS.SUCCESS, -1, 1234n, 1n);
    expect(oracleEngine1.getNotification()).toBeNull();
    expect(oracleEngine1.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.SUCCESS);

    const replyReturned = PriceOracleReply.alloc();
    expect(oracleEngine1.getOracleReply(queryId, replyReturned.bytes)).toBe(true);
    expect([replyReturned.numerator, replyReturned.denominator]).toEqual([1234n, 1n]);

    // node 2 did not process the reveal: no success, no reply
    expect(oracleEngine2.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.COMMITTED);
    expect(oracleEngine2.getOracleReply(queryId, replyReturned.bytes)).toBe(false);

    engines.forEach((engine) => engine.checkStateConsistencyWithAssert());
});

test("ContractQueryUnresolvable", () => {
    // two nodes commit 200 times each to one digest, the third commits to another: no quorum can form
    const test = new OracleEngineTest();
    const oracleEngine1 = new OracleEngineOfNode(test, 0, 200);
    const oracleEngine2 = new OracleEngineOfNode(test, 200, 400);
    const oracleEngine3 = new OracleEngineOfNode(test, 400, 676);
    const engines = [oracleEngine1, oracleEngine2, oracleEngine3];

    const query = priceQuery(m256i(10, 20, 30, 40), m256i(20, 30, 40, 50), m256i(30, 40, 50, 60), test.clock);
    const contractIndex = 2;
    const queryId = oracleEngine1.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID);
    expect(queryId).toBe(test.contractOracleQueryId(test.tick, 0));
    expect(oracleEngine2.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID)).toBe(queryId);
    expect(oracleEngine3.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID)).toBe(queryId);

    oracleEngine1.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1234n, 1n)));
    oracleEngine2.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1234n, 1n)));
    oracleEngine3.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1233n, 1n)));

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    for (let ownCompIdx = 0; ownCompIdx < 200; ++ownCompIdx) {
        expect(oracleEngine1.getReplyCommitTransaction(txBuffer, ownCompIdx, test.tick + 3, 0)).toBe(UINT32_MAX);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine1.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx + 1, ORACLE_STATUS.PENDING);
        oracleEngine2.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx, ORACLE_STATUS.PENDING);
        oracleEngine3.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx, ORACLE_STATUS.PENDING);

        expect(oracleEngine2.getReplyCommitTransaction(txBuffer, ownCompIdx + 200, test.tick + 3, 0)).toBe(UINT32_MAX);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine2.checkPendingState(queryId, 3 * ownCompIdx + 2, ownCompIdx + 1, ORACLE_STATUS.PENDING);

        expect(oracleEngine3.getReplyCommitTransaction(txBuffer, ownCompIdx + 400, test.tick + 3, 0)).toBe(UINT32_MAX);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine3.checkPendingState(queryId, 3 * ownCompIdx + 3, ownCompIdx + 1, ORACLE_STATUS.PENDING);
    }

    // commits that contradict the majority digest turn the query unresolvable
    for (let allCompIdx = 600; allCompIdx < 676; ++allCompIdx) {
        const unknownVotes = 676 - allCompIdx;
        const moreTxExpected = unknownVotes > 450 - 400;
        expect(oracleEngine3.getReplyCommitTransaction(txBuffer, allCompIdx, test.tick + 3, 0)).toBe(moreTxExpected ? UINT32_MAX : 0);
        if (moreTxExpected) {
            engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        }

        if (unknownVotes > 451 - 400) {
            oracleEngine1.checkPendingState(queryId, allCompIdx + 1, 200, ORACLE_STATUS.PENDING);
            oracleEngine2.checkPendingState(queryId, allCompIdx + 1, 200, ORACLE_STATUS.PENDING);
            oracleEngine3.checkPendingState(queryId, allCompIdx + 1, allCompIdx - 400 + 1, ORACLE_STATUS.PENDING);
        } else {
            engines.forEach((engine) => engine.checkStatus(queryId, ORACLE_STATUS.UNRESOLVABLE));
        }
    }
    expect(oracleEngine1.failureOf(queryId)).toEqual({ agreeingCommits: 400, totalCommits: 626 });

    oracleEngine1.expectPriceNotification(contractIndex, queryId, ORACLE_STATUS.UNRESOLVABLE);
    expect(oracleEngine1.getNotification()).toBeNull();
    expect(oracleEngine1.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.UNRESOLVABLE);

    engines.forEach((engine) => engine.checkStateConsistencyWithAssert());
});

test("ContractQueryWrongKnowledgeProof", () => {
    // 451 commits agree on the digest, but 150 of them carry a wrong knowledge proof: the reveal exposes them
    const test = new OracleEngineTest();
    const oracleEngine1 = new OracleEngineOfNode(test, 0, 200);
    const oracleEngine2 = new OracleEngineOfNode(test, 200, 400);
    const oracleEngine3 = new OracleEngineOfNode(test, 400, 676);
    const engines = [oracleEngine1, oracleEngine2, oracleEngine3];

    const query = priceQuery(m256i(10, 20, 30, 40), m256i(20, 30, 40, 50), m256i(30, 40, 50, 60), test.clock);
    const contractIndex = 2;
    const queryId = oracleEngine1.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID);
    expect(oracleEngine2.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID)).toBe(queryId);
    expect(oracleEngine3.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 120000, NOTIFICATION_PROC_ID)).toBe(queryId);
    engines.forEach((engine) => engine.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1234n, 1n))));

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    const txView = new DataView(txBuffer.buffer);
    for (let ownCompIdx = 0; ownCompIdx < 200; ++ownCompIdx) {
        expect(oracleEngine1.getReplyCommitTransaction(txBuffer, ownCompIdx, test.tick + 3, 0)).toBe(UINT32_MAX);
        const expectedStatus = 3 * ownCompIdx + 1 < QUORUM ? ORACLE_STATUS.PENDING : ORACLE_STATUS.COMMITTED;
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine1.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx + 1, expectedStatus);
        oracleEngine2.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx, expectedStatus);
        oracleEngine3.checkPendingState(queryId, 3 * ownCompIdx + 1, ownCompIdx, expectedStatus);

        if (3 * ownCompIdx + 1 === QUORUM) {
            // a committed query asks for no more commits
            expect(oracleEngine2.getReplyCommitTransaction(txBuffer, ownCompIdx + 200, test.tick + 3, 0)).toBe(0);
            expect(oracleEngine3.getReplyCommitTransaction(txBuffer, ownCompIdx + 400, test.tick + 3, 0)).toBe(0);
            break;
        }

        expect(oracleEngine2.getReplyCommitTransaction(txBuffer, ownCompIdx + 200, test.tick + 3, 0)).toBe(UINT32_MAX);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine2.checkPendingState(queryId, 3 * ownCompIdx + 2, ownCompIdx + 1, ORACLE_STATUS.PENDING);

        // computors 400-600 echo the digest of others without knowing the reply
        expect(oracleEngine3.getReplyCommitTransaction(txBuffer, ownCompIdx + 400, test.tick + 3, 0)).toBe(UINT32_MAX);
        const proofLane = Transaction.HEADER_SIZE + OracleReplyCommitTransactionItem.OFFSETS.replyKnowledgeProof + 24;
        txView.setBigUint64(proofLane, BigInt.asUintN(64, txView.getBigUint64(proofLane, true) + 2n), true);
        engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(txBuffer)).toBe(true));
        oracleEngine3.checkPendingState(queryId, 3 * ownCompIdx + 3, ownCompIdx + 1, ORACLE_STATUS.PENDING);
    }

    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(1);
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 1)).toBe(0);
    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(0);
    expect(oracleEngine1.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.COMMITTED);

    test.tick += 3;
    expect(oracleEngine1.processOracleReplyRevealTransaction(txBuffer, 10)).toBe(true);
    expect(oracleEngine1.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.UNRESOLVABLE);
    expect(oracleEngine1.getOracleQueryStatusFlags(queryId) & ORACLE_FLAG_FAKE_COMMITS).toBe(ORACLE_FLAG_FAKE_COMMITS);
    expect(oracleEngine1.failureOf(queryId)).toEqual({ agreeingCommits: 301, totalCommits: 451 });

    oracleEngine1.expectPriceNotification(contractIndex, queryId, ORACLE_STATUS.UNRESOLVABLE);
    expect(oracleEngine1.getNotification()).toBeNull();

    engines.forEach((engine) => engine.checkStateConsistencyWithAssert());
});

test("ContractQueryTimeout", () => {
    const test = new OracleEngineTest();
    const oracleEngine1 = new OracleEngineOfNode(test, 0, 676);

    const query = priceQuery(m256i(10, 20, 30, 40), m256i(20, 30, 40, 50), m256i(30, 40, 50, 60), test.clock);
    const contractIndex = 2;
    const queryId = oracleEngine1.startContractQuery(contractIndex, PRICE_INTERFACE_INDEX, query, 10000, NOTIFICATION_PROC_ID);

    // nothing times out before its time
    oracleEngine1.processTimeouts();
    expect(oracleEngine1.getNotification()).toBeNull();

    // no reply from the oracle machine
    ++test.tick;
    test.clock += 60 * MINUTE;
    oracleEngine1.processTimeouts();

    oracleEngine1.expectPriceNotification(contractIndex, queryId, ORACLE_STATUS.TIMEOUT);
    expect(oracleEngine1.getNotification()).toBeNull();
    expect(oracleEngine1.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.TIMEOUT);

    oracleEngine1.checkStateConsistencyWithAssert();
});

// every pending commit of a node's computors is offered, except for the query the node got no reply for.
function checkReplyCommitTransactions(
    test: OracleEngineTest,
    oracleEngine: OracleEngineOfNode,
    globalCompIdxBegin: number,
    globalCompIdxEnd: number,
    queryIds: bigint[],
    queryIdWithoutReply: bigint,
): void {
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    for (let globalCompIdx = globalCompIdxBegin; globalCompIdx < globalCompIdxEnd; ++globalCompIdx) {
        const pendingCommitQueryIds = new Set(queryIds);
        let retCode = 0;
        do {
            retCode = oracleEngine.getReplyCommitTransaction(txBuffer, globalCompIdx, test.tick + 3, retCode);
            if (!retCode) {
                break;
            }

            const commitCount = Transaction.wrap(txBuffer).inputSize / OracleReplyCommitTransactionItem.SIZE;
            for (let index = 0; index < commitCount; ++index) {
                const commit = OracleReplyCommitTransactionItem.wrap(txBuffer, Transaction.HEADER_SIZE + index * OracleReplyCommitTransactionItem.SIZE);
                pendingCommitQueryIds.delete(BigInt.asIntN(64, commit.queryId));
            }
        } while (retCode !== UINT32_MAX);

        expect([...pendingCommitQueryIds]).toEqual([queryIdWithoutReply]);
    }
}

test("MultiContractQuerySuccess", () => {
    const test = new OracleEngineTest();

    // three nodes: one with 350 computor ids, one with 250, one with 76
    const oracleEngine1 = new OracleEngineOfNode(test, 0, 350);
    const oracleEngine2 = new OracleEngineOfNode(test, 350, 600);
    const oracleEngine3 = new OracleEngineOfNode(test, 600, 676);
    const engines = [oracleEngine1, oracleEngine2, oracleEngine3];

    const contractIndex = 4;
    const timeout = 50000;
    const queryCount = 25;

    const queryIds: bigint[] = [];
    for (let index = 0; index < queryCount; ++index) {
        const mockQuery = MockOracleQuery.alloc();
        mockQuery.value = BigInt(index + 1000);
        const queryId = oracleEngine1.startContractQuery(contractIndex, MOCK_INTERFACE_INDEX, mockQuery.bytes, timeout, NOTIFICATION_PROC_ID);
        expect(queryId).toBe(test.contractOracleQueryId(test.tick, index));
        expect(oracleEngine2.startContractQuery(contractIndex, MOCK_INTERFACE_INDEX, mockQuery.bytes, timeout, NOTIFICATION_PROC_ID)).toBe(queryId);
        expect(oracleEngine3.startContractQuery(contractIndex, MOCK_INTERFACE_INDEX, mockQuery.bytes, timeout, NOTIFICATION_PROC_ID)).toBe(queryId);

        const mockQueryReturned = MockOracleQuery.alloc();
        expect(oracleEngine1.getOracleQuery(queryId, mockQueryReturned.bytes)).toBe(true);
        expect(mockQueryReturned.value).toBe(mockQuery.value);
        queryIds.push(queryId);
    }

    // each node misses the oracle machine reply of one of the first three queries
    for (let index = 0; index < queryCount; ++index) {
        const mockReply = MockOracleReply.alloc();
        mockReply.echoedValue = BigInt(1000 + index);
        mockReply.doubledValue = BigInt((1000 + index) * 2);
        const message = oracleMachineReply(queryIds[index], mockReply.bytes);
        engines.forEach((engine, engineIndex) => {
            if (index !== engineIndex) {
                engine.processOracleMachineReply(message);
            }
        });
    }

    checkReplyCommitTransactions(test, oracleEngine1, 0, 350, queryIds, queryIds[0]);
    checkReplyCommitTransactions(test, oracleEngine2, 350, 600, queryIds, queryIds[1]);
    checkReplyCommitTransactions(test, oracleEngine3, 600, 676, queryIds, queryIds[2]);

    // a few ticks later the commits are offered again, this time to be processed
    test.tick += 5;

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    const globalCompIdxBeginEnd = [0, 350, 600, 676];
    const commitTxsOfTick: Uint8Array[][] = [];
    engines.forEach((engine, engineIndex) => {
        const commitTxs: Uint8Array[] = [];
        for (let globalCompIdx = globalCompIdxBeginEnd[engineIndex]; globalCompIdx < globalCompIdxBeginEnd[engineIndex + 1]; ++globalCompIdx) {
            let retCode = 0;
            do {
                retCode = engine.getReplyCommitTransaction(txBuffer, globalCompIdx, test.tick + 3, retCode);
                if (!retCode) {
                    break;
                }
                commitTxs.push(txBuffer.slice());
            } while (retCode !== UINT32_MAX);
        }

        // each node sends its transactions in a different tick
        commitTxsOfTick.push(commitTxs);
        ++test.tick;
    });

    // 24 commits per computor make two transactions: 14 and 10
    expect(commitTxsOfTick.map((commitTxs) => commitTxs.length)).toEqual([350 * 2, 250 * 2, 76 * 2]);
    for (const commitTxs of commitTxsOfTick) {
        for (const commitTx of commitTxs) {
            engines.forEach((engine) => expect(engine.processOracleReplyCommitTransaction(commitTx)).toBe(true));
        }
        ++test.tick;
    }

    oracleEngine1.checkPendingState(queryIds[0], 326, 0, ORACLE_STATUS.PENDING);
    oracleEngine2.checkPendingState(queryIds[0], 326, 250, ORACLE_STATUS.PENDING);
    oracleEngine3.checkPendingState(queryIds[0], 326, 76, ORACLE_STATUS.PENDING);

    oracleEngine1.checkPendingState(queryIds[1], 426, 350, ORACLE_STATUS.PENDING);
    oracleEngine2.checkPendingState(queryIds[1], 426, 0, ORACLE_STATUS.PENDING);
    oracleEngine3.checkPendingState(queryIds[1], 426, 76, ORACLE_STATUS.PENDING);

    oracleEngine1.checkPendingState(queryIds[2], 600, 350, ORACLE_STATUS.COMMITTED);
    oracleEngine2.checkPendingState(queryIds[2], 600, 250, ORACLE_STATUS.COMMITTED);
    oracleEngine3.checkPendingState(queryIds[2], 600, 0, ORACLE_STATUS.COMMITTED);

    for (let index = 3; index < queryCount; ++index) {
        oracleEngine1.checkPendingState(queryIds[index], 676, 350, ORACLE_STATUS.COMMITTED);
        oracleEngine2.checkPendingState(queryIds[index], 676, 250, ORACLE_STATUS.COMMITTED);
        oracleEngine3.checkPendingState(queryIds[index], 676, 76, ORACLE_STATUS.COMMITTED);
    }

    // node 3 reveals all it can; the others hear of the transactions before they are processed
    const pendingRevealQueryIds = new Set(queryIds.slice(2));
    const revealTxs: Uint8Array[] = [];
    for (let retCode = oracleEngine3.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0); retCode; retCode = oracleEngine3.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, retCode)) {
        engines.forEach((engine) => engine.announceExpectedRevealTransaction(txBuffer));
        revealTxs.push(txBuffer.slice());
    }

    test.tick += 3;
    revealTxs.forEach((revealTx, txIndexInTickData) => {
        pendingRevealQueryIds.delete(revealQueryId(revealTx));
        engines.forEach((engine) => engine.processOracleReplyRevealTransaction(revealTx, txIndexInTickData));
    });

    // node 3 got no reply for query 2, so it cannot reveal it; node 2 can
    expect([...pendingRevealQueryIds]).toEqual([queryIds[2]]);
    expect(oracleEngine2.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(1);
    expect(revealQueryId(txBuffer)).toBe(queryIds[2]);
    expect(oracleEngine2.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 1)).toBe(0);
    test.tick += 3;
    engines.forEach((engine) => engine.processOracleReplyRevealTransaction(txBuffer, revealTxs.length));

    expect(oracleEngine1.getReplyRevealTransaction(txBuffer, 0, test.tick + 3, 0)).toBe(0);

    // notifications come in the order the queries were started
    const notifiedQueryIds: bigint[] = [];
    for (let index = 2; index < queryCount; ++index) {
        const notification = oracleEngine1.getNotification()!;
        expect([notification.contractIndex, notification.procedureId, notification.inputSize]).toEqual([
            contractIndex,
            NOTIFICATION_PROC_ID,
            OracleNotificationInput.SIZE + MockOracleReply.SIZE,
        ]);

        const input = OracleNotificationInput.wrap(notification.inputBuffer);
        const notifiedReply = MockOracleReply.wrap(notification.inputBuffer, OracleNotificationInput.SIZE);
        expect([input.status, input.subscriptionId]).toEqual([ORACLE_STATUS.SUCCESS, -1]);
        expect(oracleEngine1.getOracleQueryStatus(input.queryId)).toBe(ORACLE_STATUS.SUCCESS);

        const mockQuery = MockOracleQuery.alloc();
        expect(oracleEngine1.getOracleQuery(input.queryId, mockQuery.bytes)).toBe(true);
        expect([notifiedReply.echoedValue, notifiedReply.doubledValue]).toEqual([mockQuery.value, mockQuery.value * 2n]);

        const mockReply = MockOracleReply.alloc();
        expect(oracleEngine1.getOracleReply(input.queryId, mockReply.bytes)).toBe(true);
        expect(toHex(mockReply.bytes)).toBe(toHex(notifiedReply.bytes));
        notifiedQueryIds.push(input.queryId);
    }
    expect(notifiedQueryIds).toEqual(queryIds.slice(2));
    expect(oracleEngine1.getNotification()).toBeNull();

    engines.forEach((engine) => engine.checkStateConsistencyWithAssert());
});

test("Subscription", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);

    const timestampOffset = PriceOracleQuery.OFFSETS.timestamp;
    const priceQuery0 = priceQuery(m256i(1, 0, 0, 0), m256i(2, 0, 0, 0), m256i(3, 0, 0, 0), 0);
    const subscribe = (contractIndex: number, query: Uint8Array, minutes: number) =>
        oracleEngine.startContractSubscription(contractIndex, PRICE_INTERFACE_INDEX, query, minutes * MINUTE, NOTIFICATION_PROC_ID, timestampOffset);

    // subscription 0 for QX: t0 + N (each minute)
    const t0 = test.clock;
    const subscriptionId0 = subscribe(QX_CONTRACT_INDEX, priceQuery0, 1);
    expect(subscriptionId0).toBe(0);

    // invalid input
    const start = (contractIndex: number, interfaceIndex: number, query: Uint8Array, periodMillisec: number, offset: number) =>
        oracleEngine.startContractSubscription(contractIndex, interfaceIndex, query, periodMillisec, NOTIFICATION_PROC_ID, offset);
    expect(start(2000, PRICE_INTERFACE_INDEX, priceQuery0, MINUTE, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, 0xffffffff, priceQuery0, MINUTE, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, 1000, priceQuery0, MINUTE, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE + 1), MINUTE, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, priceQuery0, 0, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, priceQuery0, 10, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, priceQuery0, MINUTE + 1, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, priceQuery0, 0xffffffff, timestampOffset)).toBe(-1);
    expect(start(QX_CONTRACT_INDEX, PRICE_INTERFACE_INDEX, priceQuery0, MINUTE, 1024)).toBe(-1);

    // the same subscription from the same contract
    expect(subscribe(QX_CONTRACT_INDEX, priceQuery0, 1)).toBe(-1);

    // subscription 0 for QEARN: t0 + 2 * N, for QUTIL: t0 + 5 * N
    expect(subscribe(QEARN_CONTRACT_INDEX, priceQuery0, 2)).toBe(subscriptionId0);
    expect(subscribe(QUTIL_CONTRACT_INDEX, priceQuery0, 5)).toBe(subscriptionId0);

    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(1);
    const qid0 = oracleEngine.expectPriceSubscriptionQuery(0, t0, subscriptionId0, [QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX, QUTIL_CONTRACT_INDEX], priceQuery0);
    expect(qid0).toBe(test.contractOracleQueryId(test.tick, 0));

    // t1 = t0 + 0.5/60
    test.advanceTimeAndTick(500);
    const t1 = test.clock;

    // subscription 1 for QX: t1 + 10 * N, for RANDOM: t1 + 12 * N
    const priceQuery1 = priceQuery0.slice();
    priceQuery1[0] = 9;
    const subscriptionId1 = subscribe(QX_CONTRACT_INDEX, priceQuery1, 10);
    expect(subscriptionId1).toBe(1);
    expect(subscribe(RANDOM_CONTRACT_INDEX, priceQuery1, 12)).toBe(subscriptionId1);

    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(2);
    const qid1 = oracleEngine.expectPriceSubscriptionQuery(1, t1, subscriptionId1, [QX_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX], priceQuery1);

    // t2 = t1 + 0.4/60
    test.advanceTimeAndTick(400);

    // subscription 1 for QUTIL: t1 + 5 * N, for QUOTTERY: t1 + 3 * N, both synced with the queries that exist
    expect(subscribe(QUTIL_CONTRACT_INDEX, priceQuery1, 5)).toBe(subscriptionId1);
    expect(subscribe(QUOTTERY_CONTRACT_INDEX, priceQuery1, 3)).toBe(subscriptionId1);

    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(2);

    oracleEngine.processTimeouts();
    expect(oracleEngine.getNotification()).toBeNull();

    // t3 = t0 + 1
    test.advanceTimeAndTick(59100);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(3);
    const qid2 = oracleEngine.expectPriceSubscriptionQuery(2, t0 + MINUTE, subscriptionId0, [QX_CONTRACT_INDEX], priceQuery0);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX, QUTIL_CONTRACT_INDEX], qid0, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();

    // t4 = t0 + 2 + 0.1/60
    test.advanceTimeAndTick(60100);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(4);
    const qid3 = oracleEngine.expectPriceSubscriptionQuery(3, t0 + 2 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], priceQuery0);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX], qid1, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX], qid2, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();

    // t5 = t0 + 3 + 1.1/60
    test.advanceTimeAndTick(61000);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(6);
    const qid4 = oracleEngine.expectPriceSubscriptionQuery(4, t0 + 3 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX], priceQuery0);
    const qid5 = oracleEngine.expectPriceSubscriptionQuery(5, t1 + 3 * MINUTE, subscriptionId1, [QUOTTERY_CONTRACT_INDEX], priceQuery1);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], qid3, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();

    // stuck network: t6 = t0 + 5 + 1.1/60, one query of QX is generated and one is skipped
    test.advanceTimeAndTick(120000);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(9);
    const qid6 = oracleEngine.expectPriceSubscriptionQuery(6, t0 + 4 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], priceQuery0);
    const qid7 = oracleEngine.expectPriceSubscriptionQuery(7, t0 + 5 * MINUTE, subscriptionId0, [QUTIL_CONTRACT_INDEX], priceQuery0);
    const qid8 = oracleEngine.expectPriceSubscriptionQuery(8, t1 + 5 * MINUTE, subscriptionId1, [QUTIL_CONTRACT_INDEX], priceQuery1);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX], qid4, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUOTTERY_CONTRACT_INDEX], qid5, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], qid6, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();

    // t7 = t0 + 6 + 0.5/60
    test.advanceTimeAndTick(59400);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(11);
    const qid9 = oracleEngine.expectPriceSubscriptionQuery(9, t0 + 6 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], priceQuery0);
    const qid10 = oracleEngine.expectPriceSubscriptionQuery(10, t1 + 6 * MINUTE, subscriptionId1, [QUOTTERY_CONTRACT_INDEX], priceQuery1);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX], qid7, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX], qid8, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    expect(oracleEngine.getNotification()).toBeNull();

    // stuck network: t8 = t0 + 10 + 0.5/60
    test.advanceTimeAndTick(240000);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(16);
    const qid11 = oracleEngine.expectPriceSubscriptionQuery(11, t0 + 7 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX], priceQuery0);
    const qid12 = oracleEngine.expectPriceSubscriptionQuery(12, t0 + 8 * MINUTE, subscriptionId0, [QEARN_CONTRACT_INDEX], priceQuery0);
    const qid13 = oracleEngine.expectPriceSubscriptionQuery(13, t1 + 9 * MINUTE, subscriptionId1, [QUOTTERY_CONTRACT_INDEX], priceQuery1);
    const qid14 = oracleEngine.expectPriceSubscriptionQuery(14, t0 + 10 * MINUTE, subscriptionId0, [QUTIL_CONTRACT_INDEX], priceQuery0);
    const qid15 = oracleEngine.expectPriceSubscriptionQuery(15, t1 + 10 * MINUTE, subscriptionId1, [QUTIL_CONTRACT_INDEX, QX_CONTRACT_INDEX], priceQuery1);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], qid9, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUOTTERY_CONTRACT_INDEX], qid10, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX], qid11, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QEARN_CONTRACT_INDEX], qid12, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUOTTERY_CONTRACT_INDEX], qid13, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    expect(oracleEngine.getNotification()).toBeNull();

    // stuck network: t9 = t0 + 12 + 10.5/60
    test.advanceTimeAndTick(130000);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(19);
    const qid16 = oracleEngine.expectPriceSubscriptionQuery(16, t0 + 11 * MINUTE, subscriptionId0, [QX_CONTRACT_INDEX], priceQuery0);
    const qid17 = oracleEngine.expectPriceSubscriptionQuery(17, t0 + 12 * MINUTE, subscriptionId0, [QEARN_CONTRACT_INDEX], priceQuery0);
    const qid18 = oracleEngine.expectPriceSubscriptionQuery(18, t1 + 12 * MINUTE, subscriptionId1, [QUOTTERY_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX], priceQuery1);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX], qid14, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX, QX_CONTRACT_INDEX], qid15, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX], qid16, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();
    oracleEngine.checkStateConsistencyWithAssert();

    // QX leaves subscription 0
    expect(oracleEngine.stopContractSubscription(subscriptionId0, QX_CONTRACT_INDEX)).toBe(true);
    oracleEngine.checkStateConsistencyWithAssert();

    // t10 = t0 + 13 + 0.5/60: no new query
    test.advanceTimeAndTick(50000);
    oracleEngine.generateSubscriptionQueries();
    expect(oracleEngine.getQueryCount()).toBe(19);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([QEARN_CONTRACT_INDEX], qid17, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUOTTERY_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX], qid18, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    expect(oracleEngine.getNotification()).toBeNull();

    // subscription 0 for RANDOM and QBAY: t0 + 14 + N, MSVAULT: + 3 * N, CCF: + 8 * N, SWATCH: t0 + 15 + 15 * N
    expect(subscribe(RANDOM_CONTRACT_INDEX, priceQuery0, 1)).toBe(subscriptionId0);
    expect(subscribe(QBAY_CONTRACT_INDEX, priceQuery0, 1)).toBe(subscriptionId0);
    expect(subscribe(MSVAULT_CONTRACT_INDEX, priceQuery0, 3)).toBe(subscriptionId0);
    expect(subscribe(CCF_CONTRACT_INDEX, priceQuery0, 8)).toBe(subscriptionId0);
    expect(subscribe(SWATCH_CONTRACT_INDEX, priceQuery0, 15)).toBe(subscriptionId0);

    // t11 = t0 + 14 + 0.5/60
    test.advanceTimeAndTick(60000);
    oracleEngine.generateSubscriptionQueries();
    const qid19 = oracleEngine.expectPriceSubscriptionQuery(
        19,
        t0 + 14 * MINUTE,
        subscriptionId0,
        [QEARN_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, MSVAULT_CONTRACT_INDEX, CCF_CONTRACT_INDEX],
        priceQuery0,
    );
    expect(oracleEngine.getQueryCount()).toBe(20);

    oracleEngine.processTimeouts();
    expect(oracleEngine.getNotification()).toBeNull();

    // t12 = t0 + 15 + 0.5/60
    test.advanceTimeAndTick(60000);
    oracleEngine.generateSubscriptionQueries();
    const qid20 = oracleEngine.expectPriceSubscriptionQuery(
        20,
        t0 + 15 * MINUTE,
        subscriptionId0,
        [RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, SWATCH_CONTRACT_INDEX, QUTIL_CONTRACT_INDEX],
        priceQuery0,
    );
    const qid21 = oracleEngine.expectPriceSubscriptionQuery(21, t1 + 15 * MINUTE, subscriptionId1, [QUTIL_CONTRACT_INDEX, QUOTTERY_CONTRACT_INDEX], priceQuery1);
    expect(oracleEngine.getQueryCount()).toBe(22);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications(
        [QEARN_CONTRACT_INDEX, RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, MSVAULT_CONTRACT_INDEX, CCF_CONTRACT_INDEX],
        qid19,
        ORACLE_STATUS.TIMEOUT,
        subscriptionId0,
    );
    expect(oracleEngine.getNotification()).toBeNull();

    // SWATCH leaves subscription 0, everybody leaves subscription 1
    expect(oracleEngine.stopContractSubscription(subscriptionId0, SWATCH_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.stopContractSubscription(subscriptionId0, SWATCH_CONTRACT_INDEX)).toBe(false);
    expect(oracleEngine.stopContractSubscription(subscriptionId1, RANDOM_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.stopContractSubscription(subscriptionId1, QX_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.stopContractSubscription(subscriptionId1, QUTIL_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.stopContractSubscription(subscriptionId1, QUOTTERY_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.subscriberContracts(subscriptionId1)).toEqual([]);
    oracleEngine.checkStateConsistencyWithAssert();

    // t13 = t0 + 16 + 0.5/60
    test.advanceTimeAndTick(60000);
    oracleEngine.generateSubscriptionQueries();
    const qid22 = oracleEngine.expectPriceSubscriptionQuery(22, t0 + 16 * MINUTE, subscriptionId0, [RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], priceQuery0);
    expect(oracleEngine.getQueryCount()).toBe(23);

    // a query still names the subscriber that left after it was generated
    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, SWATCH_CONTRACT_INDEX, QUTIL_CONTRACT_INDEX], qid20, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX, QUOTTERY_CONTRACT_INDEX], qid21, ORACLE_STATUS.TIMEOUT, subscriptionId1);
    expect(oracleEngine.getNotification()).toBeNull();

    // t0 + 36 + 0.5/60
    test.advanceTimeAndTick(20 * 60000);
    oracleEngine.generateSubscriptionQueries();
    const qid23 = oracleEngine.expectPriceSubscriptionQuery(23, t0 + 17 * MINUTE, subscriptionId0, [RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, MSVAULT_CONTRACT_INDEX], priceQuery0);
    const qid24 = oracleEngine.expectPriceSubscriptionQuery(24, t0 + 18 * MINUTE, subscriptionId0, [QEARN_CONTRACT_INDEX], priceQuery0);
    const qid25 = oracleEngine.expectPriceSubscriptionQuery(25, t0 + 20 * MINUTE, subscriptionId0, [QUTIL_CONTRACT_INDEX], priceQuery0);
    const qid26 = oracleEngine.expectPriceSubscriptionQuery(26, t0 + 22 * MINUTE, subscriptionId0, [CCF_CONTRACT_INDEX], priceQuery0);
    expect(oracleEngine.getQueryCount()).toBe(27);

    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotifications([RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], qid22, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([RANDOM_CONTRACT_INDEX, QBAY_CONTRACT_INDEX, MSVAULT_CONTRACT_INDEX], qid23, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QEARN_CONTRACT_INDEX], qid24, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([QUTIL_CONTRACT_INDEX], qid25, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    oracleEngine.expectPriceNotifications([CCF_CONTRACT_INDEX], qid26, ORACLE_STATUS.TIMEOUT, subscriptionId0);
    expect(oracleEngine.getNotification()).toBeNull();

    oracleEngine.checkStateConsistencyWithAssert();
});

test("a subscription query that is revealed becomes the subscription's last revealed query", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);
    const query = priceQuery(m256i(1, 0, 0, 0), m256i(2, 0, 0, 0), m256i(3, 0, 0, 0), 0);

    const subscribe = (contractIndex: number) =>
        oracleEngine.startContractSubscription(contractIndex, PRICE_INTERFACE_INDEX, query, MINUTE, NOTIFICATION_PROC_ID, PriceOracleQuery.OFFSETS.timestamp);
    const subscriptionId = subscribe(QX_CONTRACT_INDEX);
    expect(subscribe(QEARN_CONTRACT_INDEX)).toBe(subscriptionId);

    // subscribing starts no query: the next tick does
    expect(oracleEngine.getPendingContractQueries(10)).toEqual([]);
    expect(oracleEngine.getOracleSubscription(subscriptionId)).toMatchObject({ subscriberCount: 2, lastPendingQueryId: -1n, lastRevealedQueryId: -1n, nextQueryTimestamp: test.clock });
    oracleEngine.generateSubscriptionQueries();

    // a subscriber due at the same time as the first one goes in front of it
    const queryId = test.contractOracleQueryId(test.tick, 0);
    expect(oracleEngine.getPendingContractQueries(10)).toEqual([{ queryId, interfaceIndex: PRICE_INTERFACE_INDEX, contractIndex: QEARN_CONTRACT_INDEX }]);
    expect(oracleEngine.getOracleSubscription(subscriptionId)).toMatchObject({ lastPendingQueryId: queryId, generatedQueriesCount: 1, nextQueryTimestamp: test.clock + MINUTE });

    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, priceReply(7n, 2n)));
    commitAndReveal(test, oracleEngine);

    expect(oracleEngine.getOracleSubscription(subscriptionId)!.lastRevealedQueryId).toBe(queryId);
    oracleEngine.expectPriceNotifications([QX_CONTRACT_INDEX, QEARN_CONTRACT_INDEX], queryId, ORACLE_STATUS.SUCCESS, subscriptionId, 7n, 2n);
    expect(oracleEngine.getNotification()).toBeNull();

    // the id stays with the subscription when everybody left and somebody comes back
    expect(oracleEngine.stopContractSubscription(subscriptionId, QX_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.stopContractSubscription(subscriptionId, QEARN_CONTRACT_INDEX)).toBe(true);
    expect(oracleEngine.getOracleSubscription(subscriptionId)!.subscriberCount).toBe(0);
    expect(subscribe(QUTIL_CONTRACT_INDEX)).toBe(subscriptionId);
    expect(oracleEngine.getOracleSubscription(subscriptionId + 1)).toBeNull();

    oracleEngine.checkStateConsistencyWithAssert();
});

test("a request the engine refuses starts nothing", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);
    const query = new Uint8Array(PriceOracleQuery.SIZE);

    expect(oracleEngine.startContractQuery(1024, PRICE_INTERFACE_INDEX, query, 1000, NOTIFICATION_PROC_ID)).toBe(-1n);
    expect(oracleEngine.startContractQuery(7, 5, query, 1000, NOTIFICATION_PROC_ID)).toBe(-1n);
    expect(oracleEngine.startContractQuery(7, PRICE_INTERFACE_INDEX, query.subarray(1), 1000, NOTIFICATION_PROC_ID)).toBe(-1n);
    expect(oracleEngine.startContractQuery(7, PRICE_INTERFACE_INDEX, query, 3_600_001, NOTIFICATION_PROC_ID)).toBe(-1n);
    expect(oracleEngine.getQueryCount()).toBe(0);
    expect(test.log).toEqual([]);

    // none of the refusals took a query id
    expect(oracleEngine.startContractQuery(7, PRICE_INTERFACE_INDEX, query, 3_600_000, NOTIFICATION_PROC_ID)).toBe(test.contractOracleQueryId(test.tick, 0));
    expect(test.log).toHaveLength(1);
    expect(oracleEngine.getNotification()).toBeNull();
});

// a contract keeps a query id in its state: the id names the tick, and nothing of an epoch outlives it.
test("a query id carries its tick and the epoch's queries end with the epoch", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);
    const query = new Uint8Array(PriceOracleQuery.SIZE);
    const startQuery = () => oracleEngine.startContractQuery(4, PRICE_INTERFACE_INDEX, query, MINUTE, NOTIFICATION_PROC_ID);

    const first = startQuery();
    expect(first).toBe(test.contractOracleQueryId(test.tick, 0));
    expect(first >> 31n).toBe(BigInt(test.tick));
    expect(startQuery()).toBe(test.contractOracleQueryId(test.tick, 1));

    ++test.tick;
    expect(startQuery()).toBe(test.contractOracleQueryId(test.tick, 0));
    const subscriptionId = oracleEngine.startContractSubscription(4, PRICE_INTERFACE_INDEX, query, MINUTE, NOTIFICATION_PROC_ID, PriceOracleQuery.OFFSETS.timestamp);

    oracleEngine.beginEpoch();
    ++test.tick;
    expect(oracleEngine.getOracleQueryStatus(first)).toBe(ORACLE_STATUS.UNKNOWN);
    expect(oracleEngine.getOracleQuery(first, new Uint8Array(PriceOracleQuery.SIZE))).toBe(false);
    expect(oracleEngine.stopContractSubscription(subscriptionId, 4)).toBe(false);
    expect(oracleEngine.getPendingContractQueries(10)).toEqual([]);
    expect(startQuery()).toBe(test.contractOracleQueryId(test.tick, 0));
    oracleEngine.checkStateConsistencyWithAssert();
});

test("what an oracle machine reports is kept in the status flags and the query waits for its timeout", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);
    const queryId = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);

    // too short for the header, a query nobody started, and a reply of the wrong size
    oracleEngine.processOracleMachineReply(new Uint8Array(OracleMachineReply.SIZE - 1));
    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId + 1n, priceReply(1n, 1n)));
    expect(oracleEngine.getOracleQueryStatusFlags(queryId)).toBe(0);
    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, new Uint8Array(PriceOracleReply.SIZE - 1)));
    expect(oracleEngine.getOracleQueryStatusFlags(queryId)).toBe(ORACLE_FLAG_BAD_SIZE_REPLY);

    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, new Uint8Array(0), ORACLE_FLAG_ORACLE_UNAVAIL));
    expect(oracleEngine.getOracleQueryStatusFlags(queryId)).toBe(ORACLE_FLAG_BAD_SIZE_REPLY | ORACLE_FLAG_ORACLE_UNAVAIL);
    expect(oracleEngine.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.PENDING);

    // no reply was accepted, so nobody commits
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 0, test.tick + 1, 0)).toBe(0);

    test.advanceTimeAndTick(MINUTE);
    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotification(2, queryId, ORACLE_STATUS.TIMEOUT);
    expect(oracleEngine.failureOf(queryId)).toEqual({ agreeingCommits: 0, totalCommits: 0 });
    oracleEngine.checkStateConsistencyWithAssert();
});

test("a committed query times out when its reveal never comes", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);
    const queryId = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);
    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, priceReply(5n, 1n)));

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    for (let computorIdx = 0; computorIdx < QUORUM; ++computorIdx) {
        expect(oracleEngine.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 1, 0)).toBe(UINT32_MAX);
        expect(oracleEngine.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
    }
    expect(oracleEngine.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.COMMITTED);
    expect(oracleEngine.getPendingContractQueries(10)).toEqual([]);

    test.advanceTimeAndTick(MINUTE);
    oracleEngine.processTimeouts();
    oracleEngine.expectPriceNotification(2, queryId, ORACLE_STATUS.TIMEOUT);
    expect(oracleEngine.failureOf(queryId)).toEqual({ agreeingCommits: QUORUM, totalCommits: QUORUM });

    // the reveal comes too late
    expect(oracleEngine.getReplyRevealTransaction(txBuffer, 0, test.tick + 1, 0)).toBe(0);
    expect(oracleEngine.getOracleReply(queryId, new Uint8Array(PriceOracleReply.SIZE))).toBe(false);
    oracleEngine.checkStateConsistencyWithAssert();
});

test("a transaction from a key that is no computor, or one cut short, is refused", () => {
    const test = new OracleEngineTest();
    const oracleEngine = new OracleEngineOfNode(test, 0, 677);
    const queryId = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);
    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, priceReply(5n, 1n)));

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 3, test.tick + 1, 0)).toBe(UINT32_MAX);
    const size = Transaction.HEADER_SIZE + OracleReplyCommitTransactionItem.SIZE;
    expect(oracleEngine.processOracleReplyCommitTransaction(txBuffer.slice(0, size - 1))).toBe(false);

    const stranger = txBuffer.slice();
    Transaction.wrap(stranger).sourcePublicKey = m256i(1, 1, 1, 1);
    expect(oracleEngine.processOracleReplyCommitTransaction(stranger)).toBe(false);
    oracleEngine.checkPendingState(queryId, 0, 0, ORACLE_STATUS.PENDING);

    // a computor that is out of range, and a tick that is not in the future
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 676, test.tick + 1, 0)).toBe(0);
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 4, test.tick, 0)).toBe(0);
});

test("only the reply the quorum committed to is revealed, and only by a node that has it", () => {
    const test = new OracleEngineTest();
    const minority = new OracleEngineOfNode(test, 0, 100);
    const majority = new OracleEngineOfNode(test, 100, 676);
    const query = new Uint8Array(PriceOracleQuery.SIZE);

    const queryId = minority.startContractQuery(2, PRICE_INTERFACE_INDEX, query, MINUTE, NOTIFICATION_PROC_ID);
    expect(majority.startContractQuery(2, PRICE_INTERFACE_INDEX, query, MINUTE, NOTIFICATION_PROC_ID)).toBe(queryId);
    minority.processOracleMachineReply(oracleMachineReply(queryId, priceReply(1n, 1n)));
    majority.processOracleMachineReply(oracleMachineReply(queryId, priceReply(2n, 1n)));

    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    for (let computorIdx = 100; computorIdx < 100 + QUORUM; ++computorIdx) {
        expect(majority.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 1, 0)).toBe(UINT32_MAX);
        expect(minority.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
        expect(majority.processOracleReplyCommitTransaction(txBuffer)).toBe(true);

        // a computor's second commit does not count
        expect(majority.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
        majority.checkPendingState(queryId, computorIdx - 99, computorIdx - 99, computorIdx - 99 < QUORUM ? ORACLE_STATUS.PENDING : ORACLE_STATUS.COMMITTED);
    }
    minority.checkStatus(queryId, ORACLE_STATUS.COMMITTED);

    expect(minority.getReplyRevealTransaction(txBuffer, 0, test.tick + 1, 0)).toBe(0);
    expect(majority.getReplyRevealTransaction(txBuffer, 100, test.tick + 1, 0)).toBe(1);

    ++test.tick;
    const otherReply = txBuffer.slice();
    otherReply.set(priceReply(1n, 1n), Transaction.HEADER_SIZE + OracleReplyRevealTransactionPrefix.minInputSize);
    expect(minority.processOracleReplyRevealTransaction(otherReply, 0)).toBe(false);
    minority.checkStatus(queryId, ORACLE_STATUS.COMMITTED);

    expect(minority.processOracleReplyRevealTransaction(txBuffer, 0)).toBe(true);
    minority.expectPriceNotification(2, queryId, ORACLE_STATUS.SUCCESS, -1, 2n, 1n);
    minority.checkStateConsistencyWithAssert();
});

// a node never runs tick 0, the simulator does: the first query there has the first index and its reply still resolves.
test("a query started at tick 0 is committed and revealed", () => {
    const test = new OracleEngineTest();
    test.tick = 0;
    const oracleEngine = new OracleEngineOfNode(test, 0, 676);

    const queryId = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);
    expect(queryId).toBe(BigInt(TXS_PER_TICK));
    oracleEngine.processOracleMachineReply(oracleMachineReply(queryId, priceReply(5n, 3n)));

    // computor 0 commits at tick 0 already, and is not asked twice
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 0, 1, 0)).toBe(UINT32_MAX);
    expect(oracleEngine.getReplyCommitTransaction(txBuffer, 0, 1, 0)).toBe(0);
    expect(oracleEngine.processOracleReplyCommitTransaction(txBuffer)).toBe(true);

    for (let computorIdx = 1; computorIdx < QUORUM; ++computorIdx) {
        expect(oracleEngine.getReplyCommitTransaction(txBuffer, computorIdx, 1, 0)).toBe(UINT32_MAX);
        expect(oracleEngine.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
    }
    expect(oracleEngine.getOracleQueryStatus(queryId)).toBe(ORACLE_STATUS.COMMITTED);

    expect(oracleEngine.getReplyRevealTransaction(txBuffer, 0, 1, 0)).toBe(1);
    expect(oracleEngine.getReplyRevealTransaction(txBuffer, 0, 1, 0)).toBe(0);
    test.tick = 1;
    expect(oracleEngine.processOracleReplyRevealTransaction(txBuffer, 0)).toBe(true);

    oracleEngine.expectPriceNotification(2, queryId, ORACLE_STATUS.SUCCESS, -1, 5n, 3n);
    oracleEngine.checkStateConsistencyWithAssert();
});

test("the quorum follows the committee the engine runs with", () => {
    const test = new OracleEngineTest();
    test.numberOfComputors = 8;
    test.quorum = 6;
    const oracleEngine = new OracleEngineOfNode(test, 0, 8);

    const agreed = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);
    oracleEngine.processOracleMachineReply(oracleMachineReply(agreed, priceReply(5n, 3n)));
    commitAndReveal(test, oracleEngine);
    oracleEngine.expectPriceNotification(2, agreed, ORACLE_STATUS.SUCCESS, -1, 5n, 3n);

    // three of eight commit to something else: the six the quorum needs cannot be reached
    const disputed = oracleEngine.startContractQuery(2, PRICE_INTERFACE_INDEX, new Uint8Array(PriceOracleQuery.SIZE), MINUTE, NOTIFICATION_PROC_ID);
    oracleEngine.processOracleMachineReply(oracleMachineReply(disputed, priceReply(5n, 3n)));
    const txBuffer = new Uint8Array(MAX_TRANSACTION_SIZE);
    for (let computorIdx = 0; computorIdx < 8; ++computorIdx) {
        if (!oracleEngine.getReplyCommitTransaction(txBuffer, computorIdx, test.tick + 1, 0)) {
            break;
        }
        if (computorIdx >= 3) {
            txBuffer[Transaction.HEADER_SIZE + OracleReplyCommitTransactionItem.OFFSETS.replyDigest] ^= 1;
        }
        expect(oracleEngine.processOracleReplyCommitTransaction(txBuffer)).toBe(true);
    }

    expect(oracleEngine.failureOf(disputed)).toEqual({ agreeingCommits: 3, totalCommits: 6 });
    oracleEngine.expectPriceNotification(2, disputed, ORACLE_STATUS.UNRESOLVABLE);
    oracleEngine.checkStateConsistencyWithAssert();
});
