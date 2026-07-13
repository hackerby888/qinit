// Identity + crypto via @qubic-lib/qubic-ts-library.
// NOTE: if this import fails after `bun install`, check the installed package's
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper.js";
import { KeyHelper } from "@qubic-lib/qubic-ts-library/dist/keyHelper.js";

export interface IdentityResult {
  identity: string; // 60 uppercase letters
  publicKeyHex: string;
}

export interface KeyPair {
  privateKey: Uint8Array; // 32 bytes
  publicKey: Uint8Array; // 32 bytes (FourQ)
}

export interface CryptoSmokeResult {
  ok: boolean;
  identity: string;
  publicKeyHex: string;
  note: string;
}

const helper: any = new QubicHelper();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// KangarooTwelve (KT128, 32-byte digest) — matches the core's content addressing.
// The lib's crypto default export is a Promise resolving to { schnorrq, K12 } once
export async function k12Hex(bytes: Uint8Array): Promise<string> {
  // Static CJS require -> bun bundles + dedups to the SAME crypto instance QubicHelper inits.
  // ESM `import *` / createRequire resolved a second, uninitialized Emscripten instance under --compile.
  const cryptoMod: any = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { K12 } = await (cryptoMod.default ?? cryptoMod);
  const out = new Uint8Array(32);
  K12(bytes, out, 32);
  return toHex(out);
}

// Synchronous K12 for callers that hash inside a tight loop or a wasm host import (e.g. the TS SC engine's
// `lh_k12` + state digest), where awaiting per call isn't possible. Resolve the crypto module once via
let _k12Sync: ((input: Uint8Array, out: Uint8Array, outLen: number) => void) | null = null;
// The resolved FourQ/SchnorrQ object from the SAME crypto module — captured once so signing/verification run
// synchronously after initK12() (mirrors k12Sync). Used by the engine's tick-consensus (computor vote signing).
let _schnorrq: {
  generatePublicKey(privateKey: Uint8Array): Uint8Array;
  sign(privateKey: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): number;
} | null = null;
const _keyHelper = new KeyHelper();

export async function initK12(): Promise<void> {
  if (_k12Sync) return;
  // @ts-ignore - require is provided by bun (see k12Hex above for the resolution rationale)
  const cryptoMod: any = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { K12, schnorrq } = await (cryptoMod.default ?? cryptoMod);
  _k12Sync = K12;
  _schnorrq = schnorrq;
}

export function k12Sync(bytes: Uint8Array): Uint8Array {
  if (!_k12Sync) throw new Error("k12 not initialized — await initK12() first");
  const out = new Uint8Array(32);
  _k12Sync(bytes, out, 32);
  return out;
}

// Synchronous FourQ key derivation + signing for callers that run inside a tight, non-async path (the engine's
// per-tick computor-vote signing). All three require initK12() to have resolved the crypto module first.
export function deriveKeysSync(seed: string): KeyPair {
  if (!_k12Sync || !_schnorrq) {
    throw new Error("crypto not initialized — await initK12() first");
  }

  const privateKey = _keyHelper.privateKey(seed, 0, _k12Sync);
  const publicKey = _schnorrq.generatePublicKey(privateKey);
  return { privateKey, publicKey };
}

export function signSync(
  privateKey: Uint8Array,
  publicKey: Uint8Array,
  digest: Uint8Array,
): Uint8Array {
  if (!_schnorrq) {
    throw new Error("crypto not initialized — await initK12() first");
  }

  return _schnorrq.sign(privateKey, publicKey, digest);
}

export function verifySync(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (!_schnorrq) {
    throw new Error("crypto not initialized — await initK12() first");
  }

  return _schnorrq.verify(publicKey, message, signature) === 1;
}

// Deriving an identity exercises K12 (subseed) + FourQ (public key) in the
// library's wasm crypto — the thing we must prove works in the compiled binary.
export async function deriveIdentity(seed: string): Promise<IdentityResult> {
  const pkg = await helper.createIdPackage(seed);
  return { identity: pkg.publicId, publicKeyHex: toHex(pkg.publicKey) };
}

// id codec: 60-char identity <-> 32-byte public key (for the contract ABI `id` type).
export async function bytesToIdentity(bytes: Uint8Array): Promise<string> {
  return helper.getIdentity(bytes, false); // false = uppercase
}
export function identityToBytes(identity: string): Uint8Array {
  return helper.getIdentityBytes(identity);
}

const VALID_IDENTITY = /^[A-Z]{60}$/;

export async function cryptoSmoke(): Promise<CryptoSmokeResult> {
  const seed = "a".repeat(55); // valid format: 55 lowercase letters
  const { identity, publicKeyHex } = await deriveIdentity(seed);
  const ok = VALID_IDENTITY.test(identity);
  return {
    ok,
    identity,
    publicKeyHex,
    note: ok
      ? "wasm crypto (K12 + FourQ) ran and produced a valid identity"
      : `unexpected identity format: ${identity}`,
  };
}
