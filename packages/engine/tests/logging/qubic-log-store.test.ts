import { beforeAll, describe, expect, test } from "bun:test";
import { QUBIC_LOG_TYPE } from "@qinit/proto";
import { concatBytes } from "../../src/support/bytes";
import { initK12, k12Bytes } from "../../src/support/k12";
import { LOG_HEADER_SIZE, QubicLogStore } from "../../src/logging/qubic-log-store";

const ZERO32 = new Uint8Array(32);

function message(marker: number): Uint8Array {
    return Uint8Array.of(0, 0, 0, 0, marker, 0, 0, 0);
}

function stampedMessage(contractIndex: number, marker: number): Uint8Array {
    const bytes = message(marker);
    new DataView(bytes.buffer).setUint32(0, contractIndex, true);
    return bytes;
}

describe("Qubic log store", () => {
    beforeAll(initK12);

    test("encodes the core-lite record header and transaction range", () => {
        const logger = new QubicLogStore();
        const source = Uint8Array.of(0, 0, 0, 0, 9, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0);
        logger.begin(12, 3);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, source, 4);
        logger.end();
        logger.finalizeTick(12);

        expect(source[0]).toBe(0);
        expect(logger.range(12, 3)).toEqual({ fromLogId: 0n, length: 1n });
        const record = logger.recordsBetween(0n, 0n)!;
        const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
        expect(view.getUint16(0, true)).toBe(4);
        expect(view.getUint32(2, true)).toBe(12);
        expect(view.getUint32(6, true)).toBe(
            (QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE << 24) | source.length,
        );
        expect(view.getBigUint64(10, true)).toBe(0n);
        const stamped = record.slice(LOG_HEADER_SIZE);
        expect(new DataView(stamped.buffer).getUint32(0, true)).toBe(28);
        expect(view.getBigUint64(18, true)).toBe(
            new DataView(k12Bytes(stamped).buffer).getBigUint64(0, true),
        );
    });

    test("uses the exact core-lite state-digest message allowlist", () => {
        const includedTypes = new Set<number>([
            QUBIC_LOG_TYPE.QU_TRANSFER,
            QUBIC_LOG_TYPE.ASSET_ISSUANCE,
            QUBIC_LOG_TYPE.ASSET_OWNERSHIP_CHANGE,
            QUBIC_LOG_TYPE.ASSET_POSSESSION_CHANGE,
            QUBIC_LOG_TYPE.BURNING,
            QUBIC_LOG_TYPE.DUST_BURNING,
            QUBIC_LOG_TYPE.SPECTRUM_STATS,
            QUBIC_LOG_TYPE.ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE,
            QUBIC_LOG_TYPE.ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE,
        ]);
        const testedTypes = [...Object.values(QUBIC_LOG_TYPE), 17];

        for (const type of testedTypes) {
            const logger = new QubicLogStore();
            logger.begin(1, 0);
            logger.log(28, type, message(type), 1);
            logger.end();
            logger.finalizeTick(1);

            const digestInput = includedTypes.has(type)
                ? concatBytes([ZERO32, stampedMessage(28, type)])
                : ZERO32;
            expect(logger.digest(1)).toEqual(k12Bytes(digestInput));
        }
    });

    test("does not expose or prune records before their tick is finalized", () => {
        const logger = new QubicLogStore();
        logger.begin(1, 0);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(1), 1);

        expect(logger.recordsBetween(0n, 0n)).toBeNull();
        expect(logger.prune(0n, 0n)).toBe(4);

        logger.end();
        logger.finalizeTick(1);
        expect(logger.recordsBetween(0n, 0n)?.length).toBe(34);
    });

    test("rejects writes and duplicate finalization for a finalized tick", () => {
        const logger = new QubicLogStore();
        logger.begin(1, 0);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(1), 1);
        logger.end();
        logger.finalizeTick(1);

        expect(() => logger.begin(1, 0)).toThrow("cannot write logs for finalized tick 1");
        expect(() => logger.finalizeTick(1)).toThrow("cannot finalize logs for tick 1 twice");
        expect(logger.range(1, 0)).toEqual({ fromLogId: 0n, length: 1n });
    });

    test("reset starts a new epoch with log ID zero and a fresh digest chain", () => {
        const logger = new QubicLogStore();
        logger.begin(12, 0);
        logger.log(28, QUBIC_LOG_TYPE.QU_TRANSFER, message(1), 1);
        logger.end();
        logger.finalizeTick(12);

        logger.reset(20);
        expect(logger.recordsBetween(0n, 0n)).toBeNull();
        expect(logger.digest(12)).toBeNull();
        expect(logger.range(12, 0)).toEqual({ fromLogId: -2n, length: -2n });

        logger.begin(20, 0);
        logger.log(28, QUBIC_LOG_TYPE.QU_TRANSFER, message(2), 2);
        logger.end();
        logger.finalizeTick(20);

        const record = logger.recordsBetween(0n, 0n)!;
        expect(new DataView(record.buffer).getBigUint64(10, true)).toBe(0n);
        expect(logger.digest(20)).toEqual(k12Bytes(concatBytes([ZERO32, stampedMessage(28, 2)])));
    });

    test("pause suppresses persistence and future ticks use native sentinels", () => {
        const logger = new QubicLogStore();
        logger.begin(1, 0);
        logger.pause();
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, new Uint8Array(8), 1);
        logger.resume();
        logger.end();
        logger.finalizeTick(1);
        expect(logger.range(1, 0)).toEqual({ fromLogId: -1n, length: -1n });
        expect(logger.range(2, 0)).toEqual({ fromLogId: -3n, length: -3n });
    });

    test("retention evicts complete finalized ticks", () => {
        const logger = new QubicLogStore(68);
        logger.begin(1, 0);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(1), 1);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(2), 1);
        logger.end();
        logger.finalizeTick(1);

        logger.begin(2, 0);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(3), 1);
        logger.end();
        logger.finalizeTick(2);

        expect(logger.range(1, 0)).toEqual({ fromLogId: -2n, length: -2n });
        expect(logger.recordsBetween(0n, 1n)).toBeNull();
        expect(logger.range(2, 0)).toEqual({ fromLogId: 2n, length: 1n });
        const retained = logger.recordsBetween(2n, 2n)!;
        expect(retained.length).toBe(34);
        expect(new DataView(retained.buffer).getBigUint64(10, true)).toBe(2n);
        expect(logger.digest(1)).not.toBeNull();
    });

    test("signals when one tick exceeds the retention limit", () => {
        const logger = new QubicLogStore(40);
        logger.begin(1, 0);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(1), 1);
        logger.log(28, QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, message(2), 1);
        logger.end();

        expect(() => logger.finalizeTick(1)).toThrow("log retention limit exceeded in tick 1");
        expect(logger.recordsBetween(0n, 0n)).toBeNull();
        expect(logger.digest(1)).toBeNull();
        expect(logger.range(1, 0)).toEqual({ fromLogId: -3n, length: -3n });
    });
});
