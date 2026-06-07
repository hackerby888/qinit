// Cross-boundary protocol constants that MIRROR core-lite. The drift guard (scripts/check-protocol-drift.ts)
// asserts these equal the core values in CI — change here AND in core together, never one side alone.

// Lite deploy transaction inputTypes — core src/extensions/lite_dynamic_contracts.h LITE_TX_*.
export const LITE_TX = { UPLOAD_BEGIN: 240, UPLOAD_CHUNK: 241, DEPLOY: 242 } as const;

// Contract LOG_* severity codes — core src/logging/logging.h CONTRACT_{ERROR,WARNING,INFORMATION,DEBUG}_MESSAGE.
// (Names are qinit's display labels; the numeric codes are the wire contract.)
export const LOG_SEVERITY: Record<number, string> = { 4: "ERROR", 5: "WARN", 6: "INFO", 7: "DEBUG" };

// Transaction sizing — core src/network_messages/common_def.h MAX_INPUT_SIZE.
export const MAX_INPUT_SIZE = 1024;
export const CHUNK_HEADER_SIZE = 14;                       // UploadChunk: sessionId(8) + seq(4) + len(2)
// Deploy chunk data size. Conservative: < MAX_INPUT_SIZE - CHUNK_HEADER_SIZE (1010); 1008 is the proven,
// shipped value every deploy uses — do NOT bump without re-testing the chunked-upload path against core.
export const CHUNK_DATA_MAX = 1008;
export const TX_HEADER_SIZE = 144;                        // src32+dst32+amount8+tick4+inputType2+inputSize2+sig64

// Ticks ahead of the current tick to schedule an outgoing tx. The dev node runs --ticking-delay 1000
// (~1 tick/s), so +3 gives ~3 s for the tx to propagate and land in a future tick — the minimum that
// clears the "tick already in progress" window without making the user wait. NOT a protocol constant.
export const TX_TICK_OFFSET = 3;
