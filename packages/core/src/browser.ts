// Browser-safe entry for @qinit/core. The package index re-exports ./fetch, ./project, ./backtrace, which
// pull node:fs / child_process; this entry exposes only the browser-usable surface: identity, tx signing,
// rpc/net (fetch-based), the transport types, and K12. The one rewrite vs the index is K12 — ./qubic resolves
// @qubic-lib's emscripten crypto via bun `require(...)`, which doesn't exist in a browser/bundler, so here it
// is a normal ESM import (the non-K12 identity helpers in ./qubic are import-safe and re-used as-is).
//
// Consumed two ways: bundlers that need a node-free @qinit/core alias to this file (e.g. @qinit/engine's
// build), and apps that want it directly via `@qinit/core/browser`.
export * from "./struct"; // zero-copy struct-view kit — node-free, safe in the browser bundle
export { deriveIdentity, bytesToIdentity, identityToBytes, cryptoSmoke } from "./qubic";
export type { IdentityResult, CryptoSmokeResult } from "./qubic";

export { buildSignedTx, assertSeed, LITE_DEPLOY_ADDRESS } from "./tx";
export type { SignedTx, TxInput } from "./tx";

export { LiteRpc } from "./rpc";
export type {
  TickInfo, DynRegistry, DynContract, DynEntry, DynUpload,
  DebugTrace, DebugEntry, DebugHostCall, DebugStateRegion,
} from "./rpc";

export { broadcastTx, broadcastTxs, fetchT, readBody } from "./net";
export type { BroadcastResult } from "./net";

export type { NodeTransport, TxStatus, StateRead, EntityInfo, TxInfo } from "./transport";
export type { KeyPair } from "./qubic";

// K12 (KangarooTwelve): ESM import of @qubic-lib's emscripten crypto (the same module ./qubic uses), so it
// runs in the page. `default` resolves (once the wasm runtime is ready) to { K12, schnorrq } where K12(input,
// out, outLen) writes into `out`. k12Sync mirrors @qinit/core's signature — `(bytes) => Uint8Array(32)`; the
// schnorrq object backs the sync FourQ key/sign/verify the engine's tick-consensus needs.
import cryptoModule from "@qubic-lib/qubic-ts-library/dist/crypto/index.js";
import { KeyHelper } from "@qubic-lib/qubic-ts-library/dist/keyHelper.js";
import type { KeyPair } from "./qubic";

type RawK12 = (input: Uint8Array, out: Uint8Array, outLen: number) => void;
interface SchnorrQ {
  generatePublicKey(privateKey: Uint8Array): Uint8Array;
  sign(privateKey: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): number;
}
let _k12raw: RawK12 | null = null;
let _schnorrq: SchnorrQ | null = null;
const _keyHelper = new KeyHelper();

export async function initK12(): Promise<void> {
  if (_k12raw) {
    return;
  }

  const resolved = await ((cryptoModule as { default?: unknown }).default ?? cryptoModule);
  _k12raw = (resolved as { K12: RawK12 }).K12;
  _schnorrq = (resolved as { schnorrq: SchnorrQ }).schnorrq;
}

export function k12Sync(bytes: Uint8Array): Uint8Array {
  if (!_k12raw) {
    throw new Error("K12 not initialised — await initK12() first");
  }

  const out = new Uint8Array(32);
  _k12raw(bytes, out, 32);
  return out;
}

// Sync FourQ key derivation + signing, mirroring ./qubic's deriveKeysSync/signSync/verifySync but bound to
// this entry's own resolved crypto instance (the page/bundler one, not the bun `require` one).
export function deriveKeysSync(seed: string): KeyPair {
  if (!_k12raw || !_schnorrq) {
    throw new Error("crypto not initialised — await initK12() first");
  }

  const privateKey = _keyHelper.privateKey(seed, 0, _k12raw);
  const publicKey = _schnorrq.generatePublicKey(privateKey);
  return { privateKey, publicKey };
}

export function signSync(privateKey: Uint8Array, publicKey: Uint8Array, digest: Uint8Array): Uint8Array {
  if (!_schnorrq) {
    throw new Error("crypto not initialised — await initK12() first");
  }

  return _schnorrq.sign(privateKey, publicKey, digest);
}

export function verifySync(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (!_schnorrq) {
    throw new Error("crypto not initialised — await initK12() first");
  }

  return _schnorrq.verify(publicKey, message, signature) === 1;
}
