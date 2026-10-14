// the dual-engine scripts read native log records through this client; here it reads the simulator's own peer server, where the expected bytes are known.
import { expect, test } from "bun:test";
import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { CUSTOM_MESSAGE_OP, QUBIC_LOG_TYPE } from "@qinit/proto";
import { readTickLogs } from "../../../../scripts/live-node/peer-log-reader";
import { LOG_SC_BEGIN_TICK } from "../../src/logging/qubic-log-store";
import { PeerServer } from "../../src/peer-server";
import { endResponse, readHeader } from "../../src/protocol/peer-codec";
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

// a core node drops a request whose packet hash collides in its dejavu bitmap; a server that swallows the first requests stands in for that drop.
async function swallowingServer(answerFrom: number): Promise<{ port: number; dejavus: number[]; close: () => Promise<void> }> {
    const dejavus: number[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => {});
        socket.on("close", () => sockets.delete(socket));
        socket.once("data", (chunk: Buffer) => {
            const header = readHeader(new Uint8Array(chunk), 0);
            if (!header) {
                return;
            }
            dejavus.push(header.dejavu);
            if (dejavus.length >= answerFrom) {
                socket.write(endResponse(header.dejavu));
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));

    // a swallowed request leaves its socket open on purpose, so the server only closes once those are destroyed.
    const close = async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    };

    return { port: (server.address() as AddressInfo).port, dejavus, close };
}

// on windows, bun hung once and exited the whole run once at the silent server below; the reader only serves the linux live-node job.
test.skipIf(process.platform === "win32")("a swallowed request is retried with a fresh dejavu, and a node that never answers is reported after the last attempt", async () => {
    const second = await swallowingServer(2);
    const never = await swallowingServer(Number.POSITIVE_INFINITY);
    try {
        expect(await readTickLogs("127.0.0.1", second.port, 7, 200)).toEqual([]);
        expect(second.dejavus).toHaveLength(2);
        expect(second.dejavus[0]).not.toBe(second.dejavus[1]);

        await expect(readTickLogs("127.0.0.1", never.port, 7, 100)).rejects.toThrow(/no response to peer request 50 from 127\.0\.0\.1:\d+ in 100 ms/);
        expect(never.dejavus).toHaveLength(3);
    } finally {
        await second.close();
        await never.close();
    }
});
