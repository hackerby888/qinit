// The oracle and OC records of a node's log stream, decoded: query status changes (14), subscriptions (15), OC invocation status changes (16),
// and the fee transfers they come with — a contract's fee burned to the zero id, and a refused request's fee coming back from it.
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
    | { tick: number; range: number; record: "oc"; invocationId: string; contract: number; interfaceIndex: number; status: string }
    | { tick: number; range: number; record: "fee"; contract: number; amount: string; direction: "burned" | "refunded" };

const nameOf = (table: Record<string, number>, value: number) => Object.keys(table).find((name) => table[name] === value) ?? String(value);
const interfaceName = (index: number) => ORACLE_INTERFACES[index]?.name ?? `interface ${index}`;

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

export function oracleLogEntries(records: readonly NodeLogRecord[]): OracleLogEntry[] {
    const entries: OracleLogEntry[] = [];
    for (const { tick, range, type, message } of records) {
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
            entries.push({
                tick,
                range,
                record: "subscription",
                subscriptionId: data.getInt32(at.subscriptionId, true),
                contract: data.getUint32(at.contractIndex, true),
                interface: interfaceName(data.getUint32(at.interfaceIndex, true)),
                periodMs: data.getUint32(at.periodInMilliseconds, true),
                firstQuery: String(data.getBigUint64(at.firstQueryDateAndTime, true)),
            });
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
        } else if (type === QUBIC_LOG_TYPE.QU_TRANSFER && message.length >= QuTransfer.OFFSETS.amount + 8) {
            const at = QuTransfer.OFFSETS;
            const source = message.subarray(at.sourcePublicKey, at.sourcePublicKey + 32);
            const destination = message.subarray(at.destinationPublicKey, at.destinationPublicKey + 32);
            const amount = view(message).getBigInt64(at.amount, true);
            const burner = isZero(destination) ? contractSlot(source) : null;
            const refunded = isZero(source) ? contractSlot(destination) : null;
            if (amount > 0n && burner !== null) entries.push({ tick, range, record: "fee", contract: burner, amount: String(amount), direction: "burned" });
            if (amount > 0n && refunded !== null) entries.push({ tick, range, record: "fee", contract: refunded, amount: String(amount), direction: "refunded" });
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
        case "oc":
            return `OC ${entry.invocationId} · contract ${entry.contract} → ${entry.status}`;
        case "fee":
            return `fee ${entry.amount} ${entry.direction === "burned" ? "burned by" : "refunded to"} contract ${entry.contract}`;
    }
}
