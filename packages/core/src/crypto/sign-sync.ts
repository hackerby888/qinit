// The last @qubic-lib use: @qubic.org/crypto's schnorrq.sign is sync but unexported (only the async
// wrapper is), and the tick path is sync end to end.
import type { KeyPair } from "./qubic";

interface SchnorrQ {
    sign(subseed: Uint8Array, publicKey: Uint8Array, message: Uint8Array): Uint8Array;
}

let _schnorrq: SchnorrQ | null = null;

export async function initK12(): Promise<void> {
    if (_schnorrq) {
        return;
    }

    // Static CJS require so bun bundles one instance; ESM import resolved a second, uninit one under --compile.
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
