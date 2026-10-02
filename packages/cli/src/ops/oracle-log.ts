// The oracle and OC records of a node's log stream, decoded: query status changes (14), subscriptions (15), OC invocation status changes (16),
// and the fee each request is paid with — burned to the zero id right ahead of its record, or handed straight back when the request is refused.
import {
    OC_INVOCATION_STATUS,
    ORACLE_QUERY_TYPE_CONTRACT_QUERY,
    ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION,
    ORACLE_STATUS,
    OcInvocationStatusChange,
    OracleQueryStatusChange,
    OracleSubscriberLogMessage,
    QUBIC_LOG_TYPE,
    QuTransfer,
} from "@qinit/proto";
import { ORACLE_INTERFACES } from "@qinit/engine/oracle-interfaces/registry";
import type { NodeLogRecord } from "./node-logs";

export type OracleLogEntry =
    | { tick: number; range: number; record: "query"; queryId: string; owner: "contract" | "subscription" | "user"; ownerId: number; interface: string; status: string }
    | { tick: number; range: number; record: "subscription"; subscriptionId: number; contract: number; interface: string; periodMs: number; firstQuery: string }
    | { tick: number; range: number; record: "unsubscription"; subscriptionId: number; contract: number; interface: string }
    | { tick: number; range: number; record: "oc"; invocationId: string; contract: number; interfaceIndex: number; status: string }
    | { tick: number; range: number; record: "fee"; contract: number; amount: string; direction: "burned" | "refunded" };

const nameOf = (table: Record<string, number>, value: number) => Object.keys(table).find((name) => table[name] === value) ?? String(value);
export const interfaceName = (index: number) => ORACLE_INTERFACES[index]?.name ?? `interface ${index}`;

// A contract's id is its slot in the first four bytes and zeros after; the zero id is where a fee is burned and where a refund comes from.
function contractSlot(key: Uint8Array): number | null {
    if (key.length !== 32 || key.subarray(8).some((byte) => byte !== 0)) return null;
    const view = new DataView(key.buffer, key.byteOffset, 8);
    return view.getUint32(4, true) === 0 && view.getUint32(0, true) !== 0 ? view.getUint32(0, true) : null;
}
const isZero = (key: Uint8Array) => key.every((byte) => byte === 0);

function view(message: Uint8Array): DataView {
    return new DataView(message.buffer, message.byteOffset, message.byteLength);
}

type ZeroTransfer = { contract: number; amount: bigint; direction: "burned" | "refunded" };

// a contract's transfer to or from the zero id: the shape of a fee and of its refund, and of a donation or a plain burn as well.
function zeroTransfer(record: NodeLogRecord | undefined): ZeroTransfer | null {
    if (record?.type !== QUBIC_LOG_TYPE.QU_TRANSFER || record.message.length < QuTransfer.OFFSETS.amount + 8) return null;
    const at = QuTransfer.OFFSETS;
    const source = record.message.subarray(at.sourcePublicKey, at.sourcePublicKey + 32);
    const destination = record.message.subarray(at.destinationPublicKey, at.destinationPublicKey + 32);
    const amount = view(record.message).getBigInt64(at.amount, true);
    if (amount <= 0n) return null;
    const burner = isZero(destination) ? contractSlot(source) : null;
    const refunded = isZero(source) ? contractSlot(destination) : null;
    if (burner !== null) return { contract: burner, amount, direction: "burned" };
    return refunded !== null ? { contract: refunded, amount, direction: "refunded" } : null;
}

// the contract a record was paid for by: its own query, a subscription it opens, or an OC invocation.
function payingContract(record: NodeLogRecord | undefined): number | null {
    if (!record) return null;
    const data = view(record.message);
    if (record.type === QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE && record.message.length >= OracleQueryStatusChange.OFFSETS._terminator) {
        const at = OracleQueryStatusChange.OFFSETS;
        return record.message[at.type] === ORACLE_QUERY_TYPE_CONTRACT_QUERY ? data.getUint32(at.queryingEntity, true) : null;
    }
    if (record.type === QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE && record.message.length >= OracleSubscriberLogMessage.OFFSETS._terminator) {
        const at = OracleSubscriberLogMessage.OFFSETS;
        return data.getUint32(at.periodInMilliseconds, true) > 0 ? data.getUint32(at.contractIndex, true) : null;
    }
    if (record.type === QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE && record.message.length >= OcInvocationStatusChange.OFFSETS._terminator) {
        return data.getUint32(OcInvocationStatusChange.OFFSETS.contractIndex, true);
    }
    return null;
}

const refunds = (burn: ZeroTransfer | null, refund: ZeroTransfer | null) =>
    burn?.direction === "burned" && refund?.direction === "refunded" && burn.contract === refund.contract && burn.amount === refund.amount;

export function oracleLogEntries(records: readonly NodeLogRecord[]): OracleLogEntry[] {
    const entries: OracleLogEntry[] = [];
    for (const [index, record] of records.entries()) {
        const { tick, range, type, message } = record;
        if (type === QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE && message.length >= OracleQueryStatusChange.OFFSETS._terminator) {
            const at = OracleQueryStatusChange.OFFSETS;
            const data = view(message);
            const kind = message[at.type];
            // core keys the record by the querying contract, or by the subscription id for a subscription's query
            entries.push({
                tick,
                range,
                record: "query",
                queryId: String(data.getBigInt64(at.queryId, true)),
                owner: kind === ORACLE_QUERY_TYPE_CONTRACT_QUERY ? "contract" : kind === ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION ? "subscription" : "user",
                ownerId: data.getUint32(at.queryingEntity, true),
                interface: interfaceName(data.getUint32(at.interfaceIndex, true)),
                status: nameOf(ORACLE_STATUS, message[at.status]),
            });
        } else if (type === QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE && message.length >= OracleSubscriberLogMessage.OFFSETS._terminator) {
            const at = OracleSubscriberLogMessage.OFFSETS;
            const data = view(message);
            const subscriber = {
                subscriptionId: data.getInt32(at.subscriptionId, true),
                contract: data.getUint32(at.contractIndex, true),
                interface: interfaceName(data.getUint32(at.interfaceIndex, true)),
            };
            const periodMs = data.getUint32(at.periodInMilliseconds, true);
            // both engines log an unsubscribe as a subscriber record with a period of zero
            if (periodMs === 0) entries.push({ tick, range, record: "unsubscription", ...subscriber });
            else entries.push({ tick, range, record: "subscription", ...subscriber, periodMs, firstQuery: String(data.getBigUint64(at.firstQueryDateAndTime, true)) });
        } else if (type === QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE && message.length >= OcInvocationStatusChange.OFFSETS._terminator) {
            const at = OcInvocationStatusChange.OFFSETS;
            const data = view(message);
            entries.push({
                tick,
                range,
                record: "oc",
                invocationId: String(data.getBigInt64(at.invocationId, true)),
                contract: data.getUint32(at.contractIndex, true),
                interfaceIndex: data.getUint32(at.interfaceIndex, true),
                status: nameOf(OC_INVOCATION_STATUS, message[at.status]),
            });
        } else {
            // a fee is the transfer right ahead of the record it pays for, in the same range; a refused request's comes straight back instead.
            // any other transfer of this shape (a donation, a contract's own burn) belongs to neither engine and is left out.
            const moved = zeroTransfer(record);
            const beside = (other: NodeLogRecord | undefined) => (other?.tick === tick && other.range === range ? other : undefined);
            const next = beside(records[index + 1]);
            const paid = moved?.direction === "burned" && (payingContract(next) === moved.contract || refunds(moved, zeroTransfer(next)));
            const returned = moved?.direction === "refunded" && refunds(zeroTransfer(beside(records[index - 1])), moved);
            if (moved && (paid || returned)) entries.push({ tick, range, record: "fee", contract: moved.contract, amount: String(moved.amount), direction: moved.direction });
        }
    }
    return entries;
}

// e.g. "query 5927054872576 · Price · contract 31 → SUCCESS", "OC 6064493826048 · contract 31 → AUTHORIZED", "fee 10 burned by contract 31";
// the OC interface index is in the JSON form only, so a core-length tick still leaves the row its width
export function oracleLogText(entry: OracleLogEntry): string {
    switch (entry.record) {
        case "query":
            return `query ${entry.queryId} · ${entry.interface} · ${entry.owner} ${entry.ownerId} → ${entry.status}`;
        case "subscription":
            return `subscription ${entry.subscriptionId} · ${entry.interface} · contract ${entry.contract} · every ${entry.periodMs} ms`;
        case "unsubscription":
            return `unsubscription ${entry.subscriptionId} · ${entry.interface} · contract ${entry.contract}`;
        case "oc":
            return `OC ${entry.invocationId} · contract ${entry.contract} → ${entry.status}`;
        case "fee":
            return `fee ${entry.amount} ${entry.direction === "burned" ? "burned by" : "refunded to"} contract ${entry.contract}`;
    }
}
