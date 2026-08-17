// Identity and hashing through @qubic.org/crypto (pure TypeScript over @noble/hashes).
import { deriveKeys, identityToPublicKey, k12, publicKeyToIdentity, verify } from "@qubic.org/crypto";
import { bytesToHex } from "./bytes";

export interface IdentityResult {
    identity: string; // 60 uppercase letters
    publicKeyHex: string;
}

export interface KeyPair {
    privateKey: Uint8Array; // 32-byte FourQ subseed — what SchnorrQ signs with
    publicKey: Uint8Array; // 32 bytes (FourQ)
}

export interface CryptoSmokeResult {
    ok: boolean;
    identity: string;
    publicKeyHex: string;
    note: string;
}

// KangarooTwelve (KT128, 32-byte digest) matching core content addressing.
export function k12Sync(bytes: Uint8Array): Uint8Array {
    return k12(bytes, 32);
}

export async function k12Hex(bytes: Uint8Array): Promise<string> {
    return bytesToHex(k12Sync(bytes));
}

export function deriveKeysSync(seed: string): KeyPair {
    const { subseed, publicKey } = deriveKeys(seed as never);
    return { privateKey: subseed, publicKey };
}

const isZero = (bytes: Uint8Array): boolean => bytes.every((byte) => byte === 0);

export function verifySync(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
    // @qubic.org/crypto verifies an all-zero signature against an all-zero key; core rejects that pair,
    // and the null identity can never be a signer. Caught by the signatureValidity native differential.
    if (isZero(publicKey) || isZero(signature)) {
        return false;
    }

    return verify(message, signature, publicKey);
}

export async function deriveIdentity(seed: string): Promise<IdentityResult> {
    const { publicKey } = deriveKeys(seed as never);
    return { identity: publicKeyToIdentity(publicKey), publicKeyHex: bytesToHex(publicKey) };
}

// id codec: 60-char identity <-> 32-byte public key (for the contract ABI `id` type).
export async function bytesToIdentity(bytes: Uint8Array): Promise<string> {
    return publicKeyToIdentity(bytes);
}
const NULL_IDENTITY = "A".repeat(60);

export function identityToBytes(identity: string): Uint8Array {
    // The null/burn address is 60 'A's, whose checksum chars are not 'A' — decoding it through the
    // checksum-validating path would throw, so answer it directly.
    if (identity.toUpperCase() === NULL_IDENTITY) {
        return new Uint8Array(32);
    }

    return identityToPublicKey(identity as never);
}

// Identity packs the public key as four 14-char chunks (char = byte % 26 + 'A') plus a 4-char checksum.
// A contract key is m256i(index, 0, 0, 0), so only chunk 0 decodes to the index; 60 'A's is the null address.
export function contractIndexFromIdentity(identity: string): number | null {
    if (identity.length !== 60) return null;
    const upper = identity.toUpperCase();
    for (let i = 14; i < 56; i++) if (upper[i] !== "A") return null;

    let index = 0;
    let multiplier = 1;
    for (let i = 0; i < 14; i++) {
        const value = upper.charCodeAt(i) - 65;
        if (value < 0 || value > 25) return null;
        index += value * multiplier;
        multiplier *= 26;
        if (index > Number.MAX_SAFE_INTEGER) return null;
    }
    return index >= 1 ? index : null;
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
        note: ok ? "K12 + FourQ ran and produced a valid identity" : `unexpected identity format: ${identity}`,
    };
}
