// Build and sign Qubic transactions through the library's high-level transaction API.
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction.js";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload.js";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey.js";
import { deriveIdentity } from "./qubic";

// Dedicated lite dynamic-contract deploy address = id(99999,0,0,0) — NOT the core zero
// address (which is reserved for core protocol txs). u64[0]=99999 little-endian.
export const LITE_DEPLOY_ADDRESS = (() => {
  const address = new Uint8Array(32);
  new DataView(address.buffer).setBigUint64(0, 99999n, true);
  return address;
})();

export interface SignedTx {
  bytes: Uint8Array; // broadcast these (getPackageData)
  id: string;
  tick: number;
}

export interface TxInput {
  destination?: string | Uint8Array; // default: system (zero)
  amount?: number;
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

export async function buildSignedTx(seed: string, t: TxInput): Promise<SignedTx> {
  assertSeed(seed);
  if (!Number.isInteger(t.tick) || t.tick <= 0) {
    throw new Error(`invalid tick: ${t.tick}`);
  }
  if (t.amount != null && (!Number.isFinite(t.amount) || t.amount < 0)) {
    throw new Error(`invalid amount: ${t.amount} (must be ≥ 0)`);
  }
  const { identity } = await deriveIdentity(seed);
  const payload = new DynamicPayload(Math.max(1, t.payload.length));
  payload.setPayload(t.payload);
  const transaction = new QubicTransaction();
  transaction
    .setSourcePublicKey(new PublicKey(identity))
    .setDestinationPublicKey(new PublicKey((t.destination ?? LITE_DEPLOY_ADDRESS) as any))
    .setAmount(t.amount ?? 0)
    .setTick(t.tick)
    .setInputType(t.inputType)
    .setInputSize(t.payload.length)
    .setPayload(payload);
  await transaction.build(seed);
  return {
    bytes: transaction.getPackageData(),
    id: transaction.getId(),
    tick: t.tick,
  };
}
