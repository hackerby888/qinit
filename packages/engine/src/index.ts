// Browser- and Node-safe public API for the Qubic contract simulation engine.
// The Bun-only HTTP adapter is exported from "@qinit/engine/server".
export {
  Contract,
  CONTRACT_ENTRY_KIND,
  ContractAbort,
} from "./contract/runtime";
export type { HostServices } from "./contract/runtime";
export { SYSTEM_PROCEDURES } from "@qinit/core";
export { EngineFaultedError, QubicSimulator } from "./qubic-simulator";
export type { TickRecord } from "./qubic-simulator";
export type { EngineFaultInfo } from "@qinit/core";
export { runContractTesting } from "./gtest";
export type { TestResult } from "./gtest";
export { runCompiledGtest } from "./gtest-program";
export type { CompiledGtestProgram } from "./gtest-program";
export type { AssetSnapshot } from "./ledger/assets";
export { VirtualNode } from "./transport";
export type { VirtualNodeOptions } from "./transport";
export { QubicLogStore } from "./logging/qubic-log-store";
export type { QubicLogRange } from "./logging/qubic-log-store";
export type { EngineLogEvent, LogLevel, LogSink } from "./logging/log";
export { initK12, k12Bytes, toHex, deriveKeysSync, signSync, verifySync } from "./support/k12";
export type { KeyPair } from "./support/k12";
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
} from "./chain/consensus";
export type { Computor, CommitteeOpts, TickStateDigests } from "./chain/consensus";
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
} from "./protocol/wire";
