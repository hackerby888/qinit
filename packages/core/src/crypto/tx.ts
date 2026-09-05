// Build and sign Qubic transactions through @qubic.org/tx.
import { buildTransaction, computeTransactionHash, signTransaction } from "@qubic.org/tx";
import { deriveIdentity } from "./qubic";

// Reserved Wasm deployment address: id(99999, 0, 0, 0).
export const LITE_DEPLOY_ADDRESS = (() => {
    const address = new Uint8Array(32);
    new DataView(address.buffer).setBigUint64(0, 99999n, true);
    return address;
})();

export interface SignedTx {
    bytes: Uint8Array;
    id: string;
    tick: number;
}

export interface TxInput {
    destination?: string | Uint8Array; // default: LITE_DEPLOY_ADDRESS
    amount?: number | bigint;
    tick: number;
    inputType: number;
    payload: Uint8Array;
}

// A Qubic seed is exactly 55 lowercase letters (a-z). Reject anything else loudly — signing with a malformed
// seed otherwise silently produces a wrong identity / unspendable tx.
export function assertSeed(seed: string): void {
    if (!/^[a-z]{55}$/.test(seed)) {
        throw new Error(`invalid seed: must be 55 lowercase letters a-z (got ${seed.length} char(s))`);
    }
}

// The wire amount is a signed 64-bit integer of qu; a number past 2^53 would already have lost digits.
function wholeAmount(amount: number | bigint | undefined): bigint {
    if (amount == null) {
        return 0n;
    }
    if (typeof amount === "number" && !Number.isSafeInteger(amount)) {
        throw new Error(`invalid amount: ${amount} (must be a whole number below 2^53, or a bigint)`);
    }
    const value = BigInt(amount);
    if (value < 0n || value > 2n ** 63n - 1n) {
        throw new Error(`invalid amount: ${amount} (must be 0..2^63-1)`);
    }
    return value;
}

export async function buildSignedTx(seed: string, t: TxInput): Promise<SignedTx> {
    assertSeed(seed);
    if (!Number.isInteger(t.tick) || t.tick <= 0) {
        throw new Error(`invalid tick: ${t.tick}`);
    }
    const amount = wholeAmount(t.amount);
    const { identity } = await deriveIdentity(seed);
    const unsigned = buildTransaction({
        source: identity as never,
        destination: (t.destination ?? LITE_DEPLOY_ADDRESS) as never,
        amount,
        targetTick: t.tick,
        inputType: t.inputType,
        payload: t.payload,
    });
    const bytes = await signTransaction(unsigned, seed as never);
    return { bytes, id: computeTransactionHash(bytes), tick: t.tick };
}
