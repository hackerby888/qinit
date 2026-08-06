// Synchronous SchnorrQ signing, still on @qubic-lib's Emscripten FourQ.
//
// @qubic.org/crypto has a synchronous signer internally, but its package exports only the async
// `sign(message, seed)` wrapper — and the simulator's tick path (finalizeTick -> buildTickVote /
// buildTickData) is synchronous end to end, so an async signer would have to ripple through the
// whole engine. Hashing and identity moved to @qubic.org/crypto; only this one call stayed.
//
// Nothing here ever sees a large input: SchnorrQ signs 32-byte digests, so the Emscripten module's
// fixed 16 MiB heap is irrelevant on this path.
import type { KeyPair } from "./qubic";

interface SchnorrQ {
  sign(subseed: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array;
}

let _schnorrq: SchnorrQ | null = null;

export async function initK12(): Promise<void> {
  if (_schnorrq) return;
  // Static CJS require -> bun bundles a single instance. ESM `import *` / createRequire resolved a
  // second, uninitialized Emscripten instance under --compile.
  // @ts-ignore - require is provided by bun
  const cryptoMod: any = require("@qubic-lib/qubic-ts-library/dist/crypto");
  _schnorrq = (await (cryptoMod.default ?? cryptoMod)).schnorrq;
}

// `privateKey` is the FourQ subseed from deriveKeysSync — what SchnorrQ actually signs with.
export function signSync(
  privateKey: KeyPair["privateKey"],
  publicKey: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  if (!_schnorrq) {
    throw new Error("signer not initialized — await initK12() first");
  }

  return _schnorrq.sign(privateKey, publicKey, digest);
}
