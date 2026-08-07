// ESM twin of ./sign-sync for the bundled entries: same FourQ module, but sign-sync's CJS `require` (needed
// by `bun build --compile`) cannot run in a page bundle. Kept off browser.ts so gen-runtime can stub it.
import cryptoModule from "@qubic-lib/qubic-ts-library/dist/crypto/index.js";

interface SchnorrQ {
  sign(privateKey: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array;
}

let _schnorrq: SchnorrQ | null = null;

export async function initK12(): Promise<void> {
  if (_schnorrq) {
    return;
  }

  const resolved = await ((cryptoModule as { default?: unknown }).default ?? cryptoModule);
  _schnorrq = (resolved as { schnorrq: SchnorrQ }).schnorrq;
}

export function signSync(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  if (!_schnorrq) {
    throw new Error("signer not initialized — await initK12() first");
  }

  return _schnorrq.sign(privateKey, publicKey, digest);
}
