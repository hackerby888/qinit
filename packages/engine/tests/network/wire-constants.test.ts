// Locks bridge protocol sizes to core's fixed Qubic mainnet layouts.
import { test, expect } from "bun:test";
import {
  MAX_NUMBER_OF_CONTRACTS,
  TICKDATA_SIZE,
  TXS_PER_TICK,
  TICK_SIZE,
} from "../../src/consensus";
import {
  ASSETS_DEPTH,
  TXS_PER_TICK as CODEC_TXS_PER_TICK,
  CLI_NUMBER_OF_COMPUTORS,
  SPECTRUM_DEPTH,
} from "../../src/peer-codec";
import {
  ASSETS_DEPTH as PROTOCOL_ASSETS_DEPTH,
  MAINNET_COMPUTOR_COUNT,
  MAX_NUMBER_OF_CONTRACTS as PROTOCOL_MAX_NUMBER_OF_CONTRACTS,
  SPECTRUM_DEPTH as PROTOCOL_SPECTRUM_DEPTH,
  TXS_PER_TICK as PROTOCOL_TXS_PER_TICK,
} from "@qinit/proto";
import { CONTRACT_FEES_COUNT } from "../../src/wire";

const DIGEST_SIZE = 32;
const SIG_SIZE = 64;
const TICKDATA_HEADER = 48; // computorIndex(2) epoch(2) tick(4) time(8) timelock(32)

test("NUMBER_OF_TRANSACTIONS_PER_TICK is 4096 across consensus + codec", () => {
  expect(TXS_PER_TICK).toBe(4096); // common_def.h — must be 2^N
  expect(CODEC_TXS_PER_TICK).toBe(TXS_PER_TICK); // the bridge codec must agree with the artifact builder
  expect(TXS_PER_TICK).toBe(PROTOCOL_TXS_PER_TICK);
});

test("TickData is exactly 139376 bytes (the client's sizeof(TickData))", () => {
  const computed =
    TICKDATA_HEADER + TXS_PER_TICK * DIGEST_SIZE + CONTRACT_FEES_COUNT * 8 + SIG_SIZE;
  expect(computed).toBe(139376);
  expect(TICKDATA_SIZE).toBe(139376);
  expect(TICKDATA_SIZE).toBe(computed);
});

test("Tick vote is 352 bytes (tick.h static_assert)", () => {
  expect(TICK_SIZE).toBe(8 + 8 + 2 * 4 + 2 * 4 + 6 * 32 + 2 * 32 + SIG_SIZE);
  expect(TICK_SIZE).toBe(352);
});

test("computor-list slot count + RespondTxStatus moneyFlew width track the protocol", () => {
  expect(CLI_NUMBER_OF_COMPUTORS).toBe(MAINNET_COMPUTOR_COUNT);
  expect(MAX_NUMBER_OF_CONTRACTS).toBe(PROTOCOL_MAX_NUMBER_OF_CONTRACTS);
  expect(CONTRACT_FEES_COUNT).toBe(PROTOCOL_MAX_NUMBER_OF_CONTRACTS);
  expect(SPECTRUM_DEPTH).toBe(PROTOCOL_SPECTRUM_DEPTH);
  expect(ASSETS_DEPTH).toBe(PROTOCOL_ASSETS_DEPTH);
  expect((TXS_PER_TICK + 7) >> 3).toBe(512); // RespondTxStatus.moneyFlew[(NUMBER_OF_TRANSACTIONS_PER_TICK+7)/8]
});
