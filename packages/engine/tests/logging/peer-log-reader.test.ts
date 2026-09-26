// the dual-engine scripts read native log records through this client; here it reads the simulator's own peer server, where the expected bytes are known.
import { expect, test } from "bun:test";
import { CUSTOM_MESSAGE_OP, QUBIC_LOG_TYPE } from "@qinit/proto";
import { readTickLogs } from "../../../../scripts/live-node/peer-log-reader";
import { LOG_SC_BEGIN_TICK } from "../../src/logging/qubic-log-store";
import { PeerServer } from "../../src/peer-server";
import { initK12 } from "../../src/support/k12";
import { VirtualNode } from "../../src/transport";
import { contractId } from "../support/helpers";

test("a tick's records come back in log order with their range and exact payload", async () => {
    await initK12();
    const node = new VirtualNode();
    const paying = contractId(28);
    node.sim.fund(paying, 676n);

    node.sim.advance();
    const tick = node.sim.currentTick + 1;
    node.logger.begin(tick, LOG_SC_BEGIN_TICK);
    node.sim.host.distributeDividends(28, 1n);
    node.logger.end();
    node.sim.advance();

    const server = new PeerServer(node);
    const { port, stop } = await server.start(0);
    try {
        const records = await readTickLogs("127.0.0.1", port, tick);
        const markers = records.filter((record) => record.type === QUBIC_LOG_TYPE.CUSTOM_MESSAGE);

        expect(markers.map((record) => [record.txIndex, new DataView(record.message.buffer).getBigUint64(0, true)])).toEqual([
            [LOG_SC_BEGIN_TICK, CUSTOM_MESSAGE_OP.START_DISTRIBUTE_DIVIDENDS],
            [LOG_SC_BEGIN_TICK, CUSTOM_MESSAGE_OP.END_DISTRIBUTE_DIVIDENDS],
        ]);
        expect(await readTickLogs("127.0.0.1", port, tick + 50)).toEqual([]);
    } finally {
        stop();
    }
});
