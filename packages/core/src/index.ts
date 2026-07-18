// Qubic protocol primitives for Qinit, wrapping @qubic-lib/qubic-ts-library.
export * from "./struct"; // zero-copy struct-view kit (defineStruct + codecs), shared by @qinit/engine + @qinit/proto
export {
  LHOST_ABI,
  ASSET_ENUMERATION_RECORD,
  WASM_ABI_VERSION,
  SYSTEM_PROCEDURES,
} from "./lhost-abi";
export type { LhostFunctionSignature, LhostImportName, LhostValueType } from "./lhost-abi";
export { CORE_WASM_HEADERS } from "./wasm-headers";
export type { CoreWasmHeaderLayout } from "./wasm-headers";
export { loadWasmAbiSource } from "./wasm-abi-node";
export { parseWasmAbiSource } from "./wasm-abi-source";
export type { WasmAbiSource, WasmAbiValueType } from "./wasm-abi-source";
export { DEFAULT_WASM_SLOT_LAYOUT } from "./wasm-slot-layout";
export type { WasmSlotLayout } from "./wasm-slot-layout";
export { loadCoreWasmSlotLayout } from "./wasm-slot-layout-node";
export { parseWasmSlotLayoutSource } from "./wasm-slot-layout-source";
export {
  deriveIdentity,
  cryptoSmoke,
  k12Hex,
  initK12,
  k12Sync,
  bytesToIdentity,
  identityToBytes,
  deriveKeysSync,
  signSync,
  verifySync,
} from "./qubic";
export type { IdentityResult, CryptoSmokeResult, KeyPair } from "./qubic";
export { buildSignedTx, assertSeed, LITE_DEPLOY_ADDRESS } from "./tx";
export type { SignedTx, TxInput } from "./tx";
export { LiteRpc } from "./rpc";
export type {
  TickInfo,
  DynRegistry,
  DynContract,
  DynEntry,
  DynUpload,
  DebugTrace,
  DebugEntry,
  DebugHostCall,
  DebugStateRegion,
} from "./rpc";
export type { NodeTransport, TxStatus, StateRead, EntityInfo, TxInfo } from "./transport";
export { broadcastTx, broadcastTxs, fetchT, readBody } from "./net";
export type { BroadcastResult } from "./net";
export {
  RELEASE_REPO,
  cacheRoot,
  cacheDir,
  cacheHeaders,
  sha256Hex,
  atomicWrite,
  loadManifest,
  fetchVerify,
  extractTarGz,
  currentPath,
  readCurrent,
  updateCurrent,
  VERIFY_REPO,
  VERIFY_TAG,
  toolsDir,
  cachedVerifyToolPath,
  verifyPlatformKey,
  loadVerifyManifest,
  autoUpdateVerifyTool,
  wasiSdkDir,
  wasiSdkPaths,
  haveWasiSdkCache,
  fetchWasiSdk,
  CLI_REPO,
  cliAssetName,
  resolveCliTag,
  cliReleaseUrls,
  fetchCliSha,
} from "./fetch";
export type { AssetRef, Manifest, CurrentPointer, VerifyManifest, VerifyUpdate } from "./fetch";
export { loadConfig, resolveCore } from "./project";
export type { QinitConfig } from "./project";
export { debug } from "./debug";
export { resolveTrapBacktrace, formatTrapBacktrace, decodeTrapCause } from "./backtrace";
export type { TrapFrame, TrapBacktrace } from "./backtrace";
