// Replaces ./sign-sync-esm in bundles that never sign (proto, compiler, the generated SDK): signing there
// goes through buildSignedTx (pure TS), so the Emscripten FourQ would be dead weight with node-only glue.
export async function initK12(): Promise<void> {}

export function signSync(): Uint8Array {
  throw new Error("signSync is not bundled here — use buildSignedTx");
}
