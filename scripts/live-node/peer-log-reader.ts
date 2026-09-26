// test-only client for a node's log protocol: a tick's log id ranges, then the raw records they name. The simulator's peer server and a
// core node answer the same two requests, so one reader gives both streams byte for byte.
import { connect } from "node:net";
import { HEADER_SIZE, MSG, frame, readHeader } from "@qinit/engine/protocol/peer-codec";
import { LOG_HEADER_SIZE } from "@qinit/engine/logging/qubic-log-store";

export interface TickLogRecord {
    // the tick-local range the record sits in: a transaction's index, or one of the system-procedure slots past them.
    txIndex: number;
    type: number;
    message: Uint8Array;
}

const PASSCODE_BYTES = 32;
const RESPONSE_TIMEOUT_MS = 15_000;

// one request per connection; the node's opening peer exchange and any other traffic is skipped by type and dejavu.
function request(host: string, port: number, type: number, payload: Uint8Array, responseType: number): Promise<Uint8Array | null> {
    const dejavu = 1 + Math.floor(Math.random() * 0x7ffffffe);

    return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        let received = new Uint8Array(0);
        const finish = (result: Uint8Array | null, error?: Error) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) {
                reject(error);
            } else {
                resolve(result);
            }
        };
        const timer = setTimeout(() => finish(null, new Error(`no response to peer request ${type} from ${host}:${port}`)), RESPONSE_TIMEOUT_MS);

        socket.on("connect", () => socket.write(frame(type, payload, dejavu)));
        socket.on("error", (error) => finish(null, error));
        socket.on("data", (chunk: Buffer) => {
            const joined = new Uint8Array(received.length + chunk.length);
            joined.set(received);
            joined.set(chunk, received.length);
            received = joined;

            let offset = 0;
            while (offset + HEADER_SIZE <= received.length) {
                const header = readHeader(received, offset);
                if (!header || offset + header.size > received.length) {
                    break;
                }
                if (header.dejavu === dejavu && header.type === responseType) {
                    finish(received.slice(offset + HEADER_SIZE, offset + header.size));
                    return;
                }
                if (header.dejavu === dejavu && header.type === MSG.END_RESPONSE) {
                    finish(null);
                    return;
                }
                offset += header.size;
            }
            received = received.slice(offset);
        });
    });
}

function passcodePayload(size: number): { payload: Uint8Array; view: DataView } {
    const payload = new Uint8Array(size);

    return { payload, view: new DataView(payload.buffer) };
}

/** every log record of one tick, in log-id order, each tagged with the tick-local range it was written under. */
export async function readTickLogs(host: string, port: number, tick: number): Promise<TickLogRecord[]> {
    const ranges = passcodePayload(PASSCODE_BYTES + 8);
    ranges.view.setUint32(PASSCODE_BYTES, tick, true);
    const rangeTable = await request(host, port, MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX, ranges.payload, MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX);
    if (!rangeTable) {
        return [];
    }

    // the table is every range's first log id, then every range's length.
    const rangeCount = rangeTable.length / 16;
    const table = new DataView(rangeTable.buffer, rangeTable.byteOffset, rangeTable.byteLength);
    const records: (TickLogRecord & { logId: bigint })[] = [];

    for (let txIndex = 0; txIndex < rangeCount; txIndex++) {
        const fromLogId = table.getBigInt64(txIndex * 8, true);
        const length = table.getBigInt64((rangeCount + txIndex) * 8, true);
        if (fromLogId < 0n || length <= 0n) {
            continue;
        }

        const logs = passcodePayload(PASSCODE_BYTES + 16);
        logs.view.setBigUint64(PASSCODE_BYTES, fromLogId, true);
        logs.view.setBigUint64(PASSCODE_BYTES + 8, fromLogId + length - 1n, true);
        const bytes = await request(host, port, MSG.REQUEST_LOG, logs.payload, MSG.RESPOND_LOG);
        if (!bytes) {
            throw new Error(`${host}:${port} has no records for log ids ${fromLogId}..${fromLogId + length - 1n}`);
        }

        let offset = 0;
        while (offset + LOG_HEADER_SIZE <= bytes.length) {
            const header = new DataView(bytes.buffer, bytes.byteOffset + offset, LOG_HEADER_SIZE);
            const sizeAndType = header.getUint32(6, true);
            const messageSize = sizeAndType & 0xffffff;
            records.push({
                txIndex,
                type: sizeAndType >>> 24,
                logId: header.getBigUint64(10, true),
                message: bytes.slice(offset + LOG_HEADER_SIZE, offset + LOG_HEADER_SIZE + messageSize),
            });
            offset += LOG_HEADER_SIZE + messageSize;
        }
    }

    return records.sort((left, right) => (left.logId < right.logId ? -1 : 1)).map(({ txIndex, type, message }) => ({ txIndex, type, message }));
}
