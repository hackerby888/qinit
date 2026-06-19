// Identity + crypto via @qubic-lib/qubic-ts-library.
// NOTE: if this import fails after `bun install`, check the installed package's
// dist layout (node_modules/@qubic-lib/qubic-ts-library/dist) and adjust the path.
// Surfacing exactly this is part of the M0 standalone-binary smoke test.
import { QubicHelper } from "@qubic-lib/qubic-ts-library/dist/qubicHelper";

export interface IdentityResult {
  identity: string;       // 60 uppercase letters
  publicKeyHex: string;
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
// the wasm is initialized.
export async function k12Hex(bytes: Uint8Array): Promise<string> {
  // Static CJS require -> bun bundles + dedups to the SAME crypto instance QubicHelper inits.
  // ESM `import *` / createRequire resolved a second, uninitialized Emscripten instance under --compile.
  // @ts-ignore - require is provided by bun (and bundled at compile time for a literal specifier)
  const cryptoMod: any = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { K12 } = await (cryptoMod.default ?? cryptoMod);
  const out = new Uint8Array(32);
  K12(bytes, out, 32);
  return toHex(out);
}

// Synchronous K12 for callers that hash inside a tight loop or a wasm host import (e.g. the TS SC engine's
// `lh_k12` + state digest), where awaiting per call isn't possible. Resolve the crypto module once via
// initK12(), then hash synchronously against the SAME instance k12Hex uses.
let _k12Sync: ((input: Uint8Array, out: Uint8Array, outLen: number) => void) | null = null;

export async function initK12(): Promise<void> {
  if (_k12Sync) return;
  // @ts-ignore - require is provided by bun (see k12Hex above for the resolution rationale)
  const cryptoMod: any = require("@qubic-lib/qubic-ts-library/dist/crypto");
  const { K12 } = await (cryptoMod.default ?? cryptoMod);
  _k12Sync = K12;
}

export function k12Sync(bytes: Uint8Array): Uint8Array {
  if (!_k12Sync) throw new Error("k12 not initialized — await initK12() first");
  const out = new Uint8Array(32);
  _k12Sync(bytes, out, 32);
  return out;
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
