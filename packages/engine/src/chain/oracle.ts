import { packDateAndTime } from "../contract/runtime";
import { ORACLE_INTERFACES } from "../oracle-interfaces/registry";
import { encodeOracleQueryStatusChangeLog, encodeOracleSubscriberLog, MAX_ORACLE_REPLY_SIZE, ORACLE_STATUS, QUBIC_LOG_TYPE } from "@qinit/proto";

export { ORACLE_STATUS };

const NOTIFY_HEADER_SIZE = 16;
const MAX_QUERY_TIMEOUT_MS = 3_600_000;
const SUBSCRIPTION_TIMEOUT_MS = 60_000;
const MIN_QUERY_FEE = 10n;
const MIN_SUBSCRIPTION_FEE = 100n;
const MIN_SUBSCRIPTION_PERIOD_MS = 60_000;
const MAX_SUBSCRIPTION_PERIOD_MS = 24 * 60 * 60_000;
// core's ORACLE_QUERY_TYPE_*: who a query's status records are keyed by.
const QUERY_TYPE_CONTRACT_QUERY = 0;
const QUERY_TYPE_CONTRACT_SUBSCRIPTION = 1;

interface OracleRecipient {
    slot: number;
    notificationProcId: number;
}

interface OracleQueryRec {
    id: bigint;
    interfaceIndex: number;
    query: Uint8Array;
    replySize: number;
    status: number;
    reply: Uint8Array | null;
    subscriptionId: number;
    deadlineMs: number;
    recipients: OracleRecipient[];
}

interface OracleSubscriber extends OracleRecipient {
    periodMs: number;
    nextQueryMs: number;
}

interface OracleChannel {
    id: number;
    key: string;
    interfaceIndex: number;
    initialQuery: Uint8Array;
    replySize: number;
    timestampOffset: number;
    subscribers: Map<number, OracleSubscriber>;
    lastQueryId: bigint | null;
    lastReply: Uint8Array | null;
}

export interface OracleHost {
    energyOf(slot: number): bigint;
    decreaseEnergyOf(slot: number, amount: bigint): void;
    refundEnergyOf(slot: number, amount: bigint): void;
    notify(slot: number, procId: number, input: Uint8Array): void;
    nowMs(): number;
    // a node with a log stream records every status change and every subscriber that comes or goes, as core does.
    log?(type: number, message: Uint8Array): void;
}

const gcd = (left: number, right: number): number => {
    while (right) [left, right] = [right, left % right];
    return left;
};

function channelKey(interfaceIndex: number, query: Uint8Array, timestampOffset: number): string {
    let key = `${interfaceIndex}:`;
    for (let index = 0; index < query.length; index++) {
        if (index < timestampOffset || index >= timestampOffset + 8) key += query[index].toString(16).padStart(2, "0");
    }
    return key;
}

export class OracleManager {
    private readonly host: OracleHost;
    private queries = new Map<bigint, OracleQueryRec>();
    private channels = new Map<number, OracleChannel>();
    private channelIds = new Map<string, number>();
    private nextQueryId = 1n;
    private nextSubscriptionId = 0;
    private provider: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null = null;

    constructor(host: OracleHost) {
        this.host = host;
    }

    startContractQuery(
        slot: number,
        interfaceIndex: number,
        query: Uint8Array,
        replySize: number,
        notificationProcId: number,
        timeoutMillisec: number,
        _wasmFee: bigint,
    ): bigint {
        const oracleInterface = ORACLE_INTERFACES[interfaceIndex];
        if (!oracleInterface || query.length !== oracleInterface.query.SIZE || replySize !== oracleInterface.reply.SIZE) {
            this.fire(slot, notificationProcId, -1n, -1, ORACLE_STATUS.UNKNOWN, replySize);
            return -1n;
        }

        const queryFee = oracleInterface.getQueryFee(query);
        if (queryFee < MIN_QUERY_FEE || !this.chargeFee(slot, queryFee)) {
            this.fire(slot, notificationProcId, -1n, -1, ORACLE_STATUS.UNKNOWN, replySize);
            return -1n;
        }

        // core takes the fee before its engine looks at the timeout, and hands it back when the engine refuses, so both transfers reach the log.
        if (timeoutMillisec < 0 || timeoutMillisec > MAX_QUERY_TIMEOUT_MS) {
            this.host.refundEnergyOf(slot, queryFee);
            this.fire(slot, notificationProcId, -1n, -1, ORACLE_STATUS.UNKNOWN, replySize);
            return -1n;
        }

        return this.enqueueOracleQuery(interfaceIndex, query, replySize, -1, timeoutMillisec, [{ slot, notificationProcId }]);
    }

    startContractSubscription(
        slot: number,
        interfaceIndex: number,
        query: Uint8Array,
        replySize: number,
        timestampOffset: number,
        notificationProcId: number,
        periodMillisec: number,
        notifyPrevious: boolean,
        fee: bigint,
    ): number {
        const oracleInterface = ORACLE_INTERFACES[interfaceIndex];
        const valid =
            oracleInterface !== undefined &&
            query.length === oracleInterface.query.SIZE &&
            replySize === oracleInterface.reply.SIZE &&
            timestampOffset >= 0 &&
            timestampOffset + 8 <= query.length &&
            fee >= MIN_SUBSCRIPTION_FEE;

        if (!valid || !this.chargeFee(slot, fee)) {
            this.fire(slot, notificationProcId, -1n, -1, ORACLE_STATUS.UNKNOWN, replySize);
            return -1;
        }

        const periodValid =
            periodMillisec >= MIN_SUBSCRIPTION_PERIOD_MS && periodMillisec <= MAX_SUBSCRIPTION_PERIOD_MS && periodMillisec % MIN_SUBSCRIPTION_PERIOD_MS === 0;
        const key = channelKey(interfaceIndex, query, timestampOffset);
        const existingId = this.channelIds.get(key);
        const existing = existingId === undefined ? undefined : this.channels.get(existingId);

        // the period and a repeated subscription are the engine's to refuse, which core asks only once the fee is taken; the fee comes back.
        if (!periodValid || existing?.subscribers.has(slot)) {
            this.host.refundEnergyOf(slot, fee);
            this.fire(slot, notificationProcId, -1n, -1, ORACLE_STATUS.UNKNOWN, replySize);
            return -1;
        }

        const now = this.host.nowMs();
        const channel = existing ?? this.createChannel(key, interfaceIndex, query, replySize, timestampOffset);
        let nextQueryMs = now;
        if (channel.subscribers.size) {
            let reference: OracleSubscriber | undefined;
            let greatestDivisor = -1;
            for (const subscriber of channel.subscribers.values()) {
                const divisor = gcd(periodMillisec, subscriber.periodMs);
                if (divisor > greatestDivisor) {
                    greatestDivisor = divisor;
                    reference = subscriber;
                }
            }
            const periodsUntilReference = Math.floor(Math.max(0, reference!.nextQueryMs - now) / periodMillisec);
            nextQueryMs = reference!.nextQueryMs - periodsUntilReference * periodMillisec;
        }

        channel.subscribers.set(slot, {
            slot,
            notificationProcId,
            periodMs: periodMillisec,
            nextQueryMs,
        });
        this.host.log?.(
            QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE,
            encodeOracleSubscriberLog(channel.id, interfaceIndex, slot, periodMillisec, packDateAndTime(nextQueryMs)),
        );

        if (notifyPrevious && channel.lastQueryId !== null && channel.lastReply) {
            this.fire(slot, notificationProcId, channel.lastQueryId, channel.id, ORACLE_STATUS.SUCCESS, replySize, channel.lastReply);
        }

        if (channel.subscribers.size === 1) this.emitDueChannel(channel, now);
        return channel.id;
    }

    stopContractSubscription(slot: number, subscriptionId: number): number {
        const channel = this.channels.get(subscriptionId);
        if (!channel?.subscribers.delete(slot)) {
            return 0;
        }

        this.host.log?.(QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, encodeOracleSubscriberLog(subscriptionId, channel.interfaceIndex, slot, 0, 0n));
        return 1;
    }

    beginEpoch(): void {
        this.queries.clear();
        this.channels.clear();
        this.channelIds.clear();
        this.nextQueryId = 1n;
        this.nextSubscriptionId = 0;
    }

    private createChannel(key: string, interfaceIndex: number, query: Uint8Array, replySize: number, timestampOffset: number): OracleChannel {
        const channel: OracleChannel = {
            id: this.nextSubscriptionId++,
            key,
            interfaceIndex,
            initialQuery: query.slice(),
            replySize,
            timestampOffset,
            subscribers: new Map(),
            lastQueryId: null,
            lastReply: null,
        };
        this.channels.set(channel.id, channel);
        this.channelIds.set(key, channel.id);
        return channel;
    }

    private enqueueOracleQuery(
        interfaceIndex: number,
        query: Uint8Array,
        replySize: number,
        subscriptionId: number,
        timeoutMillisec: number,
        recipients: OracleRecipient[],
        baseTimeMs: number = this.host.nowMs(),
    ): bigint {
        const id = this.nextQueryId++;
        this.queries.set(id, {
            id,
            interfaceIndex,
            query: query.slice(),
            replySize,
            status: ORACLE_STATUS.PENDING,
            reply: null,
            subscriptionId,
            deadlineMs: baseTimeMs + timeoutMillisec,
            recipients: recipients.map((recipient) => ({ ...recipient })),
        });
        this.logStatusChange(this.queries.get(id)!);
        return id;
    }

    // core keys the record by the querying contract's index, or by the subscription id for a subscription's query, in an otherwise zero id.
    private logStatusChange(query: OracleQueryRec): void {
        if (!this.host.log) {
            return;
        }

        const subscribed = query.subscriptionId >= 0;
        const queryingEntity = new Uint8Array(32);
        new DataView(queryingEntity.buffer).setBigUint64(0, BigInt(subscribed ? query.subscriptionId : (query.recipients[0]?.slot ?? 0)), true);
        this.host.log(
            QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE,
            encodeOracleQueryStatusChangeLog(
                queryingEntity,
                query.id,
                query.interfaceIndex,
                subscribed ? QUERY_TYPE_CONTRACT_SUBSCRIPTION : QUERY_TYPE_CONTRACT_QUERY,
                query.status,
            ),
        );
    }

    private chargeFee(slot: number, fee: bigint): boolean {
        if (fee < 0n || this.host.energyOf(slot) < fee) return false;
        if (fee) this.host.decreaseEnergyOf(slot, fee);
        return true;
    }

    private emitDueChannel(channel: OracleChannel, now: number): void {
        while (channel.subscribers.size) {
            const queryTimestamp = Math.min(...[...channel.subscribers.values()].map((subscriber) => subscriber.nextQueryMs));
            if (queryTimestamp > now) return;

            const due = [...channel.subscribers.values()].filter((subscriber) => subscriber.nextQueryMs <= queryTimestamp);
            for (const subscriber of due) {
                do subscriber.nextQueryMs += subscriber.periodMs;
                while (subscriber.nextQueryMs < now);
            }

            const query = channel.initialQuery.slice();
            new DataView(query.buffer, query.byteOffset, query.byteLength).setBigUint64(channel.timestampOffset, packDateAndTime(queryTimestamp), true);
            this.enqueueOracleQuery(channel.interfaceIndex, query, channel.replySize, channel.id, SUBSCRIPTION_TIMEOUT_MS, due, queryTimestamp);
        }
    }

    resolve(queryId: bigint, reply: Uint8Array, status: number = ORACLE_STATUS.SUCCESS): boolean {
        const query = this.queries.get(queryId);
        if (!query || (query.status !== ORACLE_STATUS.PENDING && query.status !== ORACLE_STATUS.COMMITTED)) return false;

        if (status === ORACLE_STATUS.COMMITTED) {
            query.status = status;
            this.logStatusChange(query);
            return true;
        }
        if (status !== ORACLE_STATUS.SUCCESS && status !== ORACLE_STATUS.TIMEOUT && status !== ORACLE_STATUS.UNRESOLVABLE) return false;
        if (status === ORACLE_STATUS.SUCCESS && reply.length !== query.replySize) return false;

        // unresolvable is what the quorum decides when it disagrees; one oracle machine can only report that it has no value, and the query then ends at its deadline.
        if (status === ORACLE_STATUS.UNRESOLVABLE) {
            return true;
        }

        // a reply the quorum has committed to is only revealed in a later tick, so success and the notification wait for the next tick as they do on a node.
        if (status === ORACLE_STATUS.SUCCESS) {
            query.status = ORACLE_STATUS.COMMITTED;
            query.reply = reply.slice();
            this.logStatusChange(query);
            return true;
        }

        query.status = status;
        query.reply = null;
        this.logStatusChange(query);
        this.notifyRecipients(query);
        return true;
    }

    private reveal(query: OracleQueryRec): void {
        query.status = ORACLE_STATUS.SUCCESS;
        this.logStatusChange(query);
        if (query.subscriptionId >= 0) {
            const channel = this.channels.get(query.subscriptionId);
            if (channel) {
                channel.lastQueryId = query.id;
                channel.lastReply = query.reply!;
            }
        }
        this.notifyRecipients(query);
    }

    private notifyRecipients(query: OracleQueryRec): void {
        for (const recipient of query.recipients) {
            this.fire(recipient.slot, recipient.notificationProcId, query.id, query.subscriptionId, query.status, query.replySize, query.reply ?? undefined);
        }
    }

    setProvider(fn: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null): void {
        this.provider = fn;
    }

    private fire(
        slot: number,
        notificationProcId: number,
        queryId: bigint,
        subscriptionId: number,
        status: number,
        replySize: number,
        reply?: Uint8Array,
    ): void {
        const safeReplySize = Math.min(MAX_ORACLE_REPLY_SIZE, Math.max(0, replySize));
        const input = new Uint8Array(NOTIFY_HEADER_SIZE + safeReplySize);
        const view = new DataView(input.buffer);
        view.setBigInt64(0, queryId, true);
        view.setInt32(8, subscriptionId, true);
        input[12] = status & 0xff;
        if (reply) input.set(reply.subarray(0, safeReplySize), NOTIFY_HEADER_SIZE);
        this.host.notify(slot, notificationProcId, input);
    }

    pump(): void {
        // a committed reply is revealed first, so a reply that arrived before this tick cannot be overtaken by the deadline below.
        for (const query of [...this.queries.values()]) {
            if (query.status === ORACLE_STATUS.COMMITTED && query.reply) this.reveal(query);
        }

        if (this.provider) {
            for (const query of [...this.queries.values()]) {
                if (query.status !== ORACLE_STATUS.PENDING) continue;
                const reply = this.provider(query.interfaceIndex, query.query);
                if (reply) this.resolve(query.id, reply);
            }
        }

        const now = this.host.nowMs();
        for (const channel of this.channels.values()) this.emitDueChannel(channel, now);
        for (const query of [...this.queries.values()]) {
            if (query.reply) continue;
            if ((query.status === ORACLE_STATUS.PENDING || query.status === ORACLE_STATUS.COMMITTED) && query.deadlineMs <= now)
                this.resolve(query.id, new Uint8Array(0), ORACLE_STATUS.TIMEOUT);
        }
    }

    getOracleQueryStatus(queryId: bigint): number {
        return this.queries.get(queryId)?.status ?? ORACLE_STATUS.UNKNOWN;
    }

    getOracleQuery(queryId: bigint): Uint8Array | null {
        return this.queries.get(queryId)?.query ?? null;
    }

    getOracleReply(queryId: bigint): Uint8Array | null {
        const query = this.queries.get(queryId);
        return query?.status === ORACLE_STATUS.SUCCESS ? query.reply : null;
    }

    pending(): { queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[] {
        const pending = [];
        for (const query of this.queries.values()) {
            if (query.status !== ORACLE_STATUS.PENDING) continue;
            for (const recipient of query.recipients) {
                pending.push({
                    queryId: query.id,
                    slot: recipient.slot,
                    interfaceIndex: query.interfaceIndex,
                    query: query.query,
                });
                break;
            }
        }
        return pending;
    }
}
