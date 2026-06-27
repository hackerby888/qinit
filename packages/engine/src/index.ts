// Public API of @qinit/engine — the framework-agnostic Qubic smart-contract simulation engine. Browser- and
// Node-safe (no node:fs, no Bun). The HTTP adapter (EngineServer, Bun-only) is a separate entry: "@qinit/engine/server".
export { Contract, KIND, SP, ContractAbort } from "./runtime";
export type { HostServices } from "./runtime";
export { Sim } from "./sim";
export type { TickRecord } from "./sim";
export type { AssetSnapshot } from "./assets";
export { VirtualNode } from "./transport";
export type { EngineLogEvent, LogLevel, LogSink } from "./log";
export { initK12, k12Bytes, toHex, deriveKeysSync, signSync, verifySync } from "./k12";
export type { KeyPair } from "./k12";
export {
  Committee, quorumOf, randomSeed, merkleRoot,
  buildTickVote, voteIsAligned, tickVoteMessage, tickVoteSignature,
  DEFAULT_ARBITRATOR_SEED, DEFAULT_NUMBER_OF_COMPUTORS, MAX_NUMBER_OF_CONTRACTS, TICK_SIZE,
} from "./consensus";
export type { Computor, CommitteeOpts, TickStateDigests } from "./consensus";
export {
  M256i, TickData, Tick, Transaction, EntityRecord, AssetRecord, RequestResponseHeader,
  ASSET_TYPE, TXS_PER_TICK, TICKDATA_SIZE, DIGEST_SIZE, SIG_SIZE, ASSET_RECORD_SIZE,
} from "./wire";
