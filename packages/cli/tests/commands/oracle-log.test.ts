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

    node.logger.begin(tick, 0);
    node.logger.logMessage(QUBIC_LOG_TYPE.QU_TRANSFER, encodeQuTransferLog(keyed(31), new Uint8Array(32), 10n), 1);
    node.logger.logMessage(
        QUBIC_LOG_TYPE.ORACLE_QUERY_STATUS_CHANGE,
        encodeOracleQueryStatusChangeLog(keyed(31), queryId, 0, ORACLE_QUERY_TYPE_CONTRACT_QUERY, ORACLE_STATUS.PENDING),
        1,
    );
    node.logger.logMessage(QUBIC_LOG_TYPE.QU_TRANSFER, encodeQuTransferLog(new Uint8Array(32), keyed(31), 10n), 1);
    node.logger.logMessage(QUBIC_LOG_TYPE.ORACLE_SUBSCRIBER_MESSAGE, encodeOracleSubscriberLog(0, 0, 31, 60_000, 0n), 1);
    node.logger.logMessage(QUBIC_LOG_TYPE.OC_INVOCATION_STATUS_CHANGE, encodeOcInvocationStatusChangeLog(queryId, 31, 0, OC_INVOCATION_STATUS.PENDING_AUTH), 1);
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
            "0 fee 10 refunded to contract 31",
            "0 subscription 0 · Price · contract 31 · every 60000 ms",
            `0 OC ${queryId} · contract 31 → PENDING_AUTH`,
            `${LOG_SC_NOTIFICATION} query ${queryId + 1n} · Price · subscription 0 → TIMEOUT`,
        ]);
        // a tick without records reads as none rather than failing
        expect(await readTickLogRecords("127.0.0.1", port, tick + 50)).toEqual([]);
    } finally {
        stop();
    }
});
