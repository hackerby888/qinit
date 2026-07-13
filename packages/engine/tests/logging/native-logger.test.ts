import { beforeAll, describe, expect, test } from "bun:test";
import { initK12, k12Bytes } from "../../src/k12";
import { LOG_HEADER_SIZE, NativeLogger } from "../../src/native-logger";

describe("native logging store", () => {
  beforeAll(initK12);

  test("encodes the core-lite record header and transaction range", () => {
    const logger = new NativeLogger();
    const source = Uint8Array.of(0, 0, 0, 0, 9, 0, 0, 0, 42, 0, 0, 0, 0, 0, 0, 0);
    logger.begin(12, 3);
    logger.log(28, 6, source, 4);
    logger.end();
    logger.finalizeTick(12);

    expect(source[0]).toBe(0);
    expect(logger.range(12, 3)).toEqual({ fromLogId: 0n, length: 1n });
    const record = logger.recordsBetween(0n, 0n)!;
    const view = new DataView(record.buffer, record.byteOffset, record.byteLength);
    expect(view.getUint16(0, true)).toBe(4);
    expect(view.getUint32(2, true)).toBe(12);
    expect(view.getUint32(6, true)).toBe((6 << 24) | source.length);
    expect(view.getBigUint64(10, true)).toBe(0n);
    const stamped = record.slice(LOG_HEADER_SIZE);
    expect(new DataView(stamped.buffer).getUint32(0, true)).toBe(28);
    expect(view.getBigUint64(18, true)).toBe(
      new DataView(k12Bytes(stamped).buffer).getBigUint64(0, true),
    );
    expect(logger.digest(12)?.some((x) => x !== 0)).toBe(true);
  });

  test("pause suppresses persistence and future ticks use native sentinels", () => {
    const logger = new NativeLogger();
    logger.begin(1, 0);
    logger.pause();
    logger.log(28, 6, new Uint8Array(8), 1);
    logger.resume();
    logger.end();
    logger.finalizeTick(1);
    expect(logger.range(1, 0)).toEqual({ fromLogId: -1n, length: -1n });
    expect(logger.range(2, 0)).toEqual({ fromLogId: -3n, length: -3n });
  });

  test("retention cap drops whole records without creating log-id holes", () => {
    const logger = new NativeLogger(40);
    logger.begin(1, 0);
    logger.log(28, 6, new Uint8Array(8), 1); // 34 bytes: accepted
    logger.log(28, 6, new Uint8Array(8), 1); // would exceed 40: dropped
    logger.end();
    logger.finalizeTick(1);
    expect(logger.range(1, 0)).toEqual({ fromLogId: 0n, length: 1n });
    expect(logger.recordsBetween(0n, 0n)?.length).toBe(34);
    expect(logger.recordsBetween(1n, 1n)).toBeNull();
  });
});
