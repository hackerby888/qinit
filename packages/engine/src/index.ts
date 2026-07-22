// Browser- and Node-safe public API for the Qubic contract simulation engine.
// The Bun-only HTTP adapter is exported from "@qinit/engine/server".
export { Contract, KIND, SP, ContractAbort } from "./runtime";
export type { HostServices } from "./runtime";
export { Sim } from "./sim";
export type { TickRecord } from "./sim";
export { runContractTesting } from "./gtest";
export type { TestResult } from "./gtest";
export { runCompiledGtest } from "./gtest-program";
export type { CompiledGtestProgram } from "./gtest-program";
export type { AssetSnapshot } from "./assets";
export { VirtualNode } from "./transport";
export { NativeLogger } from "./native-logger";
export type { NativeLogRange } from "./native-logger";
export type { EngineLogEvent, LogLevel, LogSink } from "./log";
export { initK12, k12Bytes, toHex, deriveKeysSync, signSync, verifySync } from "./k12";
export type { KeyPair } from "./k12";
export {
  Committee,
  quorumOf,
  randomSeed,
  merkleRoot,
  buildTickVote,
  voteIsAligned,
  tickVoteMessage,
  tickVoteSignature,
  DEFAULT_ARBITRATOR_SEED,
  DEFAULT_NUMBER_OF_COMPUTORS,
  MAX_NUMBER_OF_CONTRACTS,
  TICK_SIZE,
} from "./consensus";
export type { Computor, CommitteeOpts, TickStateDigests } from "./consensus";
export {
  M256i,
  TickData,
  Tick,
  Transaction,
  EntityRecord,
  AssetRecord,
  RequestResponseHeader,
  ASSET_TYPE,
  TXS_PER_TICK,
  TICKDATA_SIZE,
  DIGEST_SIZE,
  SIG_SIZE,
  ASSET_RECORD_SIZE,
} from "./wire";
