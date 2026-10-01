// a node's log records per tick over the peer protocol both engines serve: the tick's log-id ranges, then REQUEST_LOG over the whole span
// (a core tick can hold thousands of one-record ranges, one per computor transaction, and a request each is more than core answers).
import { connect, type Socket } from "node:net";
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
// core sometimes leaves a request unanswered right after a burst of them, or answers TRY_AGAIN; the next one is answered
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1_000;

export interface LogReader {
    /** every record of one tick, in log-id order; none for a tick the node holds no records for. */
    tick(tick: number): Promise<NodeLogRecord[]>;
    close(): void;
}

/** a log reader on one peer connection, reopened when the node drops it: requests go one after another, each matched by its own dejavu. */
export function openLogReader(host: string, port: number): LogReader {
    let socket: Socket | null = null;
    let received = new Uint8Array(0);
    let pending: { dejavu: number; settle: (answer: { type: number; body: Uint8Array } | Error) => void } | null = null;

    // the connection is gone or no longer trusted: whoever waits on it fails, and the next request opens a new one
    const drop = (error: Error) => {
        socket?.destroy();
        socket = null;
        received = new Uint8Array(0);
        pending?.settle(error);
    };

    const onData = (chunk: Buffer) => {
        const joined = new Uint8Array(received.length + chunk.length);
        joined.set(received);
        joined.set(chunk, received.length);
        received = joined;
        while (received.length >= HEADER_SIZE) {
            const header = readHeader(received)!;
            if (received.length < header.size) return;
            const body = received.slice(HEADER_SIZE, header.size);
            received = received.slice(header.size);
            // the node's opening peer exchange and anyone else's traffic carry another dejavu
            if (header.dejavu === pending?.dejavu) pending.settle({ type: header.type, body });
        }
    };

    const exchange = (type: number, payload: Uint8Array) =>
        new Promise<{ type: number; body: Uint8Array }>((resolve, reject) => {
            const dejavu = 1 + Math.floor(Math.random() * 0x7ffffffe);
            const timer = setTimeout(() => drop(new Error(`no answer to log request ${type} from ${host}:${port}`)), RESPONSE_TIMEOUT_MS);
            pending = {
                dejavu,
                settle: (answer) => {
                    clearTimeout(timer);
                    pending = null;
                    if (answer instanceof Error) reject(answer);
                    else resolve(answer);
                },
            };
            if (!socket) {
                const opened = connect({ host, port });
                socket = opened;
                opened.on("data", onData);
                opened.on("error", (error) => socket === opened && drop(error));
                opened.on("close", () => socket === opened && drop(new Error(`${host}:${port} closed the connection`)));
            }
            socket.write(frame(type, payload, dejavu));
        });

    // `what` names the request in a refusal. END_RESPONSE is core's one answer to a wrong passcode, a build without logging and a tick it does not hold.
    const request = async (type: number, payload: Uint8Array, responseType: number, what: string): Promise<Uint8Array> => {
        for (let attempt = 1; ; attempt++) {
            let answer: { type: number; body: Uint8Array } | Error;
            try {
                answer = await exchange(type, payload);
            } catch (error) {
                answer = error as Error;
            }
            if (!(answer instanceof Error)) {
                if (answer.type === responseType) return answer.body;
                if (answer.type !== MSG.TRY_AGAIN) {
                    throw new Error(`${host}:${port} refused ${what}: its log reader passcode is not zero, it was built without logging, or it does not hold that tick`);
                }
                answer = new Error(`${host}:${port} is too busy to answer ${what}`);
            }
            if (attempt === ATTEMPTS) throw answer;
            await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
        }
    };

    const tick = async (tick: number): Promise<NodeLogRecord[]> => {
        const rangeRequest = new Uint8Array(PASSCODE_BYTES + 8);
        new DataView(rangeRequest.buffer).setUint32(PASSCODE_BYTES, tick, true);
        const table = await request(MSG.REQUEST_ALL_LOG_ID_RANGES_FROM_TX, rangeRequest, MSG.RESPOND_ALL_LOG_ID_RANGES_FROM_TX, `the log ranges of tick ${tick}`);

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

        // core answers with as long a prefix of the span as fits one message, so the rest is asked for from the last id it sent
        const records: NodeLogRecord[] = [];
        for (let from = first; from <= last; from = records[records.length - 1].logId + 1n) {
            const logRequest = new Uint8Array(PASSCODE_BYTES + 16);
            const logView = new DataView(logRequest.buffer);
            logView.setBigUint64(PASSCODE_BYTES, from, true);
            logView.setBigUint64(PASSCODE_BYTES + 8, last, true);
            const bytes = await request(MSG.REQUEST_LOG, logRequest, MSG.RESPOND_LOG, `log records ${from}..${last} of tick ${tick}`);

            const before = records.length;
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
            if (records.length === before || records[records.length - 1].logId < from) {
                throw new Error(`${host}:${port} answered log records ${from}..${last} of tick ${tick} with none of them`);
            }
        }
        return records;
    };

    return {
        tick,
        close: () => {
            const open = socket;
            socket = null;
            open?.destroy();
        },
    };
}

/** one tick's records over a connection of its own. */
export async function readTickLogRecords(host: string, port: number, tick: number): Promise<NodeLogRecord[]> {
    const reader = openLogReader(host, port);
    try {
        return await reader.tick(tick);
    } finally {
        reader.close();
    }
}
