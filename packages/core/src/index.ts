// Qubic protocol primitives for Qinit, wrapping @qubic.org/crypto and @qubic.org/tx.
export * from "./codec/struct"; // zero-copy struct-view kit (defineStruct + codecs), shared by @qinit/engine + @qinit/proto
export { bytesToHex, hexToBytes } from "./crypto/bytes";
export {
    LHOST_ABI,
    ASSET_ENUMERATION_RECORD,
    WASM_ABI_VERSION,
    SYSTEM_PROCEDURES,
    SYSTEM_PROCEDURE_COUNT,
    CONTRACT_ENTRY_POINTS,
    CHEAT_OP,
    CHEAT_ERR,
    WASM_TRAP_ERROR_CODE,
} from "./wasm/lhost-abi";
export type { LhostFunctionSignature, LhostImportName, LhostValueType } from "./wasm/lhost-abi";
export { CORE_WASM_HEADERS } from "./wasm/headers";
export type { CoreWasmHeaderLayout } from "./wasm/headers";
export { loadWasmAbiSource } from "./wasm/abi-node";
export { parseWasmAbiSource } from "./wasm/abi-source";
export type { WasmAbiSource, WasmAbiValueType } from "./wasm/abi-source";
export { DEFAULT_WASM_SLOT_LAYOUT } from "./wasm/slot-layout";
export type { WasmSlotLayout } from "./wasm/slot-layout";
export { loadCoreWasmSlotLayout } from "./wasm/slot-layout-node";
export { parseWasmSlotLayoutSource } from "./wasm/slot-layout-source";
export {
    deriveIdentity,
    cryptoSmoke,
    k12Hex,
    k12Sync,
    bytesToIdentity,
    identityToBytes,
    contractIndexFromIdentity,
    deriveKeysSync,
    verifySync,
} from "./crypto/qubic";
export { initK12, signSync } from "./crypto/sign-sync";
export type { IdentityResult, CryptoSmokeResult, KeyPair } from "./crypto/qubic";
export { buildSignedTx, assertSeed, LITE_DEPLOY_ADDRESS } from "./crypto/tx";
export { TESTNET_FUNDED_SEEDS, DEFAULT_FUNDED_SEED } from "./crypto/testnet-seeds";
export type { SignedTx, TxInput } from "./crypto/tx";
export { LiteRpc } from "./net/rpc/client";
export type {
    TickInfo,
    EngineFaultInfo,
    NodeBackendIdentity,
    DirectDeploymentKind,
    DynamicContractRegistry,
    DynamicContractRegistryEntry,
    DynamicContractEntry,
    DynamicContractUploadStatus,
    DebugTrace,
    DebugCheat,
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
export type { NodeTransport, TxStatus, StateRead, EntityInfo, TxInfo } from "./net/transport";
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
export { cacheRoot, cacheDir, cacheHeaders, toolsDir, releasePlatformKey, currentPath, readCurrent, updateCurrent } from "./cache/paths";
export type { CurrentPointer } from "./cache/paths";
export { sha256Hex, atomicWrite, downloadVerifiedAsset, extractTarGz } from "./cache/download";
export { RELEASE_REPO, loadManifest } from "./cache/manifest";
export type { AssetRef, ReleaseSource, Manifest } from "./cache/manifest";
export { CLI_REPO, cliAssetName, resolveCliTag, cliReleaseUrls, fetchCliSha } from "./cache/cli-release";
export { VERIFY_REPO, VERIFY_TAG, cachedVerifyToolPath, loadVerifyManifest, autoUpdateVerifyTool } from "./cache/verify-tool";
export type { VerifyManifest, VerifyUpdate } from "./cache/verify-tool";
export { wasiSdkDir, managedWasiSdkStatus, wasiSdkPaths, haveWasiSdkCache, fetchWasiSdk } from "./cache/wasi-sdk";
export type { ManagedWasiSdkStatus } from "./cache/wasi-sdk";
export { loadConfig, resolveCoreDir } from "./project";
export type { QinitConfig } from "./project";
export { debug } from "./debug/log";
export { resolveTrapBacktrace, formatTrapBacktrace, decodeTrapCause } from "./debug/backtrace";
export type { TrapFrame, TrapBacktrace } from "./debug/backtrace";
