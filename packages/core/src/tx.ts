// Build + sign a Qubic transaction via @qubic-lib/qubic-ts-library.
// All crypto goes through the lib's high-level QubicTransaction (works in the
// --compile binary, unlike a direct crypto import).
import { QubicTransaction } from "@qubic-lib/qubic-ts-library/dist/qubic-types/QubicTransaction";
import { DynamicPayload } from "@qubic-lib/qubic-ts-library/dist/qubic-types/DynamicPayload";
import { PublicKey } from "@qubic-lib/qubic-ts-library/dist/qubic-types/PublicKey";
import { deriveIdentity } from "./qubic";

// Dedicated lite dynamic-contract deploy address = id(99999,0,0,0) — NOT the core zero
// address (which is reserved for core protocol txs). u64[0]=99999 little-endian.
export const LITE_DEPLOY_ADDRESS = (() => {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, 99999n, true);
  return a;
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

export async function buildSignedTx(seed: string, t: TxInput): Promise<SignedTx> {
  const { identity } = await deriveIdentity(seed);
  const dyn = new DynamicPayload(Math.max(1, t.payload.length));
  dyn.setPayload(t.payload);
  const tx = new QubicTransaction();
  tx.setSourcePublicKey(new PublicKey(identity))
    .setDestinationPublicKey(new PublicKey((t.destination ?? LITE_DEPLOY_ADDRESS) as any))
    .setAmount(t.amount ?? 0)
    .setTick(t.tick)
    .setInputType(t.inputType)
    .setInputSize(t.payload.length)
    .setPayload(dyn);
  await tx.build(seed);
  return { bytes: tx.getPackageData(), id: tx.getId(), tick: t.tick };
}
