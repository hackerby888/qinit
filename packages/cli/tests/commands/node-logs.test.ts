// The log reader against a scripted peer: what core answers that the simulator's peer server never does — a refusal, a busy node, a prefix of
// the span asked for — and one connection for a whole range of ticks.
import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { HEADER_SIZE, MSG, encodeAllLogRanges, endResponse, frame, readHeader } from "@qinit/engine/protocol/peer-codec";
import { LOG_HEADER_SIZE } from "@qinit/engine/logging/qubic-log-store";
import { openLogReader, readTickLogRecords } from "../../src/ops/node-logs";

type PeerRequest = { type: number; dejavu: number; payload: Uint8Array; connection: number };

async function peer(answer: (request: PeerRequest, socket: Socket) => Uint8Array | null) {
    let connections = 0;
    const requests: PeerRequest[] = [];
    const server = createServer((socket) => {
        const connection = ++connections;
        let received = new Uint8Array(0);
        socket.on("error", () => {});
        socket.on("data", (chunk) => {
            received = Uint8Array.from([...received, ...chunk]);
            while (received.length >= HEADER_SIZE && received.length >= readHeader(received)!.size) {
                const header = readHeader(received)!;
                const request = { type: header.type, dejavu: header.dejavu, payload: received.slice(HEADER_SIZE, header.size), connection };
                received = received.slice(header.size);
                requests.push(request);
                const reply = answer(request, socket);
                if (reply) socket.write(reply);
            }
        });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    return { port, requests, connections: () => connections, stop: () => server.close() };
}

const noRecords = (dejavu: number) => frame(MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX, encodeAllLogRanges([{ fromLogId: -1n, length: -1n }]), dejavu);

function logRecord(logId: bigint, type: number, message: Uint8Array): Uint8Array {
    const out = new Uint8Array(LOG_HEADER_SIZE + message.length);
    const view = new DataView(out.buffer);
    view.setUint32(6, (type << 24) | message.length, true);
    view.setBigUint64(10, logId, true);
    out.set(message, LOG_HEADER_SIZE);
    return out;
}

test("a refused log request is an error, not a tick without records", async () => {
    const node = await peer((request) => endResponse(request.dejavu));
    try {
        await expect(readTickLogRecords("127.0.0.1", node.port, 40)).rejects.toThrow("refused the log ranges of tick 40");
        // a refusal is the node's answer, so it is not asked again
        expect(node.requests.length).toBe(1);
    } finally {
        node.stop();
    }
});

test("a busy node is asked again", async () => {
    const node = await peer((request) => (node.requests.length === 1 ? frame(MSG.TRY_AGAIN, new Uint8Array(0), request.dejavu) : noRecords(request.dejavu)));
    try {
        expect(await readTickLogRecords("127.0.0.1", node.port, 40)).toEqual([]);
        expect(node.requests.length).toBe(2);
    } finally {
        node.stop();
    }
});

test("a reply that stops short of the span is followed up from the last id it carried", async () => {
    const asked: { from: bigint; to: bigint }[] = [];
    const node = await peer((request) => {
        if (request.type === MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX) {
            return frame(MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX, encodeAllLogRanges([{ fromLogId: 5n, length: 3n }, { fromLogId: 8n, length: 1n }]), request.dejavu);
        }
        const view = new DataView(request.payload.buffer, request.payload.byteOffset);
        const from = view.getBigUint64(32, true);
        asked.push({ from, to: view.getBigUint64(40, true) });
        // core halves the span until it fits one message: here two records at a time
        const ids = [from, from + 1n].filter((logId) => logId <= 8n);
        return frame(MSG.RESPOND_LOG, Uint8Array.from(ids.flatMap((logId) => [...logRecord(logId, 14, Uint8Array.of(Number(logId)))])), request.dejavu);
    });
    try {
        const records = await readTickLogRecords("127.0.0.1", node.port, 40);
        expect(asked).toEqual([{ from: 5n, to: 8n }, { from: 7n, to: 8n }]);
        expect(records.map((record) => [record.logId, record.range, record.type, record.message[0]])).toEqual([[5n, 0, 14, 5], [6n, 0, 14, 6], [7n, 0, 14, 7], [8n, 1, 14, 8]]);
    } finally {
        node.stop();
    }
});

test("a reply that carries none of the records asked for ends the read", async () => {
    const node = await peer((request) =>
        request.type === MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX
            ? frame(MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX, encodeAllLogRanges([{ fromLogId: 5n, length: 3n }]), request.dejavu)
            : frame(MSG.RESPOND_LOG, new Uint8Array(0), request.dejavu),
    );
    try {
        await expect(readTickLogRecords("127.0.0.1", node.port, 40)).rejects.toThrow("with none of them");
    } finally {
        node.stop();
    }
});

test("a range of ticks is read over one connection, reopened when the node drops it", async () => {
    let drops = 0;
    const node = await peer((request, socket) => {
        // the third tick's request is cut off once, as a node culling an idle peer does
        if (node.requests.length === 3 && drops++ === 0) {
            socket.destroy();
            return null;
        }
        return noRecords(request.dejavu);
    });
    const reader = openLogReader("127.0.0.1", node.port);
    try {
        for (let tick = 40; tick < 42; tick++) expect(await reader.tick(tick)).toEqual([]);
        expect(node.connections()).toBe(1);
        for (let tick = 42; tick < 45; tick++) expect(await reader.tick(tick)).toEqual([]);
        expect(node.connections()).toBe(2);
        expect(node.requests.map((request) => request.connection)).toEqual([1, 1, 1, 2, 2, 2]);
    } finally {
        reader.close();
        node.stop();
    }
});
