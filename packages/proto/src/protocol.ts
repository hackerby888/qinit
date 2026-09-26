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

// logging.h CUSTOM_MESSAGE_OP_*: eight ASCII bytes read as a little-endian uint64, the whole payload of a marker record.
export const CUSTOM_MESSAGE_OP = {
    START_DISTRIBUTE_DIVIDENDS: 6217575821008262227n,
    END_DISTRIBUTE_DIVIDENDS: 6217575821008457285n,
    START_EPOCH: 4850183582582395987n,
    END_EPOCH: 4850183582582591045n,
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
// what a host reports when an inter-contract call never ran (core's CallError values); 0 is NO_CALL_ERROR.
export const INTER_CONTRACT_CALL_ERROR: Record<number, string> = {
    2: "insufficient fees — the callee has no execution fee reserve",
    3: "allocation failed — no room for the callee's context",
    4: "contract inactive — not deployed, or its slot is not below the caller's",
};

// the host row of a failed nested call ends in `✗ err N`; the number reads better with core's name for it.
export function hostCallError(detail: string): { code: number; reason: string } | undefined {
    const match = /✗ err (\d+)$/.exec(detail);
    if (!match) {
        return undefined;
    }
    const code = Number(match[1]);
    return { code, reason: INTER_CONTRACT_CALL_ERROR[code] ?? `error ${code}` };
}
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

// an OC invocation has no reply: the status only tracks whether the computors authorized the bundle.
export const OC_INVOCATION_STATUS = {
    UNKNOWN: 0,
    PENDING_AUTH: 1,
    AUTHORIZED: 2,
    TIMEOUT: 3,
} as const;

// src/oc_core/oc_engine.h
export const MIN_OC_INVOCATION_FEE = 10n;
export const MAX_OC_REQUEST_SIZE = MAX_INPUT_SIZE - 16;
export const OC_INVOCATION_TIMEOUT_DEFAULT_TICKS = 12;
export const MAX_OC_IN_FLIGHT_INVOCATIONS = 1024;
export const MAX_OC_INVOCATIONS_PER_EPOCH = 1 << 21;
export const OC_REQUEST_STORAGE_SIZE = 256 * MAX_OC_INVOCATIONS_PER_EPOCH;
// src/qubic.cpp: the tick offset the authorization signatures are scheduled at, so AUTHORIZED lands this many ticks after the call.
export const OC_AUTH_SIGNATURE_PUBLICATION_OFFSET = 3;

export const CHUNK_HEADER_SIZE = 14; // UploadChunk: sessionId(8) + seq(4) + len(2)
// Upload chunks keep their proven size; this is independent of the oracle payload limit.
export const CHUNK_DATA_MAX = 1008;
export const TX_HEADER_SIZE = 144; // src32+dst32+amount8+tick4+inputType2+inputSize2+sig64

// Schedule outgoing transactions three ticks ahead for propagation at the default cadence.
export const TX_TICK_OFFSET = 3;
