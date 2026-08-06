const WASM_EXTENSION_ROOT = "extensions/wasm";

const header = (path: string): string => `${WASM_EXTENSION_ROOT}/${path}`;

/** Canonical core-lite Wasm header layout, relative to the core `src` include root. */
export const CORE_WASM_HEADERS = Object.freeze({
  root: WASM_EXTENSION_ROOT,
  shared: Object.freeze({
    abiMetadata: header("shared/abi_metadata.h"),
    abiTypes: header("shared/abi_types.h"),
  }),
  sdk: Object.freeze({
    platformIntrinsics: header("sdk/platform_intrinsics.h"),
    intercontractCalls: header("sdk/intercontract_calls.h"),
    qpiSupport: header("sdk/qpi_support.h"),
    lhostImports: header("sdk/lhost_imports.h"),
    qpiForwarders: header("sdk/qpi_forwarders.h"),
    registration: header("sdk/registration.h"),
    moduleStorage: header("sdk/module_storage.h"),
    dispatch: header("sdk/dispatch.h"),
    moduleRuntime: header("sdk/module_runtime.h"),
  }),
  runtime: Object.freeze({
    extension: header("runtime/extension.h"),
    stateBackend: header("runtime/state_backend.h"),
    reservedSlotContract: header("runtime/reserved_slot_contract.h"),
    arenaScope: header("runtime/arena_scope.h"),
    trace: header("runtime/trace.h"),
    stateWriteTracker: header("runtime/state_write_tracker.h"),
    oracleServices: header("runtime/oracle_services.h"),
    qpiServices: header("runtime/qpi_services.h"),
    hostServices: header("runtime/host_services.h"),
    contractSlots: header("runtime/contract_slots.h"),
    deploymentProtocol: header("runtime/deployment_protocol.h"),
    deployment: header("runtime/deployment.h"),
    lhostRegistry: header("runtime/lhost_registry.h"),
    engineState: header("runtime/engine_state.h"),
    dispatch: header("runtime/dispatch.h"),
    moduleLoader: header("runtime/module_loader.h"),
    registration: header("runtime/registration.h"),
    engine: header("runtime/engine.h"),
  }),
});

export type CoreWasmHeaderLayout = typeof CORE_WASM_HEADERS;
