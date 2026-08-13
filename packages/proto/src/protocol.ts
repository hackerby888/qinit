// Core-lite mirrors checked by scripts/core-compat/check-protocol-drift.ts.

// Lite deploy transaction inputTypes — core runtime/deployment_protocol.h WASM_DEPLOYMENT_*.
export const LITE_TX = { UPLOAD_BEGIN: 240, UPLOAD_CHUNK: 241, DEPLOY: 242 } as const;

// Core src/logging/logging.h message types.
export const QUBIC_LOG_TYPE = {
    QU_TRANSFER: 0,
    ASSET_ISSUANCE: 1,
    ASSET_OWNERSHIP_CHANGE: 2,
    ASSET_POSSESSION_CHANGE: 3,
    CONTRACT_ERROR_MESSAGE: 4,
    CONTRACT_WARNING_MESSAGE: 5,
    CONTRACT_INFORMATION_MESSAGE: 6,
    CONTRACT_DEBUG_MESSAGE: 7,
    BURNING: 8,
    DUST_BURNING: 9,
    SPECTRUM_STATS: 10,
    ASSET_OWNERSHIP_MANAGING_CONTRACT_CHANGE: 11,
    ASSET_POSSESSION_MANAGING_CONTRACT_CHANGE: 12,
    CONTRACT_RESERVE_DEDUCTION: 13,
    ORACLE_QUERY_STATUS_CHANGE: 14,
    ORACLE_SUBSCRIBER_MESSAGE: 15,
    OC_INVOCATION_STATUS_CHANGE: 16,
    CUSTOM_MESSAGE: 255,
} as const;

export const LOG_SEVERITY: Record<number, string> = {
    [QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE]: "ERROR",
    [QUBIC_LOG_TYPE.CONTRACT_WARNING_MESSAGE]: "WARN",
    [QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE]: "INFO",
    [QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE]: "DEBUG",
};

// src/network_messages/common_def.h
export const MAX_INPUT_SIZE = 1024;
export const MAX_NUMBER_OF_CONTRACTS = 1024;
export const TXS_PER_TICK = 4096;
export const MAINNET_COMPUTOR_COUNT = 676;
export const SPECTRUM_DEPTH = 24;
export const ASSETS_DEPTH = 24;
export const MAX_ORACLE_QUERY_SIZE = MAX_INPUT_SIZE - 16;
export const MAX_ORACLE_REPLY_SIZE = MAX_INPUT_SIZE - 16;
export const ORACLE_STATUS = {
    UNKNOWN: 0,
    PENDING: 1,
    COMMITTED: 2,
    SUCCESS: 3,
    TIMEOUT: 4,
    UNRESOLVABLE: 5,
} as const;

export const CHUNK_HEADER_SIZE = 14; // UploadChunk: sessionId(8) + seq(4) + len(2)
// Upload chunks keep their proven size; this is independent of the oracle payload limit.
export const CHUNK_DATA_MAX = 1008;
export const TX_HEADER_SIZE = 144; // src32+dst32+amount8+tick4+inputType2+inputSize2+sig64

// Schedule outgoing transactions three ticks ahead for propagation at the default cadence.
export const TX_TICK_OFFSET = 3;
