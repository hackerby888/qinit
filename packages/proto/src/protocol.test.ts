import { test, expect } from "bun:test";
import { LITE_TX, LOG_SEVERITY, CHUNK_DATA_MAX, MAX_INPUT_SIZE, CHUNK_HEADER_SIZE } from "./protocol";

// These lock the qinit side; scripts/check-protocol-drift.ts locks them against core in CI.
test("LITE_TX deploy inputTypes", () => {
  expect(LITE_TX).toEqual({ UPLOAD_BEGIN: 240, UPLOAD_CHUNK: 241, DEPLOY: 242 });
});

test("LOG_SEVERITY codes 4-7", () => {
  expect(LOG_SEVERITY).toEqual({ 4: "ERROR", 5: "WARN", 6: "INFO", 7: "DEBUG" });
});

test("CHUNK_DATA_MAX is the proven 1008, within core's MAX_INPUT_SIZE - header", () => {
  expect(CHUNK_DATA_MAX).toBe(1008);
  expect(CHUNK_DATA_MAX).toBeLessThanOrEqual(MAX_INPUT_SIZE - CHUNK_HEADER_SIZE);   // conservative (1008 < 1010)
});
