// Browser-safe entry for @qinit/core. The package index re-exports ./fetch, ./project, ./backtrace, which
// pull node:fs / child_process; this entry exposes only browser-safe identity, tx signing, and signing helpers.
export * from "./codec/struct"; // zero-copy struct-view kit — node-free, safe in the browser bundle
export * from "./crypto/bytes";
export {
  LHOST_ABI,
  ASSET_ENUMERATION_RECORD,
  WASM_ABI_VERSION,
  SYSTEM_PROCEDURES,
  SYSTEM_PROCEDURE_COUNT,
  CONTRACT_ENTRY_POINTS,
} from "./wasm/lhost-abi";
export type { LhostFunctionSignature, LhostImportName, LhostValueType } from "./wasm/lhost-abi";
export { CORE_WASM_HEADERS } from "./wasm/headers";
export type { CoreWasmHeaderLayout } from "./wasm/headers";
export { DEFAULT_WASM_SLOT_LAYOUT } from "./wasm/slot-layout";
export type { WasmSlotLayout } from "./wasm/slot-layout";
export { parseWasmSlotLayoutSource } from "./wasm/slot-layout-source";
export {
  deriveIdentity,
  bytesToIdentity,
  identityToBytes,
  contractIndexFromIdentity,
  cryptoSmoke,
} from "./crypto/qubic";
export type { IdentityResult, CryptoSmokeResult } from "./crypto/qubic";

export { buildSignedTx, assertSeed, LITE_DEPLOY_ADDRESS } from "./crypto/tx";
export type { SignedTx, TxInput } from "./crypto/tx";

export { LiteRpc } from "./net/rpc/client";
export type {
  TickInfo,
  EngineFaultInfo,
  DynamicContractRegistry,
  DynamicContractRegistryEntry,
  DynamicContractEntry,
  DynamicContractUploadStatus,
  DebugTrace,
  DebugEntry,
  DebugHostCall,
  DebugStateRegion,
  ExplorerData,
  ExplorerTx,
  ExplorerTickData,
  IdentityTransfer,
  ContractCall,
  ContractCallsPage,
  ContractListEntry,
} from "./net/rpc/types";

export {
  LOOPBACK_HOST,
  DEFAULT_RPC_PORT,
  DEFAULT_RPC_BASE,
  DEFAULT_PEER_PORT,
  broadcastTx,
  broadcastTxs,
  fetchWithTimeout,
  readResponseBodyWithTimeout,
} from "./net/http";
export type { BroadcastResult } from "./net/http";

export type { NodeTransport, TxStatus, StateRead, EntityInfo, TxInfo } from "./net/transport";

export { k12Sync, deriveKeysSync, verifySync } from "./crypto/qubic";
export type { KeyPair } from "./crypto/qubic";

// Kept so browser callers that already await it keep working; hashing needs no setup now that
// @qubic.org/crypto replaced the Emscripten module. Sync signing (./crypto/sign-sync) stays out of
// this entry — it is engine-only and would pull the wasm back into the page bundle.
export async function initK12(): Promise<void> {}
