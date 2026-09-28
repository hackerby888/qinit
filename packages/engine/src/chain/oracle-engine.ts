// core's src/oracle_core/oracle_engine.h for contract queries and subscriptions: same methods, same steps, same names. Fees belong to the caller.
import { packDateAndTime } from "../contract/runtime";
import { ORACLE_INTERFACES } from "../oracle-interfaces/registry";
import {
    DIGEST_SIZE,
    OracleMachineReply,
    OracleNotificationData,
    OracleNotificationInput,
    OracleReplyCommitTransactionItem,
    OracleReplyCommitTransactionPrefix,
    OracleReplyRevealTransactionPrefix,
    Transaction,
} from "../protocol/wire";
import { rangesEqual } from "../support/bytes";
import { k12Bytes } from "../support/k12";
import { MinHeap } from "../support/min-heap";
import {
    encodeOracleQueryStatusChangeLog,
    encodeOracleSubscriberLog,
    MAX_INPUT_SIZE,
    MAX_NUMBER_OF_CONTRACTS,
    MAX_ORACLE_QUERIES,
    MAX_ORACLE_REPLY_SIZE,
    MAX_ORACLE_SUBSCRIBERS,
    MAX_ORACLE_SUBSCRIPTIONS,
    MAX_ORACLE_TIMEOUT_MILLISEC,
    MAX_SIMULTANEOUS_ORACLE_QUERIES,
    ORACLE_FLAG_BAD_SIZE_REPLY,
    ORACLE_FLAG_BAD_SIZE_REVEAL,
    ORACLE_FLAG_FAKE_COMMITS,
    ORACLE_FLAG_OM_DISAGREE,
    ORACLE_FLAG_OM_ERROR_FLAGS,
    ORACLE_FLAG_REPLY_PENDING,
    ORACLE_FLAG_REPLY_RECEIVED,
    ORACLE_QUERY_STORAGE_SIZE,
    ORACLE_QUERY_TYPE_CONTRACT_QUERY,
    ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION,
    ORACLE_STATUS,
    QUBIC_LOG_TYPE,
    TXS_PER_TICK,
} from "@qinit/proto";

export { ORACLE_STATUS };

const UINT32_MAX = 0xffffffff;
const MILLISEC_PER_MINUTE = 60_000;
const DATE_AND_TIME_SIZE = 8;
const SUBSCRIBER_INDEX_SIZE = 4;
// what DateAndTime::setInvalid leaves behind; both still order against a real timestamp.
const INVALID_TIMESTAMP_SMALLEST = -Infinity;
const INVALID_TIMESTAMP_LARGEST = Infinity;

// timestamps are milliseconds here and a packed DateAndTime wherever bytes leave the engine.
export interface OracleQueryMetadata {
    queryId: bigint;
    type: number;
    status: number;
    statusFlags: number;
    queryTick: number;
    timeout: number;
    interfaceIndex: number;
    typeVar: {
        contract?: { notificationProcId: number; queryStorageOffset: number; queryingContract: number };
        subscription?: { subscriptionId: number; queryStorageOffset: number; subscriberCount: number };
    };
    // pending until the notification, then success or failure.
    statusVar: {
        pending?: { replyStateIndex: number };
        success?: { revealTick: number; revealTxIndex: number };
        failure?: { totalCommits: number; agreeingCommits: number };
    };
}

export interface OracleSubscription {
    initialQueryStorageOffset: number;
    interfaceIndex: number;
    queryTimestampOffset: number;
    subscriberCount: number;
    lastPendingQueryId: bigint;
    lastRevealedQueryId: bigint;
    nextQueryTimestamp: number;
    generatedQueriesCount: number;
    firstSubscriberIndex: number;
}

export interface OracleSubscriber {
    subscriptionId: number;
    contractIndex: number;
    notificationPeriodMinutes: number;
    nextQueryTimestamp: number;
    notificationProcId: number;
    nextSubscriberIdx: number;
}

export interface OracleReplyState {
    queryId: bigint;
    ownReplyDigest: Uint8Array;
    ownReplySize: number;
    // two spare bytes take the computor index the knowledge proof is hashed with.
    ownReplyData: Uint8Array;
    replyCommitScheduleTick: Uint32Array;
    replyCommitDigests: Uint8Array;
    replyCommitKnowledgeProofs: Uint8Array;
    replyCommitTicks: Uint32Array;
    replyCommitHistogramIdx: Uint16Array;
    replyCommitHistogramCount: Uint16Array;
    mostCommitsHistIdx: number;
    totalCommits: number;
    expectedRevealTxTick: number;
}

export interface PendingContractQuery {
    queryId: bigint;
    interfaceIndex: number;
    // the contract the reply goes to; the first subscriber for a subscription query
    contractIndex: number;
}

// what core reads from its globals: system.tick, DateAndTime::now(), the broadcast computor list and the logger.
export interface OracleEngineHost {
    nowMs(): number;
    currentTick(): number;
    numberOfComputors(): number;
    quorum(): number;
    computorPublicKey(computorIdx: number): Uint8Array;
    // -1 for a key that is no computor
    computorIndex(publicKey: Uint8Array): number;
    log?(type: number, message: Uint8Array): void;
}

// order of entries does not matter, so a removal moves the last entry into the gap.
class UnsortedMultiset {
    values: number[] = [];

    constructor(private readonly capacity: number) {}

    get numValues(): number {
        return this.values.length;
    }

    add(value: number): boolean {
        if (this.values.length >= this.capacity) {
            return false;
        }

        this.values.push(value);
        return true;
    }

    removeByIndex(index: number): boolean {
        if (index >= this.values.length) {
            return false;
        }

        const last = this.values.pop()!;
        if (index !== this.values.length) {
            this.values[index] = last;
        }
        return true;
    }

    removeByValue(value: number): boolean {
        let index = 0;
        let removedAny = false;
        while (index < this.values.length) {
            if (this.values[index] === value) {
                removedAny = this.removeByIndex(index) || removedAny;
            } else {
                ++index;
            }
        }
        return removedAny;
    }
}

function assertConsistent(condition: boolean, what: string): asserts condition {
    if (!condition) {
        throw new Error(`oracle engine state is inconsistent: ${what}`);
    }
}

export function packTimestamp(timestamp: number): bigint {
    if (timestamp === INVALID_TIMESTAMP_LARGEST) {
        return 0xffffffffffffffffn;
    }
    if (timestamp === INVALID_TIMESTAMP_SMALLEST) {
        return 0n;
    }
    return packDateAndTime(timestamp);
}

// the tick a transaction was scheduled for; 0 is "none yet", which core can compare with because its tick is never 0 and the simulator's is.
function isScheduledAtOrAfter(scheduleTick: number, tick: number): boolean {
    return scheduleTick !== 0 && scheduleTick >= tick;
}

function greatestCommonDivisor(left: number, right: number): number {
    while (right) {
        [left, right] = [right, left % right];
    }
    return left;
}

export class OracleEngine {
    protected readonly host: OracleEngineHost;
    protected queries: OracleQueryMetadata[] = [];
    // core keeps one byte array; here an offset holds the bytes core would have copied there, so every offset still matches.
    protected queryStorage = new Map<number, Uint8Array>();
    protected queryStorageBytesUsed = 8;
    protected contractQueryIdState = { tick: -1, queryIndexInTick: 0 };
    protected replyStates: (OracleReplyState | undefined)[] = [];
    protected replyStatesIndex = 0;
    protected pendingQueryIndices = new UnsortedMultiset(MAX_SIMULTANEOUS_ORACLE_QUERIES);
    protected pendingCommitReplyStateIndices = new UnsortedMultiset(MAX_SIMULTANEOUS_ORACLE_QUERIES);
    protected pendingRevealReplyStateIndices = new UnsortedMultiset(MAX_SIMULTANEOUS_ORACLE_QUERIES);
    protected notificationQueryIndexQueue = new MinHeap<number>(MAX_SIMULTANEOUS_ORACLE_QUERIES);
    protected subscriptions: OracleSubscription[] = [];
    protected subscribers: OracleSubscriber[] = [];
    protected queryIdToIndex = new Map<bigint, number>();
    protected nextSubscriptionIdQueue = new MinHeap<number>(MAX_ORACLE_SUBSCRIPTIONS);
    protected notificationOutputBuffer = OracleNotificationData.alloc();
    protected notificationCurrentSubscriberIdx = 0;
    // core reads a revealed reply back from the tick's transactions; the simulator stores no oracle transaction, so the reply is kept here.
    protected revealedReplies = new Map<bigint, Uint8Array>();

    constructor(host: OracleEngineHost) {
        this.host = host;
        this.reset();
    }

    init(): boolean {
        this.reset();
        return true;
    }

    reset(): void {
        this.queries = [];
        this.queryStorage.clear();
        // offset 0 is "no data"
        this.queryStorageBytesUsed = 8;
        // core starts at tick 0, which a node never runs; the simulator does, and its first query there still gets the first index.
        this.contractQueryIdState = { tick: -1, queryIndexInTick: 0 };
        this.replyStates = new Array<OracleReplyState | undefined>(MAX_SIMULTANEOUS_ORACLE_QUERIES).fill(undefined);
        this.replyStatesIndex = 0;
        this.pendingQueryIndices.values = [];
        this.pendingCommitReplyStateIndices.values = [];
        this.pendingRevealReplyStateIndices.values = [];
        this.notificationQueryIndexQueue.init();
        this.subscriptions = [];
        this.subscribers = [];
        this.queryIdToIndex.clear();
        this.notificationCurrentSubscriberIdx = 0;
        this.notificationOutputBuffer.bytes.fill(0);
        this.revealedReplies.clear();
        this.nextSubscriptionIdQueue.init((lhs, rhs) => this.subscriptions[lhs].nextQueryTimestamp < this.subscriptions[rhs].nextQueryTimestamp);
    }

    deinit(): void {}

    // drop all queries of the previous epoch.
    beginEpoch(): void {
        this.reset();
    }

    startContractQuery(contractIndex: number, interfaceIndex: number, queryData: Uint8Array, timeoutMillisec: number, notificationProcId: number): bigint {
        const oracleInterface = ORACLE_INTERFACES[interfaceIndex];
        if (contractIndex >= MAX_NUMBER_OF_CONTRACTS || !oracleInterface || queryData.length !== oracleInterface.query.SIZE) {
            return -1n;
        }

        const timeout = this.getTimeoutTimestamp(this.host.nowMs(), timeoutMillisec);
        if (!Number.isFinite(timeout)) {
            return -1n;
        }

        const queryId = this.getNewNonTxQueryId();
        if (queryId < 0n) {
            return -1n;
        }

        const oqm = this.startQuery(queryId, ORACLE_QUERY_TYPE_CONTRACT_QUERY, interfaceIndex, timeout, queryData.length);
        if (!oqm) {
            return -1n;
        }
        oqm.typeVar = { contract: { queryingContract: contractIndex, queryStorageOffset: this.queryStorageBytesUsed, notificationProcId } };

        this.queryStorage.set(this.queryStorageBytesUsed, queryData.slice());
        this.queryStorageBytesUsed += queryData.length;

        this.logQueryStatusChange(oqm);
        return queryId;
    }

    startContractSubscription(
        contractIndex: number,
        interfaceIndex: number,
        queryData: Uint8Array,
        notificationPeriodMillisec: number,
        notificationProcId: number,
        timestampOffsetInQuery: number,
    ): number {
        const oracleInterface = ORACLE_INTERFACES[interfaceIndex];
        const querySize = queryData.length;
        if (contractIndex >= MAX_NUMBER_OF_CONTRACTS || !oracleInterface || querySize !== oracleInterface.query.SIZE || timestampOffsetInQuery + DATE_AND_TIME_SIZE > querySize) {
            return -1;
        }

        const notificationPeriodMinutes = Math.floor(notificationPeriodMillisec / MILLISEC_PER_MINUTE);
        if (notificationPeriodMillisec % MILLISEC_PER_MINUTE !== 0 || notificationPeriodMinutes < 1 || notificationPeriodMinutes > 1440) {
            return -1;
        }

        // an existing subscription has the same interface and the same query, the timestamp left out
        let subscriptionId = -1;
        const cmpOffset2 = timestampOffsetInQuery + DATE_AND_TIME_SIZE;
        const cmpSize2 = querySize - cmpOffset2;
        for (let index = 0; index < this.subscriptions.length; ++index) {
            const candidate = this.subscriptions[index];
            if (!candidate.initialQueryStorageOffset || candidate.interfaceIndex !== interfaceIndex) {
                continue;
            }

            const queryDataStorage = this.queryStorage.get(candidate.initialQueryStorageOffset)!;
            if (timestampOffsetInQuery && !rangesEqual(queryDataStorage, 0, queryData, 0, timestampOffsetInQuery)) {
                continue;
            }
            if (cmpSize2 && !rangesEqual(queryDataStorage, cmpOffset2, queryData, cmpOffset2, cmpSize2)) {
                continue;
            }

            subscriptionId = index;
            break;
        }

        // a contract cannot change its subscription: it unsubscribes and subscribes again
        if (subscriptionId >= 0) {
            let index = this.subscriptions[subscriptionId].firstSubscriberIndex;
            while (index >= 0) {
                if (this.subscribers[index].contractIndex === contractIndex) {
                    return -1;
                }
                index = this.subscribers[index].nextSubscriberIdx;
            }
        }

        const noRoomForSubscription =
            subscriptionId < 0 &&
            (this.subscriptions.length >= MAX_ORACLE_SUBSCRIPTIONS ||
                this.queryStorageBytesUsed + querySize > ORACLE_QUERY_STORAGE_SIZE ||
                this.nextSubscriptionIdQueue.size() >= this.nextSubscriptionIdQueue.capacity());
        if (noRoomForSubscription || this.subscribers.length >= MAX_ORACLE_SUBSCRIBERS) {
            return -1;
        }

        const now = this.host.nowMs();
        if (subscriptionId < 0) {
            subscriptionId = this.subscriptions.length;
            this.subscriptions.push({
                initialQueryStorageOffset: this.queryStorageBytesUsed,
                interfaceIndex,
                queryTimestampOffset: timestampOffsetInQuery,
                subscriberCount: 0,
                lastPendingQueryId: -1n,
                lastRevealedQueryId: -1n,
                nextQueryTimestamp: INVALID_TIMESTAMP_LARGEST,
                generatedQueriesCount: 0,
                firstSubscriberIndex: -1,
            });

            this.queryStorage.set(this.queryStorageBytesUsed, queryData.slice());
            this.queryStorageBytesUsed += querySize;
        }
        const subscription = this.subscriptions[subscriptionId];

        const subscriberIndex = this.subscribers.length;
        const subscriber: OracleSubscriber = {
            subscriptionId,
            contractIndex,
            notificationPeriodMinutes,
            nextQueryTimestamp: INVALID_TIMESTAMP_SMALLEST,
            notificationProcId,
            nextSubscriberIdx: -1,
        };
        this.subscribers.push(subscriber);
        ++subscription.subscriberCount;

        if (subscription.subscriberCount === 1) {
            // only one subscriber: query now
            subscription.nextQueryTimestamp = now;
            subscriber.nextQueryTimestamp = subscription.nextQueryTimestamp;
            this.nextSubscriptionIdQueue.insert(subscriptionId);
        } else {
            // sync with the subscriber whose period shares the greatest divisor with the new one
            let refIdx = -1;
            let maxGcd = 0;
            let index = subscription.firstSubscriberIndex;
            while (index >= 0) {
                const gcd = greatestCommonDivisor(notificationPeriodMinutes, this.subscribers[index].notificationPeriodMinutes);
                if (maxGcd < gcd) {
                    maxGcd = gcd;
                    refIdx = index;
                }
                index = this.subscribers[index].nextSubscriberIdx;
            }

            // the last whole period before the reference's next query, not earlier than now
            const refQueryTimestamp = this.subscribers[refIdx].nextQueryTimestamp;
            const minutesUntilRefQuery = Math.floor(Math.abs(refQueryTimestamp - now) / MILLISEC_PER_MINUTE);
            const periodsUntilRefQuery = Math.floor(minutesUntilRefQuery / notificationPeriodMinutes);
            subscriber.nextQueryTimestamp = refQueryTimestamp - periodsUntilRefQuery * notificationPeriodMinutes * MILLISEC_PER_MINUTE;

            if (subscription.nextQueryTimestamp > subscriber.nextQueryTimestamp) {
                subscription.nextQueryTimestamp = subscriber.nextQueryTimestamp;
                this.nextSubscriptionIdQueue.removeFirstMatch(subscriptionId);
                this.nextSubscriptionIdQueue.insert(subscriptionId);
            }
        }

        // the list is sorted by nextQueryTimestamp, so the subscriber goes in after it was scheduled
        this.addSubscriberToSubscriptionsSortedList(subscriptionId, subscriberIndex);

        this.host.log?.(
            QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE,
            encodeOracleSubscriberLog(subscriptionId, interfaceIndex, contractIndex, notificationPeriodMillisec, packTimestamp(subscriber.nextQueryTimestamp)),
        );

        return subscriptionId;
    }

    stopContractSubscription(subscriptionId: number, contractIndex: number): boolean {
        if (subscriptionId < 0 || contractIndex >= MAX_NUMBER_OF_CONTRACTS || subscriptionId >= this.subscriptions.length) {
            return false;
        }

        const subscription = this.subscriptions[subscriptionId];
        if (subscription.firstSubscriberIndex < 0) {
            return false;
        }

        let subscriber = this.subscribers[subscription.firstSubscriberIndex];
        if (subscriber.contractIndex === contractIndex) {
            subscription.firstSubscriberIndex = subscriber.nextSubscriberIdx;
            if (subscription.firstSubscriberIndex >= 0) {
                subscription.nextQueryTimestamp = this.subscribers[subscription.firstSubscriberIndex].nextQueryTimestamp;
                this.nextSubscriptionIdQueue.removeFirstMatch(subscriptionId);
                this.nextSubscriptionIdQueue.insert(subscriptionId);
            } else {
                // nobody is left, so the subscription stops generating queries
                subscription.nextQueryTimestamp = INVALID_TIMESTAMP_SMALLEST;
                this.nextSubscriptionIdQueue.removeFirstMatch(subscriptionId);
            }
        } else {
            let prevIdx = subscription.firstSubscriberIndex;
            let curIdx = subscriber.nextSubscriberIdx;
            while (curIdx >= 0 && this.subscribers[curIdx].contractIndex !== contractIndex) {
                prevIdx = curIdx;
                curIdx = this.subscribers[curIdx].nextSubscriberIdx;
            }
            if (curIdx < 0) {
                return false;
            }

            subscriber = this.subscribers[curIdx];
            this.subscribers[prevIdx].nextSubscriberIdx = subscriber.nextSubscriberIdx;
        }

        // the slot stays taken: queries in the storage still name it
        subscriber.nextQueryTimestamp = INVALID_TIMESTAMP_SMALLEST;
        subscriber.nextSubscriberIdx = -1;
        --subscription.subscriberCount;

        this.host.log?.(QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, encodeOracleSubscriberLog(subscriptionId, subscription.interfaceIndex, contractIndex, 0, 0n));
        return true;
    }

    // once per tick: a subscription whose time has come gets its next query.
    generateSubscriptionQueries(): void {
        const now = this.host.nowMs();

        for (;;) {
            const subscriptionId = this.nextSubscriptionIdQueue.peek();
            if (subscriptionId === undefined) {
                break;
            }

            const subscription = this.subscriptions[subscriptionId];
            const queryTimestamp = subscription.nextQueryTimestamp;
            if (queryTimestamp > now) {
                break;
            }

            // subscribers due now are notified about this query; a stuck network may have skipped periods
            const subscriberIndices: number[] = [];
            while (subscription.firstSubscriberIndex >= 0 && subscriberIndices.length < subscription.subscriberCount) {
                const subscriberIdx = subscription.firstSubscriberIndex;
                const subscriber = this.subscribers[subscriberIdx];
                if (subscriber.nextQueryTimestamp > queryTimestamp) {
                    break;
                }
                subscriberIndices.push(subscriberIdx);

                do {
                    subscriber.nextQueryTimestamp += subscriber.notificationPeriodMinutes * MILLISEC_PER_MINUTE;
                } while (subscriber.nextQueryTimestamp < now);

                subscription.firstSubscriberIndex = subscriber.nextSubscriberIdx;
                this.addSubscriberToSubscriptionsSortedList(subscriptionId, subscriberIdx);
            }
            const subscriberIndicesBytes = subscriberIndices.length * SUBSCRIBER_INDEX_SIZE;

            // a subscription query always times out after one minute
            const timeout = queryTimestamp + MILLISEC_PER_MINUTE;

            const queryId = this.getNewNonTxQueryId();
            if (queryId < 0n) {
                break;
            }

            const querySize = ORACLE_INTERFACES[subscription.interfaceIndex].query.SIZE;
            const oqm = this.startQuery(queryId, ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION, subscription.interfaceIndex, timeout, querySize + subscriberIndicesBytes);
            if (!oqm) {
                break;
            }
            oqm.typeVar = { subscription: { subscriptionId, queryStorageOffset: this.queryStorageBytesUsed, subscriberCount: subscriberIndices.length } };

            // the initial query with this query's timestamp, then the subscriber indices
            const stored = new Uint8Array(querySize + subscriberIndicesBytes);
            const storedView = new DataView(stored.buffer);
            stored.set(this.queryStorage.get(subscription.initialQueryStorageOffset)!);
            storedView.setBigUint64(subscription.queryTimestampOffset, packTimestamp(queryTimestamp), true);
            subscriberIndices.forEach((subscriberIdx, position) => storedView.setInt32(querySize + position * SUBSCRIBER_INDEX_SIZE, subscriberIdx, true));
            this.queryStorage.set(this.queryStorageBytesUsed, stored);
            this.queryStorageBytesUsed += stored.length;

            this.logQueryStatusChange(oqm);

            subscription.lastPendingQueryId = queryId;
            ++subscription.generatedQueriesCount;
            subscription.nextQueryTimestamp = this.subscribers[subscription.firstSubscriberIndex].nextQueryTimestamp;
            this.nextSubscriptionIdQueue.replace(subscriptionId);
        }
    }

    processOracleMachineReply(replyMessage: Uint8Array): void {
        if (replyMessage.length < OracleMachineReply.SIZE) {
            return;
        }

        const message = OracleMachineReply.wrap(replyMessage);
        const queryId = BigInt.asIntN(64, message.oracleQueryId);
        const queryIndex = this.queryIdToIndex.get(queryId);
        if (queryIndex === undefined) {
            return;
        }

        const oqm = this.queries[queryIndex];
        if (oqm.status !== ORACLE_STATUS.PENDING) {
            return;
        }

        const errorFlags = message.oracleMachineErrorFlags & ORACLE_FLAG_OM_ERROR_FLAGS;
        if (errorFlags !== 0) {
            oqm.statusFlags |= errorFlags;
            return;
        }

        const replyData = replyMessage.subarray(OracleMachineReply.SIZE);
        const replySize = replyData.length;
        if (replySize > MAX_ORACLE_REPLY_SIZE || replySize !== ORACLE_INTERFACES[oqm.interfaceIndex].reply.SIZE) {
            oqm.statusFlags |= ORACLE_FLAG_BAD_SIZE_REPLY;
            return;
        }

        const replyDigest = k12Bytes(replyData);
        const replyStateIdx = oqm.statusVar.pending!.replyStateIndex;
        const replyState = this.replyStates[replyStateIdx];
        if (replyState?.queryId !== queryId) {
            return;
        }

        // a second reply only tells whether the oracle machines agree
        if (replyState.ownReplySize) {
            if (!rangesEqual(replyDigest, 0, replyState.ownReplyDigest, 0, DIGEST_SIZE)) {
                oqm.statusFlags |= ORACLE_FLAG_OM_DISAGREE;
            }
            return;
        }

        replyState.ownReplyData.set(replyData);
        replyState.ownReplyDigest = replyDigest;
        replyState.ownReplySize = replySize;
        oqm.statusFlags |= ORACLE_FLAG_REPLY_RECEIVED;

        this.pendingCommitReplyStateIndices.add(replyStateIdx);
    }

    // writes all of a commit transaction except the signature. Returns 0 for no transaction, UINT32_MAX when every pending commit
    // is in it, anything else is the startIdx of the next call. Processing a commit transaction in between invalidates the startIdx.
    getReplyCommitTransaction(txBuffer: Uint8Array, computorIdx: number, txScheduleTick: number, startIdx = 0): number {
        const tick = this.host.currentTick();
        if (computorIdx >= this.host.numberOfComputors() || txScheduleTick <= tick) {
            return 0;
        }

        const maxCommitsCount = Math.floor(MAX_INPUT_SIZE / OracleReplyCommitTransactionItem.SIZE);
        const replyIndices = this.pendingCommitReplyStateIndices.values;
        let commitsCount = 0;
        let index = startIdx;
        for (; index < replyIndices.length; ++index) {
            const replyState = this.replyStates[replyIndices[index]];
            if (!replyState || replyState.ownReplySize === 0) {
                continue;
            }

            // already executed or scheduled
            if (replyState.replyCommitTicks[computorIdx] || isScheduledAtOrAfter(replyState.replyCommitScheduleTick[computorIdx], tick)) {
                continue;
            }

            if (commitsCount === maxCommitsCount) {
                break;
            }

            const commit = OracleReplyCommitTransactionItem.wrap(txBuffer, Transaction.HEADER_SIZE + commitsCount * OracleReplyCommitTransactionItem.SIZE);
            commit.queryId = BigInt.asUintN(64, replyState.queryId);
            commit.replyDigest.bytes.set(replyState.ownReplyDigest);
            commit.replyKnowledgeProof.bytes.set(this.knowledgeProof(replyState.ownReplyData, replyState.ownReplySize, computorIdx));

            replyState.replyCommitScheduleTick[computorIdx] = txScheduleTick;
            ++commitsCount;
        }

        if (!commitsCount) {
            return 0;
        }

        const tx = Transaction.wrap(txBuffer);
        tx.sourcePublicKey = this.host.computorPublicKey(computorIdx);
        tx.destinationPublicKey = new Uint8Array(DIGEST_SIZE);
        tx.amount = 0n;
        tx.tick = txScheduleTick;
        tx.inputType = OracleReplyCommitTransactionPrefix.transactionType;
        tx.inputSize = commitsCount * OracleReplyCommitTransactionItem.SIZE;

        return index < replyIndices.length ? index : UINT32_MAX;
    }

    processOracleReplyCommitTransaction(transaction: Uint8Array): boolean {
        const tx = Transaction.wrap(transaction);
        if (tx.inputSize < OracleReplyCommitTransactionPrefix.minInputSize || transaction.length < Transaction.HEADER_SIZE + tx.inputSize) {
            return false;
        }

        const compIdx = this.host.computorIndex(tx.sourcePublicKey.bytes);
        if (compIdx < 0) {
            return false;
        }

        const numberOfComputors = this.host.numberOfComputors();
        const quorum = this.host.quorum();
        const itemSize = OracleReplyCommitTransactionItem.SIZE;
        for (let offset = 0; offset + itemSize <= tx.inputSize; offset += itemSize) {
            const item = OracleReplyCommitTransactionItem.wrap(transaction, Transaction.HEADER_SIZE + offset);
            const queryId = BigInt.asIntN(64, item.queryId);
            const queryIndex = this.queryIdToIndex.get(queryId);
            if (queryIndex === undefined) {
                continue;
            }

            const oqm = this.queries[queryIndex];
            if (oqm.status !== ORACLE_STATUS.PENDING && oqm.status !== ORACLE_STATUS.COMMITTED) {
                continue;
            }

            const replyStateIdx = oqm.statusVar.pending!.replyStateIndex;
            const replyState = this.replyStates[replyStateIdx];
            if (replyState?.queryId !== queryId) {
                continue;
            }

            // one commit per computor
            if (replyState.replyCommitTicks[compIdx] !== 0) {
                continue;
            }

            replyState.replyCommitDigests.set(item.replyDigest.bytes, compIdx * DIGEST_SIZE);
            replyState.replyCommitKnowledgeProofs.set(item.replyKnowledgeProof.bytes, compIdx * DIGEST_SIZE);
            replyState.replyCommitTicks[compIdx] = tx.tick;

            // commits with the same digest share a histogram bin
            let histIdx = 0;
            while (
                replyState.replyCommitHistogramCount[histIdx] !== 0 &&
                !rangesEqual(item.replyDigest.bytes, 0, replyState.replyCommitDigests, replyState.replyCommitHistogramIdx[histIdx] * DIGEST_SIZE, DIGEST_SIZE)
            ) {
                ++histIdx;
            }
            if (replyState.replyCommitHistogramCount[histIdx] === 0) {
                replyState.replyCommitHistogramIdx[histIdx] = compIdx;
            }
            ++replyState.replyCommitHistogramCount[histIdx];
            ++replyState.totalCommits;
            if (replyState.replyCommitHistogramCount[histIdx] > replyState.replyCommitHistogramCount[replyState.mostCommitsHistIdx]) {
                replyState.mostCommitsHistIdx = histIdx;
            }

            const mostCommitsCount = replyState.replyCommitHistogramCount[replyState.mostCommitsHistIdx];
            if (mostCommitsCount >= quorum) {
                if (oqm.status !== ORACLE_STATUS.COMMITTED) {
                    oqm.status = ORACLE_STATUS.COMMITTED;
                    this.pendingCommitReplyStateIndices.removeByValue(replyStateIdx);
                    this.pendingRevealReplyStateIndices.add(replyStateIdx);
                    this.logQueryStatusChange(oqm);
                }
            } else if (replyState.totalCommits - mostCommitsCount > numberOfComputors - quorum) {
                // too many commits disagree with the most voted digest, so a quorum cannot form any more
                oqm.status = ORACLE_STATUS.UNRESOLVABLE;
                oqm.statusVar = { failure: { agreeingCommits: mostCommitsCount, totalCommits: replyState.totalCommits } };
                this.pendingQueryIndices.removeByValue(queryIndex);

                this.pendingCommitReplyStateIndices.removeByValue(replyStateIdx);
                this.freeReplyStateSlot(replyStateIdx);

                this.notificationQueryIndexQueue.insert(queryIndex);
                this.logQueryStatusChange(oqm);
            }
        }

        return true;
    }

    // writes all of a reveal transaction except the signature. Returns 0 for no transaction, anything else is the startIdx of the
    // next call. Processing a reveal transaction in between invalidates the startIdx.
    getReplyRevealTransaction(txBuffer: Uint8Array, computorIdx: number, txScheduleTick: number, startIdx = 0): number {
        const tick = this.host.currentTick();
        if (computorIdx >= this.host.numberOfComputors() || txScheduleTick <= tick) {
            return 0;
        }

        const quorum = this.host.quorum();
        const replyIndices = this.pendingRevealReplyStateIndices.values;
        for (let index = startIdx; index < replyIndices.length; ++index) {
            const replyState = this.replyStates[replyIndices[index]];
            if (!replyState || replyState.ownReplySize === 0) {
                continue;
            }
            if (replyState.replyCommitHistogramCount[replyState.mostCommitsHistIdx] < quorum) {
                continue;
            }

            // already scheduled or seen
            if (isScheduledAtOrAfter(replyState.expectedRevealTxTick, tick)) {
                continue;
            }

            // only a node whose own reply is the quorum's reply can reveal it
            const mostCommitsDigestIdx = replyState.replyCommitHistogramIdx[replyState.mostCommitsHistIdx];
            if (!rangesEqual(replyState.replyCommitDigests, mostCommitsDigestIdx * DIGEST_SIZE, replyState.ownReplyDigest, 0, DIGEST_SIZE)) {
                continue;
            }

            const tx = Transaction.wrap(txBuffer);
            tx.sourcePublicKey = this.host.computorPublicKey(computorIdx);
            tx.destinationPublicKey = new Uint8Array(DIGEST_SIZE);
            tx.amount = 0n;
            tx.tick = txScheduleTick;
            tx.inputType = OracleReplyRevealTransactionPrefix.transactionType;
            tx.inputSize = OracleReplyRevealTransactionPrefix.minInputSize + replyState.ownReplySize;
            new DataView(txBuffer.buffer, txBuffer.byteOffset, txBuffer.byteLength).setBigInt64(Transaction.HEADER_SIZE, replyState.queryId, true);
            txBuffer.set(replyState.ownReplyData.subarray(0, replyState.ownReplySize), Transaction.HEADER_SIZE + OracleReplyRevealTransactionPrefix.minInputSize);

            replyState.expectedRevealTxTick = txScheduleTick;
            return index + 1;
        }

        return 0;
    }

    // a reveal transaction seen on the network: this node need not send its own for a tick that is already covered.
    announceExpectedRevealTransaction(transaction: Uint8Array): void {
        const checked = this.checkReplyRevealTransaction(transaction);
        if (!checked) {
            return;
        }

        const tick = Transaction.wrap(transaction).tick;
        if (!checked.replyState.expectedRevealTxTick || checked.replyState.expectedRevealTxTick > tick) {
            checked.replyState.expectedRevealTxTick = tick;
        }
    }

    processOracleReplyRevealTransaction(transaction: Uint8Array, txSlotInTickData: number): boolean {
        const checked = this.checkReplyRevealTransaction(transaction);
        if (!checked) {
            return false;
        }

        const { replyState, queryIndex } = checked;
        const tx = Transaction.wrap(transaction);
        const oqm = this.queries[queryIndex];
        const replyStateIdx = oqm.statusVar.pending!.replyStateIndex;
        const replySize = ORACLE_INTERFACES[oqm.interfaceIndex].reply.SIZE;
        const replyStart = Transaction.HEADER_SIZE + OracleReplyRevealTransactionPrefix.minInputSize;
        const replyData = new Uint8Array(replySize + 2);
        replyData.set(transaction.subarray(replyStart, replyStart + replySize));

        // a commit counts when its digest is the quorum's and its knowledge proof shows the computor knew the reply
        const quorumCommitDigestIdx = replyState.replyCommitHistogramIdx[replyState.mostCommitsHistIdx];
        const quorumCommitDigest = replyState.replyCommitDigests.slice(quorumCommitDigestIdx * DIGEST_SIZE, (quorumCommitDigestIdx + 1) * DIGEST_SIZE);
        const numberOfComputors = this.host.numberOfComputors();
        let correctCommitsCount = 0;
        for (let computorIdx = 0; computorIdx < numberOfComputors; ++computorIdx) {
            if (!rangesEqual(replyState.replyCommitDigests, computorIdx * DIGEST_SIZE, quorumCommitDigest, 0, DIGEST_SIZE)) {
                continue;
            }

            const expectedKnowledgeProof = this.knowledgeProof(replyData, replySize, computorIdx);
            if (rangesEqual(replyState.replyCommitKnowledgeProofs, computorIdx * DIGEST_SIZE, expectedKnowledgeProof, 0, DIGEST_SIZE)) {
                ++correctCommitsCount;
            }
        }

        if (correctCommitsCount < this.host.quorum()) {
            // too many fake commits: the quorum did not confirm the reply
            oqm.status = ORACLE_STATUS.UNRESOLVABLE;
            oqm.statusFlags |= ORACLE_FLAG_FAKE_COMMITS;
            oqm.statusVar = { failure: { agreeingCommits: correctCommitsCount, totalCommits: replyState.totalCommits } };
            this.pendingQueryIndices.removeByValue(queryIndex);

            this.pendingRevealReplyStateIndices.removeByValue(replyStateIdx);
            this.freeReplyStateSlot(replyStateIdx);

            this.notificationQueryIndexQueue.insert(queryIndex);
            this.logQueryStatusChange(oqm);
            return true;
        }

        oqm.statusVar = { success: { revealTick: tx.tick, revealTxIndex: txSlotInTickData } };
        oqm.status = ORACLE_STATUS.SUCCESS;
        this.revealedReplies.set(oqm.queryId, replyData.slice(0, replySize));
        this.pendingQueryIndices.removeByValue(queryIndex);
        if (oqm.type === ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION) {
            this.subscriptions[oqm.typeVar.subscription!.subscriptionId].lastRevealedQueryId = oqm.queryId;
        }

        this.pendingRevealReplyStateIndices.removeByValue(replyStateIdx);
        this.freeReplyStateSlot(replyStateIdx);

        this.notificationQueryIndexQueue.insert(queryIndex);
        this.logQueryStatusChange(oqm);
        return true;
    }

    // once per tick.
    processTimeouts(): void {
        const now = this.host.nowMs();

        // core walks the live array while it removes from it and still visits every entry once, in this order
        for (const queryIndex of [...this.pendingQueryIndices.values]) {
            const oqm = this.queries[queryIndex];
            if (oqm.timeout > now) {
                continue;
            }

            const replyStateIdx = oqm.statusVar.pending!.replyStateIndex;
            const replyState = this.replyStates[replyStateIdx]!;

            oqm.status = ORACLE_STATUS.TIMEOUT;
            oqm.statusVar = { failure: { agreeingCommits: replyState.replyCommitHistogramCount[replyState.mostCommitsHistIdx], totalCommits: replyState.totalCommits } };
            this.pendingQueryIndices.removeByValue(queryIndex);

            this.pendingCommitReplyStateIndices.removeByValue(replyStateIdx);
            this.pendingRevealReplyStateIndices.removeByValue(replyStateIdx);
            this.freeReplyStateSlot(replyStateIdx);

            this.notificationQueryIndexQueue.insert(queryIndex);
            this.logQueryStatusChange(oqm);
        }
    }

    // call until null comes back. The result is one internal buffer, overwritten by the next call.
    getNotification(): InstanceType<typeof OracleNotificationData> | null {
        const queryIndex = this.notificationQueryIndexQueue.peek();
        if (queryIndex === undefined) {
            return null;
        }

        const oqm = this.queries[queryIndex];
        const notification = this.notificationOutputBuffer;
        let subscriptionId = -1;
        if (oqm.type === ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION) {
            // one call per subscriber of the query
            const subscriber = this.subscribers[this.getNotifiedSubscriberIndices(oqm)[this.notificationCurrentSubscriberIdx]];
            notification.contractIndex = subscriber.contractIndex;
            notification.procedureId = subscriber.notificationProcId;
            subscriptionId = oqm.typeVar.subscription!.subscriptionId;

            ++this.notificationCurrentSubscriberIdx;
            if (this.notificationCurrentSubscriberIdx === oqm.typeVar.subscription!.subscriberCount) {
                this.notificationQueryIndexQueue.drop();
                this.notificationCurrentSubscriberIdx = 0;
            }
        } else {
            this.notificationQueryIndexQueue.drop();
            notification.contractIndex = oqm.typeVar.contract!.queryingContract;
            notification.procedureId = oqm.typeVar.contract!.notificationProcId;
        }

        const replySize = ORACLE_INTERFACES[oqm.interfaceIndex].reply.SIZE;
        notification.inputSize = OracleNotificationInput.SIZE + replySize;
        notification.inputBuffer.fill(0, 0, notification.inputSize);
        const input = OracleNotificationInput.wrap(notification.inputBuffer);
        input.queryId = oqm.queryId;
        input.subscriptionId = subscriptionId;
        input.status = oqm.status;
        if (oqm.status === ORACLE_STATUS.SUCCESS) {
            notification.inputBuffer.set(this.getReplyDataFromTickTransactionStorage(oqm), OracleNotificationInput.SIZE);
        }

        return notification;
    }

    // queryData takes the query; its length has to be the interface's query size.
    getOracleQuery(queryId: bigint, queryData: Uint8Array): boolean {
        const queryIndex = this.queryIdToIndex.get(queryId);
        if (queryIndex === undefined) {
            return false;
        }

        const queryMetadata = this.queries[queryIndex];
        if (queryData.length !== ORACLE_INTERFACES[queryMetadata.interfaceIndex].query.SIZE) {
            return false;
        }

        queryData.set(this.getOracleQueryPointerFromMetadata(queryMetadata).subarray(0, queryData.length));
        return true;
    }

    // replyData takes the reply of a successful query; its length has to be the interface's reply size.
    getOracleReply(queryId: bigint, replyData: Uint8Array): boolean {
        const queryIndex = this.queryIdToIndex.get(queryId);
        if (queryIndex === undefined) {
            return false;
        }

        const queryMetadata = this.queries[queryIndex];
        if (queryMetadata.status !== ORACLE_STATUS.SUCCESS) {
            return false;
        }
        if (replyData.length !== ORACLE_INTERFACES[queryMetadata.interfaceIndex].reply.SIZE) {
            return false;
        }

        replyData.set(this.getReplyDataFromTickTransactionStorage(queryMetadata));
        return true;
    }

    getOracleQueryStatus(queryId: bigint): number {
        const queryIndex = this.queryIdToIndex.get(queryId);
        return queryIndex === undefined ? ORACLE_STATUS.UNKNOWN : this.queries[queryIndex].status;
    }

    // ORACLE_FLAG_* bits, which tell whether an oracle machine reply was accepted or rejected.
    getOracleQueryStatusFlags(queryId: bigint): number {
        const queryIndex = this.queryIdToIndex.get(queryId);
        return queryIndex === undefined ? 0 : this.queries[queryIndex].statusFlags;
    }

    // pending queries started by a contract, so a tool can see what an oracle machine would be asked.
    getPendingContractQueries(maxCount: number): PendingContractQuery[] {
        const pendingQueries: PendingContractQuery[] = [];
        for (const queryIndex of this.pendingQueryIndices.values) {
            if (pendingQueries.length >= maxCount) {
                break;
            }

            const queryMetadata = this.queries[queryIndex];
            if (queryMetadata.status !== ORACLE_STATUS.PENDING) {
                continue;
            }

            let contractIndex: number;
            if (queryMetadata.type === ORACLE_QUERY_TYPE_CONTRACT_QUERY) {
                contractIndex = queryMetadata.typeVar.contract!.queryingContract;
            } else {
                const subscriberIndex = this.getNotifiedSubscriberIndices(queryMetadata)[0];
                if (subscriberIndex === undefined) {
                    continue;
                }
                contractIndex = this.subscribers[subscriberIndex].contractIndex;
            }

            pendingQueries.push({ queryId: queryMetadata.queryId, interfaceIndex: queryMetadata.interfaceIndex, contractIndex });
        }
        return pendingQueries;
    }

    getOracleSubscription(subscriptionId: number): OracleSubscription | null {
        return this.subscriptions[subscriptionId] ?? null;
    }

    // expensive: throws on the first thing that is not as expected.
    checkStateConsistencyWithAssert(): void {
        const tick = this.host.currentTick();
        const numberOfComputors = this.host.numberOfComputors();
        const quorum = this.host.quorum();

        assertConsistent(this.queries.length <= MAX_ORACLE_QUERIES, "query count");
        assertConsistent(this.queryStorageBytesUsed <= ORACLE_QUERY_STORAGE_SIZE, "query storage size");
        assertConsistent(this.queries.length === this.queryIdToIndex.size, "query id index size");
        assertConsistent(this.contractQueryIdState.tick <= tick, "query id tick");
        assertConsistent(this.subscriptions.length < MAX_ORACLE_SUBSCRIPTIONS && this.subscribers.length < MAX_ORACLE_SUBSCRIBERS, "subscription slots");

        let pendingCount = 0;
        let committedCount = 0;
        let storageBytesUsed = 8;
        this.queries.forEach((oqm, queryIndex) => {
            const what = `query ${oqm.queryId}`;
            const querySize = ORACLE_INTERFACES[oqm.interfaceIndex]?.query.SIZE;
            assertConsistent(querySize !== undefined, `${what} interface`);
            assertConsistent(this.queryIdToIndex.get(oqm.queryId) === queryIndex, `${what} index`);
            assertConsistent(oqm.queryTick <= tick && oqm.queryId >> 31n === BigInt(oqm.queryTick), `${what} tick`);
            assertConsistent(Number.isFinite(oqm.timeout), `${what} timeout`);

            if (oqm.type === ORACLE_QUERY_TYPE_CONTRACT_QUERY) {
                const contract = oqm.typeVar.contract!;
                assertConsistent(contract.queryingContract > 0 && contract.queryingContract < MAX_NUMBER_OF_CONTRACTS, `${what} contract`);
                assertConsistent(this.queryStorage.has(contract.queryStorageOffset), `${what} storage`);
                storageBytesUsed += querySize;
            } else {
                const subscription = oqm.typeVar.subscription!;
                assertConsistent(subscription.subscriberCount > 0, `${what} subscriber count`);
                assertConsistent(this.subscriptions[subscription.subscriptionId]?.interfaceIndex === oqm.interfaceIndex, `${what} subscription`);
                assertConsistent(this.queryStorage.has(subscription.queryStorageOffset), `${what} storage`);
                storageBytesUsed += querySize + subscription.subscriberCount * SUBSCRIBER_INDEX_SIZE;
                for (const subscriberIndex of this.getNotifiedSubscriberIndices(oqm)) {
                    assertConsistent(this.subscribers[subscriberIndex]?.subscriptionId === subscription.subscriptionId, `${what} subscriber ${subscriberIndex}`);
                }
            }

            if (oqm.status === ORACLE_STATUS.PENDING || oqm.status === ORACLE_STATUS.COMMITTED) {
                const replyState = this.replyStates[oqm.statusVar.pending!.replyStateIndex];
                assertConsistent(replyState?.queryId === oqm.queryId, `${what} reply state`);
                assertConsistent(replyState.ownReplySize === 0 || replyState.ownReplySize === ORACLE_INTERFACES[oqm.interfaceIndex].reply.SIZE, `${what} reply size`);
                const agreeingCommits = replyState.replyCommitHistogramCount[replyState.mostCommitsHistIdx];
                assertConsistent(agreeingCommits <= replyState.totalCommits && replyState.totalCommits <= numberOfComputors, `${what} commits`);
                if (oqm.status === ORACLE_STATUS.PENDING) {
                    ++pendingCount;
                    assertConsistent(agreeingCommits < quorum, `${what} is pending with a quorum`);
                } else {
                    ++committedCount;
                    assertConsistent(agreeingCommits >= quorum, `${what} is committed without a quorum`);
                }
            } else if (oqm.status === ORACLE_STATUS.SUCCESS) {
                const success = oqm.statusVar.success!;
                assertConsistent(success.revealTick <= tick && success.revealTxIndex < TXS_PER_TICK, `${what} reveal`);
            } else {
                const failure = oqm.statusVar.failure!;
                assertConsistent(failure.agreeingCommits <= failure.totalCommits && failure.totalCommits <= numberOfComputors, `${what} failure commits`);
                if (oqm.status === ORACLE_STATUS.UNRESOLVABLE) {
                    assertConsistent(failure.agreeingCommits < quorum, `${what} is unresolvable with a quorum`);
                    if (!(oqm.statusFlags & ORACLE_FLAG_FAKE_COMMITS)) {
                        assertConsistent(failure.totalCommits - failure.agreeingCommits > numberOfComputors - quorum, `${what} is unresolvable while a quorum can form`);
                    }
                }
            }
        });

        assertConsistent(committedCount === this.pendingRevealReplyStateIndices.numValues, "queries waiting for a reveal");
        assertConsistent(pendingCount + committedCount === this.pendingQueryIndices.numValues, "queries not finished");
        for (const queryIndex of this.pendingQueryIndices.values) {
            const status = this.queries[queryIndex]?.status;
            assertConsistent(status === ORACLE_STATUS.PENDING || status === ORACLE_STATUS.COMMITTED, `pending query index ${queryIndex}`);
        }
        for (const replyIdx of this.pendingCommitReplyStateIndices.values) {
            assertConsistent(this.statusOfReplyState(replyIdx) === ORACLE_STATUS.PENDING, `reply state ${replyIdx} waits for commits`);
        }
        for (const replyIdx of this.pendingRevealReplyStateIndices.values) {
            assertConsistent(this.statusOfReplyState(replyIdx) === ORACLE_STATUS.COMMITTED, `reply state ${replyIdx} waits for a reveal`);
        }

        for (const queryIndex of this.notificationQueryIndexQueue.elements()) {
            const status = this.queries[queryIndex]?.status;
            assertConsistent(status !== undefined && status !== ORACLE_STATUS.PENDING, `notification for query index ${queryIndex}`);
        }

        const now = this.host.nowMs();
        this.subscribers.forEach((subscriber, subscriberIndex) => {
            const what = `subscriber ${subscriberIndex}`;
            assertConsistent(subscriber.contractIndex > 0 && subscriber.contractIndex < MAX_NUMBER_OF_CONTRACTS, `${what} contract`);
            assertConsistent(this.subscriptions[subscriber.subscriptionId] !== undefined, `${what} subscription`);
            assertConsistent(subscriber.nextSubscriberIdx >= -1 && subscriber.nextSubscriberIdx < this.subscribers.length, `${what} next subscriber`);
            assertConsistent(subscriber.nextQueryTimestamp >= now || !Number.isFinite(subscriber.nextQueryTimestamp), `${what} next query is in the past`);
            assertConsistent(subscriber.notificationPeriodMinutes >= 1, `${what} period`);
        });

        this.subscriptions.forEach((subscription, subscriptionId) => {
            const what = `subscription ${subscriptionId}`;
            const querySize = ORACLE_INTERFACES[subscription.interfaceIndex]?.query.SIZE;
            assertConsistent(querySize !== undefined, `${what} interface`);
            assertConsistent(subscription.nextQueryTimestamp >= now || !Number.isFinite(subscription.nextQueryTimestamp), `${what} next query is in the past`);
            assertConsistent(this.queryStorage.has(subscription.initialQueryStorageOffset), `${what} storage`);
            assertConsistent(subscription.queryTimestampOffset <= querySize - DATE_AND_TIME_SIZE, `${what} timestamp offset`);
            assertConsistent(subscription.lastPendingQueryId === -1n || this.queryIdToIndex.has(subscription.lastPendingQueryId), `${what} last pending query`);
            assertConsistent(subscription.lastRevealedQueryId === -1n || this.queryIdToIndex.has(subscription.lastRevealedQueryId), `${what} last revealed query`);
            storageBytesUsed += querySize;

            let prevTimestamp = INVALID_TIMESTAMP_SMALLEST;
            let count = 0;
            for (let index = subscription.firstSubscriberIndex; index >= 0; index = this.subscribers[index].nextSubscriberIdx) {
                assertConsistent(this.subscribers[index] !== undefined && ++count <= this.subscribers.length, `${what} subscriber list`);
                assertConsistent(this.subscribers[index].nextQueryTimestamp >= prevTimestamp, `${what} subscriber list order`);
                prevTimestamp = this.subscribers[index].nextQueryTimestamp;
            }
        });
        assertConsistent(storageBytesUsed === this.queryStorageBytesUsed, "query storage bytes");
    }

    protected statusOfReplyState(replyIdx: number): number | undefined {
        const replyState = this.replyStates[replyIdx];
        const queryIndex = replyState && this.queryIdToIndex.get(replyState.queryId);
        return queryIndex === undefined ? undefined : this.queries[queryIndex].status;
    }

    protected getEmptyReplyStateSlot(): number {
        for (let attempt = 0; attempt < MAX_SIMULTANEOUS_ORACLE_QUERIES; ++attempt) {
            if (!this.replyStates[this.replyStatesIndex]) {
                return this.replyStatesIndex;
            }

            ++this.replyStatesIndex;
            if (this.replyStatesIndex >= MAX_SIMULTANEOUS_ORACLE_QUERIES) {
                this.replyStatesIndex = 0;
            }
        }
        return UINT32_MAX;
    }

    protected freeReplyStateSlot(replyStateIdx: number): void {
        this.replyStates[replyStateIdx] = undefined;
    }

    // keeps the subscription's list sorted by nextQueryTimestamp.
    protected addSubscriberToSubscriptionsSortedList(subscriptionId: number, subscriberIdxToInsert: number): void {
        const subscription = this.subscriptions[subscriptionId];
        const inserted = this.subscribers[subscriberIdxToInsert];
        if (subscription.firstSubscriberIndex < 0) {
            inserted.nextSubscriberIdx = -1;
            subscription.firstSubscriberIndex = subscriberIdxToInsert;
            return;
        }

        const insertTimestamp = inserted.nextQueryTimestamp;
        if (insertTimestamp <= this.subscribers[subscription.firstSubscriberIndex].nextQueryTimestamp) {
            inserted.nextSubscriberIdx = subscription.firstSubscriberIndex;
            subscription.firstSubscriberIndex = subscriberIdxToInsert;
            return;
        }

        let prevIdx = subscription.firstSubscriberIndex;
        let nextIdx = this.subscribers[prevIdx].nextSubscriberIdx;
        while (nextIdx >= 0 && insertTimestamp > this.subscribers[nextIdx].nextQueryTimestamp) {
            prevIdx = nextIdx;
            nextIdx = this.subscribers[prevIdx].nextSubscriberIdx;
        }
        this.subscribers[prevIdx].nextSubscriberIdx = subscriberIdxToInsert;
        inserted.nextSubscriberIdx = nextIdx;
    }

    // an absolute point in time, or an invalid one when the timeout is too long.
    protected getTimeoutTimestamp(baseTime: number, timeoutMilliseconds: number): number {
        if (timeoutMilliseconds >>> 0 > MAX_ORACLE_TIMEOUT_MILLISEC) {
            return INVALID_TIMESTAMP_SMALLEST;
        }
        return baseTime + (timeoutMilliseconds >>> 0);
    }

    // the id of a query that no transaction started: the tick, then an index that starts past the tick's transactions.
    protected getNewNonTxQueryId(): bigint {
        const tick = this.host.currentTick();
        const idState = this.contractQueryIdState;
        if (idState.tick < tick) {
            idState.tick = tick;
            idState.queryIndexInTick = TXS_PER_TICK;
        } else {
            if (idState.queryIndexInTick >= 0x7fffffff) {
                return -1n;
            }
            ++idState.queryIndexInTick;
        }

        return (BigInt(tick) << 31n) | BigInt(idState.queryIndexInTick);
    }

    protected startQuery(queryId: bigint, queryType: number, interfaceIndex: number, timeout: number, queryStorageBytesToAdd: number): OracleQueryMetadata | null {
        const full =
            this.queries.length >= MAX_ORACLE_QUERIES ||
            this.pendingQueryIndices.numValues >= MAX_SIMULTANEOUS_ORACLE_QUERIES ||
            this.queryStorageBytesUsed + queryStorageBytesToAdd > ORACLE_QUERY_STORAGE_SIZE;
        if (full) {
            return null;
        }

        const replyStateSlotIdx = this.getEmptyReplyStateSlot();
        if (replyStateSlotIdx >= MAX_SIMULTANEOUS_ORACLE_QUERIES) {
            return null;
        }

        const queryIndex = this.queries.length;
        this.queryIdToIndex.set(queryId, queryIndex);
        this.pendingQueryIndices.add(queryIndex);

        const numberOfComputors = this.host.numberOfComputors();
        this.replyStates[replyStateSlotIdx] = {
            queryId,
            ownReplyDigest: new Uint8Array(DIGEST_SIZE),
            ownReplySize: 0,
            ownReplyData: new Uint8Array(MAX_ORACLE_REPLY_SIZE + 2),
            replyCommitScheduleTick: new Uint32Array(numberOfComputors),
            replyCommitDigests: new Uint8Array(numberOfComputors * DIGEST_SIZE),
            replyCommitKnowledgeProofs: new Uint8Array(numberOfComputors * DIGEST_SIZE),
            replyCommitTicks: new Uint32Array(numberOfComputors),
            replyCommitHistogramIdx: new Uint16Array(numberOfComputors),
            replyCommitHistogramCount: new Uint16Array(numberOfComputors),
            mostCommitsHistIdx: 0,
            totalCommits: 0,
            expectedRevealTxTick: 0,
        };

        const queryMetadata: OracleQueryMetadata = {
            queryId,
            type: queryType,
            status: ORACLE_STATUS.PENDING,
            statusFlags: ORACLE_FLAG_REPLY_PENDING,
            queryTick: this.host.currentTick(),
            timeout,
            interfaceIndex,
            typeVar: {},
            statusVar: { pending: { replyStateIndex: replyStateSlotIdx } },
        };
        this.queries.push(queryMetadata);
        return queryMetadata;
    }

    // core keys the record by the querying contract, or by the subscription id for a subscription's query, in an otherwise zero id.
    protected logQueryStatusChange(oqm: OracleQueryMetadata): void {
        if (!this.host.log) {
            return;
        }

        const queryingEntity = new Uint8Array(DIGEST_SIZE);
        const key = oqm.type === ORACLE_QUERY_TYPE_CONTRACT_QUERY ? oqm.typeVar.contract!.queryingContract : oqm.typeVar.subscription!.subscriptionId;
        new DataView(queryingEntity.buffer).setBigUint64(0, BigInt(key), true);
        this.host.log(QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE, encodeOracleQueryStatusChangeLog(queryingEntity, oqm.queryId, oqm.interfaceIndex, oqm.type, oqm.status));
    }

    // K12 of the reply and the computor index: only a computor that knows the reply can make it.
    protected knowledgeProof(replyData: Uint8Array, replySize: number, computorIdx: number): Uint8Array {
        new DataView(replyData.buffer, replyData.byteOffset, replyData.byteLength).setUint16(replySize, computorIdx, true);
        return k12Bytes(replyData.subarray(0, replySize + 2));
    }

    // the reply state and the query index of a reveal transaction that is in order, null otherwise.
    protected checkReplyRevealTransaction(transaction: Uint8Array): { replyState: OracleReplyState; queryIndex: number } | null {
        const tx = Transaction.wrap(transaction);
        if (tx.inputSize < OracleReplyRevealTransactionPrefix.minInputSize || transaction.length < Transaction.HEADER_SIZE + tx.inputSize) {
            return null;
        }

        if (this.host.computorIndex(tx.sourcePublicKey.bytes) < 0) {
            return null;
        }

        const queryId = new DataView(transaction.buffer, transaction.byteOffset, transaction.byteLength).getBigInt64(Transaction.HEADER_SIZE, true);
        const queryIndex = this.queryIdToIndex.get(queryId);
        if (queryIndex === undefined) {
            return null;
        }

        const oqm = this.queries[queryIndex];
        if (oqm.status !== ORACLE_STATUS.COMMITTED) {
            return null;
        }

        const replySize = tx.inputSize - OracleReplyRevealTransactionPrefix.minInputSize;
        if (replySize !== ORACLE_INTERFACES[oqm.interfaceIndex].reply.SIZE) {
            oqm.statusFlags |= ORACLE_FLAG_BAD_SIZE_REVEAL;
            return null;
        }

        const replyState = this.replyStates[oqm.statusVar.pending!.replyStateIndex];
        if (replyState?.queryId !== queryId) {
            return null;
        }

        // the revealed reply has to be the one the quorum committed to
        const revealDigest = k12Bytes(tx.input.subarray(OracleReplyRevealTransactionPrefix.minInputSize));
        const mostCommitsDigestIdx = replyState.replyCommitHistogramIdx[replyState.mostCommitsHistIdx];
        if (!rangesEqual(revealDigest, 0, replyState.replyCommitDigests, mostCommitsDigestIdx * DIGEST_SIZE, DIGEST_SIZE)) {
            return null;
        }

        return { replyState, queryIndex };
    }

    protected getReplyDataFromTickTransactionStorage(queryMetadata: OracleQueryMetadata): Uint8Array {
        return this.revealedReplies.get(queryMetadata.queryId)!;
    }

    protected getNotifiedSubscriberIndices(queryMetadata: OracleQueryMetadata): number[] {
        const subscription = queryMetadata.typeVar.subscription;
        if (!subscription) {
            return [];
        }

        const stored = this.queryStorage.get(subscription.queryStorageOffset)!;
        const view = new DataView(stored.buffer, stored.byteOffset, stored.byteLength);
        const querySize = ORACLE_INTERFACES[queryMetadata.interfaceIndex].query.SIZE;
        return Array.from({ length: subscription.subscriberCount }, (_unused, position) => view.getInt32(querySize + position * SUBSCRIBER_INDEX_SIZE, true));
    }

    protected getOracleQueryPointerFromMetadata(queryMetadata: OracleQueryMetadata): Uint8Array {
        const offset = (queryMetadata.typeVar.contract ?? queryMetadata.typeVar.subscription)!.queryStorageOffset;
        return this.queryStorage.get(offset)!;
    }
}
