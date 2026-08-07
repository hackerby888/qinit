// Replaces core's sign-sync-esm in the generated SDK: dapps sign through buildSignedTx (pure TS), so the
// Emscripten FourQ it loads is dead weight that would drag node builtins into a bundle that must have none.
export async function initK12(): Promise<void> {}

export function signSync(): Uint8Array {
  throw new Error("signSync is not available in the generated SDK — use buildSignedTx");
}
