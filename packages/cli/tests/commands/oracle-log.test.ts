// F245: `qinit oracle log` reads the oracle and OC records of a node's log stream over its peer port, as both engines serve it.
import { expect, test } from "bun:test";
import {
    encodeOcInvocationStatusChangeLog,
    encodeOracleQueryStatusChangeLog,
    encodeOracleSubscriberLog,
    encodeQuTransferLog,
    OC_INVOCATION_STATUS,
    ORACLE_QUERY_TYPE_CONTRACT_QUERY,
    ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION,
    ORACLE_STATUS,
    QUBIC_LOG_TYPE,
} from "@qinit/proto";
import { LOG_SC_NOTIFICATION } from "@qinit/engine/logging/qubic-log-store";
import { PeerServer } from "@qinit/engine/peer-server";
import { initK12 } from "@qinit/engine/support/k12";
import { VirtualNode } from "@qinit/engine/transport";
import { readTickLogRecords } from "../../src/ops/node-logs";
import { oracleLogEntries, oracleLogText } from "../../src/ops/oracle-log";

const keyed = (value: number) => {
    const key = new Uint8Array(32);
    new DataView(key.buffer).setUint32(0, value, true);
    return key;
};

test("a tick's oracle and OC records come back decoded, with the fee burned and refunded", async () => {
    await initK12();
    const node = new VirtualNode();
    node.sim.advance();
    const tick = node.sim.currentTick + 1;
    const queryId = (BigInt(tick) << 31n) | 4096n;

    // the order both engines write: a fee, then the record it paid for, or the fee straight back when the request is refused
    const burn = () => node.logger.logMessage(QUBIC_LOG_TYPE.QU_TRANSFER, encodeQuTransferLog(keyed(31), new Uint8Array(32), 10n), 1);
    node.logger.begin(tick, 0);
    burn();
    node.logger.logMessage(
        QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE,
        encodeOracleQueryStatusChangeLog(keyed(31), queryId, 0, ORACLE_QUERY_TYPE_CONTRACT_QUERY, ORACLE_STATUS.PENDING),
        1,
    );
    burn();
    node.logger.logMessage(QUBIC_LOG_TYPE.QU_TRANSFER, encodeQuTransferLog(new Uint8Array(32), keyed(31), 10n), 1);
    burn();
    node.logger.logMessage(QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, encodeOracleSubscriberLog(0, 0, 31, 60_000, 0n), 1);
    burn();
    node.logger.logMessage(QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE, encodeOcInvocationStatusChangeLog(queryId, 31, 0, OC_INVOCATION_STATUS.PENDING_AUTH), 1);
    node.logger.logMessage(QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, encodeOracleSubscriberLog(0, 0, 31, 0, 0n), 1);
    node.logger.end();
    node.logger.begin(tick, LOG_SC_NOTIFICATION);
    node.logger.logMessage(
        QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE,
        encodeOracleQueryStatusChangeLog(keyed(0), queryId + 1n, 0, ORACLE_QUERY_TYPE_CONTRACT_SUBSCRIPTION, ORACLE_STATUS.TIMEOUT),
        1,
    );
    node.logger.end();
    node.sim.advance();

    const server = new PeerServer(node);
    const { port, stop } = await server.start(0);
    try {
        const entries = oracleLogEntries(await readTickLogRecords("127.0.0.1", port, tick));
        expect(entries.map((entry) => `${entry.range} ${oracleLogText(entry)}`)).toEqual([
            "0 fee 10 burned by contract 31",
            `0 query ${queryId} · Price · contract 31 → PENDING`,
            "0 fee 10 burned by contract 31",
            "0 fee 10 refunded to contract 31",
            "0 fee 10 burned by contract 31",
            "0 subscription 0 · Price · contract 31 · every 60000 ms",
            "0 fee 10 burned by contract 31",
            `0 OC ${queryId} · contract 31 → PENDING_AUTH`,
            "0 unsubscription 0 · Price · contract 31",
            `${LOG_SC_NOTIFICATION} query ${queryId + 1n} · Price · subscription 0 → TIMEOUT`,
        ]);
        // a tick without records reads as none rather than failing
        expect(await readTickLogRecords("127.0.0.1", port, tick + 50)).toEqual([]);
    } finally {
        stop();
    }
});

// core logs other transfers between a contract and the zero id: a contract's own burn, an epoch's revenue donation. Neither is a fee.
test("a transfer to or from the zero id that pays for no oracle or OC record is not called a fee", () => {
    const zero = new Uint8Array(32);
    const transfer = (source: Uint8Array, destination: Uint8Array, amount: bigint) => ({ type: QUBIC_LOG_TYPE.QU_TRANSFER, message: encodeQuTransferLog(source, destination, amount) });
    const pending = (contract: number) => ({
        type: QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE,
        message: encodeOracleQueryStatusChangeLog(keyed(contract), 7n, 0, ORACLE_QUERY_TYPE_CONTRACT_QUERY, ORACLE_STATUS.PENDING),
    });
    const texts = (range: number, ...records: { type: number; message: Uint8Array }[]) =>
        oracleLogEntries(records.map((record, index) => ({ tick: 9, range, logId: BigInt(index), ...record }))).map(oracleLogText);

    expect(texts(0, transfer(keyed(31), zero, 10n))).toEqual([]);
    expect(texts(0, transfer(zero, keyed(31), 10n))).toEqual([]);
    // a contract's own burn ahead of its fee: only the transfer right before the record is the fee
    expect(texts(0, transfer(keyed(31), zero, 500n), transfer(keyed(31), zero, 10n), pending(31))).toEqual(["fee 10 burned by contract 31", "query 7 · Price · contract 31 → PENDING"]);
    // another contract's query, a refund of another amount, and an unsubscribe pay for nothing
    expect(texts(0, transfer(keyed(31), zero, 10n), pending(32))).toEqual(["query 7 · Price · contract 32 → PENDING"]);
    expect(texts(0, transfer(keyed(31), zero, 10n), transfer(zero, keyed(31), 9n))).toEqual([]);
    expect(texts(0, transfer(keyed(31), zero, 10n), { type: QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, message: encodeOracleSubscriberLog(0, 0, 31, 0, 0n) })).toEqual(["unsubscription 0 · Price · contract 31"]);
    // the pair has to sit in one range
    const split = [
        { tick: 9, range: 0, logId: 0n, ...transfer(keyed(31), zero, 10n) },
        { tick: 9, range: 1, logId: 1n, ...pending(31) },
    ];
    expect(oracleLogEntries(split).map(oracleLogText)).toEqual(["query 7 · Price · contract 31 → PENDING"]);
});
