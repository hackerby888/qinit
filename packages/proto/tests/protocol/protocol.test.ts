import { test, expect } from "bun:test";
import {
  ASSETS_DEPTH,
  LITE_TX,
  LOG_SEVERITY,
  QUBIC_LOG_TYPE,
  CHUNK_DATA_MAX,
  MAINNET_COMPUTOR_COUNT,
  MAX_INPUT_SIZE,
  MAX_NUMBER_OF_CONTRACTS,
  MAX_ORACLE_QUERY_SIZE,
  MAX_ORACLE_REPLY_SIZE,
  ORACLE_STATUS,
  SPECTRUM_DEPTH,
  TXS_PER_TICK,
  CHUNK_HEADER_SIZE,
} from "../../src/protocol";

// These lock the Qinit side; scripts/core-compat/check-protocol-drift.ts locks them against core in CI.
test("LITE_TX deploy inputTypes", () => {
  expect(LITE_TX).toEqual({ UPLOAD_BEGIN: 240, UPLOAD_CHUNK: 241, DEPLOY: 242 });
});

test("LOG_SEVERITY uses the named Core message types", () => {
  expect(LOG_SEVERITY).toEqual({
    [QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE]: "ERROR",
    [QUBIC_LOG_TYPE.CONTRACT_WARNING_MESSAGE]: "WARN",
    [QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE]: "INFO",
    [QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE]: "DEBUG",
  });
});

test("core network constants", () => {
  expect({
    MAX_NUMBER_OF_CONTRACTS,
    TXS_PER_TICK,
    MAINNET_COMPUTOR_COUNT,
    SPECTRUM_DEPTH,
    ASSETS_DEPTH,
  }).toEqual({
    MAX_NUMBER_OF_CONTRACTS: 1024,
    TXS_PER_TICK: 4096,
    MAINNET_COMPUTOR_COUNT: 676,
    SPECTRUM_DEPTH: 24,
    ASSETS_DEPTH: 24,
  });
});

test("oracle limits and statuses", () => {
  expect(MAX_ORACLE_QUERY_SIZE).toBe(MAX_INPUT_SIZE - 16);
  expect(MAX_ORACLE_REPLY_SIZE).toBe(MAX_INPUT_SIZE - 16);
  expect(ORACLE_STATUS).toEqual({
    UNKNOWN: 0,
    PENDING: 1,
    COMMITTED: 2,
    SUCCESS: 3,
    TIMEOUT: 4,
    UNRESOLVABLE: 5,
  });
});

test("CHUNK_DATA_MAX is the proven 1008, within core's MAX_INPUT_SIZE - header", () => {
  expect(CHUNK_DATA_MAX).toBe(1008);
  expect(CHUNK_DATA_MAX).toBeLessThanOrEqual(MAX_INPUT_SIZE - CHUNK_HEADER_SIZE); // conservative (1008 < 1010)
});
