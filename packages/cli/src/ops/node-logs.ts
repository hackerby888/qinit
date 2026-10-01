// A node's log records per tick over the peer protocol both engines serve: the tick's log-id ranges, then one REQUEST_LOG for the whole span
// (a core tick can hold thousands of one-record ranges, one per computor transaction, and a request each is more than core answers).
import { connect } from "node:net";
import { HEADER_SIZE, MSG, frame, readHeader } from "@qinit/engine/protocol/peer-codec";
import { LOG_HEADER_SIZE } from "@qinit/engine/logging/qubic-log-store";

export interface NodeLogRecord {
    tick: number;
    // the tick-local range the record sits in: a transaction's index, or a system-procedure slot past them
    range: number;
    logId: bigint;
    type: number;
    message: Uint8Array;
}

// a development node reads logs with the all-zero passcode
const PASSCODE_BYTES = 32;
const RESPONSE_TIMEOUT_MS = 15_000;
// core sometimes leaves a request unanswered right after a burst of them; the next one is answered
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1_000;

async function request(host: string, port: number, type: number, payload: Uint8Array, responseType: number): Promise<Uint8Array | null> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await requestOnce(host, port, type, payload, responseType);
        } catch (error) {
            if (attempt === ATTEMPTS) throw error;
            await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
        }
    }
}

// one request per connection; the node's opening peer exchange and anyone else's traffic are skipped by dejavu.
function requestOnce(host: string, port: number, type: number, payload: Uint8Array, responseType: number): Promise<Uint8Array | null> {
    const dejavu = 1 + Math.floor(Math.random() * 0x7ffffffe);
    return new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        let received = new Uint8Array(0);
        const finish = (result: Uint8Array | null, error?: Error) => {
            clearTimeout(timer);
            socket.destroy();
            if (error) reject(error);
            else resolve(result);
        };
        const timer = setTimeout(() => finish(null, new Error(`no answer to log request ${type} from ${host}:${port}`)), RESPONSE_TIMEOUT_MS);
        socket.on("connect", () => socket.write(frame(type, payload, dejavu)));
        socket.on("error", (error) => finish(null, error));
        socket.on("data", (chunk: Buffer) => {
            const joined = new Uint8Array(received.length + chunk.length);
            joined.set(received);
            joined.set(chunk, received.length);
            received = joined;
            while (received.length >= HEADER_SIZE) {
                const header = readHeader(received)!;
                if (received.length < header.size) return;
                const body = received.slice(HEADER_SIZE, header.size);
                received = received.slice(header.size);
                if (header.dejavu !== dejavu) continue;
                // anything but the answer asked for (core's END_RESPONSE for a tick it no longer holds) means no records
                finish(header.type === responseType ? body : null);
                return;
            }
        });
    });
}

/** Every record of one tick, in log-id order; none for a tick the node holds no records for. */
export async function readTickLogRecords(host: string, port: number, tick: number): Promise<NodeLogRecord[]> {
    const rangeRequest = new Uint8Array(PASSCODE_BYTES + 8);
    new DataView(rangeRequest.buffer).setUint32(PASSCODE_BYTES, tick, true);
    const table = await request(host, port, MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX, rangeRequest, MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX);
    if (!table) return [];

    // the table is every range's first log id, then every range's length; a negative entry is an empty range
    const ranges = table.length / 16;
    const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const rangeOf = new Map<bigint, number>();
    let first = -1n;
    let last = -1n;
    for (let range = 0; range < ranges; range++) {
        const fromLogId = view.getBigInt64(range * 8, true);
        const length = view.getBigInt64((ranges + range) * 8, true);
        if (fromLogId < 0n || length <= 0n) continue;
        for (let logId = fromLogId; logId < fromLogId + length; logId++) rangeOf.set(logId, range);
        if (first < 0n || fromLogId < first) first = fromLogId;
        if (fromLogId + length - 1n > last) last = fromLogId + length - 1n;
    }
    if (first < 0n) return [];

    const logRequest = new Uint8Array(PASSCODE_BYTES + 16);
    const logView = new DataView(logRequest.buffer);
    logView.setBigUint64(PASSCODE_BYTES, first, true);
    logView.setBigUint64(PASSCODE_BYTES + 8, last, true);
    const bytes = await request(host, port, MSG.REQUEST_LOG, logRequest, MSG.RESPOND_LOG);
    if (!bytes) return [];

    const records: NodeLogRecord[] = [];
    for (let offset = 0; offset + LOG_HEADER_SIZE <= bytes.length; ) {
        const header = new DataView(bytes.buffer, bytes.byteOffset + offset, LOG_HEADER_SIZE);
        const sizeAndType = header.getUint32(6, true);
        const size = sizeAndType & 0xffffff;
        const logId = header.getBigUint64(10, true);
        records.push({
            tick,
            range: rangeOf.get(logId) ?? -1,
            logId,
            type: sizeAndType >>> 24,
            message: bytes.slice(offset + LOG_HEADER_SIZE, offset + LOG_HEADER_SIZE + size),
        });
        offset += LOG_HEADER_SIZE + size;
    }
    return records;
}
