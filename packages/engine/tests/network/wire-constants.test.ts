// Wire-constant lock — the peer protocol the bridge speaks is the Qubic mainnet layout an external client
// (qubic-cli, built against qubic/core) parses by fixed struct sizes. These constants are hand-mirrored with no
import { test, expect } from "bun:test";
import { TICKDATA_SIZE, TXS_PER_TICK, TICK_SIZE } from "../../src/consensus";
import { TXS_PER_TICK as CODEC_TXS_PER_TICK, CLI_NUMBER_OF_COMPUTORS, SPECTRUM_DEPTH } from "../../src/peer-codec";

const DIGEST_SIZE = 32;
const SIG_SIZE = 64;
const CONTRACT_FEES_COUNT = 1024; // TickData.contractFees[1024] — a fixed 1024, independent of TXS_PER_TICK
const TICKDATA_HEADER = 48; // computorIndex(2) epoch(2) tick(4) time(8) timelock(32)

test("NUMBER_OF_TRANSACTIONS_PER_TICK is 4096 across consensus + codec", () => {
  expect(TXS_PER_TICK).toBe(4096); // common_def.h — must be 2^N
  expect(CODEC_TXS_PER_TICK).toBe(TXS_PER_TICK); // the bridge codec must agree with the artifact builder
});

test("TickData is exactly 139376 bytes (the client's sizeof(TickData))", () => {
  const computed = TICKDATA_HEADER + TXS_PER_TICK * DIGEST_SIZE + CONTRACT_FEES_COUNT * 8 + SIG_SIZE;
  expect(computed).toBe(139376);
  expect(TICKDATA_SIZE).toBe(139376);
  expect(TICKDATA_SIZE).toBe(computed);
});

test("Tick vote is 352 bytes (tick.h static_assert)", () => {
  expect(TICK_SIZE).toBe(8 + 8 + 2 * 4 + 2 * 4 + 6 * 32 + 2 * 32 + SIG_SIZE);
  expect(TICK_SIZE).toBe(352);
});

test("computor-list slot count + RespondTxStatus moneyFlew width track the protocol", () => {
  expect(CLI_NUMBER_OF_COMPUTORS).toBe(676); // NUMBER_OF_COMPUTORS
  expect(SPECTRUM_DEPTH).toBe(24);
  expect((TXS_PER_TICK + 7) >> 3).toBe(512); // RespondTxStatus.moneyFlew[(NUMBER_OF_TRANSACTIONS_PER_TICK+7)/8]
});
