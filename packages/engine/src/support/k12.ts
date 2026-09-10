// K12 for the engine — reuses the single crypto instance owned by @qinit/core, so there is exactly one initialized signer.
export { initK12, k12Sync as k12Bytes, deriveKeysSync, signSync, verifySync } from "@qinit/core";
export type { KeyPair } from "@qinit/core";
export { bytesToHex as toHex } from "@qinit/core";
