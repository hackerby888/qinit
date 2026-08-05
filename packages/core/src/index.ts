// Qubic protocol primitives for Qinit, wrapping @qubic-lib/qubic-ts-library.
export * from "./struct"; // zero-copy struct-view kit (defineStruct + codecs), shared by @qinit/engine + @qinit/proto
export { bytesToHex, hexToBytes } from "./bytes";
export {
  LHOST_ABI,
  ASSET_ENUMERATION_RECORD,
  WASM_ABI_VERSION,
  SYSTEM_PROCEDURES,
  SYSTEM_PROCEDURE_COUNT,
  CONTRACT_ENTRY_POINTS,
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
  contractIndexFromIdentity,
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
} from "./rpc";
export type { NodeTransport, TxStatus, StateRead, EntityInfo, TxInfo } from "./transport";
export {
  LOOPBACK_HOST,
  DEFAULT_RPC_PORT,
  DEFAULT_RPC_BASE,
  DEFAULT_PEER_PORT,
  broadcastTx,
  broadcastTxs,
  fetchWithTimeout,
  readResponseBodyWithTimeout,
} from "./net";
export type { BroadcastResult } from "./net";
export {
  RELEASE_REPO,
  cacheRoot,
  cacheDir,
  cacheHeaders,
  sha256Hex,
  atomicWrite,
  loadManifest,
  downloadVerifiedAsset,
  extractTarGz,
  currentPath,
  readCurrent,
  updateCurrent,
  VERIFY_REPO,
  VERIFY_TAG,
  toolsDir,
  cachedVerifyToolPath,
  releasePlatformKey,
  loadVerifyManifest,
  autoUpdateVerifyTool,
  wasiSdkDir,
  managedWasiSdkStatus,
  wasiSdkPaths,
  haveWasiSdkCache,
  fetchWasiSdk,
  CLI_REPO,
  cliAssetName,
  resolveCliTag,
  cliReleaseUrls,
  fetchCliSha,
} from "./fetch";
export type {
  AssetRef,
  ReleaseSource,
  Manifest,
  CurrentPointer,
  VerifyManifest,
  VerifyUpdate,
  ManagedWasiSdkStatus,
} from "./fetch";
export { loadConfig, resolveCoreDir } from "./project";
export type { QinitConfig } from "./project";
export { debug } from "./debug";
export { resolveTrapBacktrace, formatTrapBacktrace, decodeTrapCause } from "./backtrace";
export type { TrapFrame, TrapBacktrace } from "./backtrace";
