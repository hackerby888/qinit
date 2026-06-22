// K12 for the engine — reuses the single crypto instance owned by @qinit/core (initK12 + k12Sync), so there
// is exactly one (initialized) @qubic-lib Emscripten instance. `lh_k12` and the state digest call k12Bytes.
export { initK12, k12Sync as k12Bytes, deriveKeysSync, signSync, verifySync } from "@qinit/core";
export type { KeyPair } from "@qinit/core";

export function toHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
