// Shared test helpers.

// The 32-byte id of a contract at `slot` — id(slot, 0, 0, 0): the slot as a little-endian uint64 in a zeroed id.
export function contractId(slot: number): Uint8Array {
  const a = new Uint8Array(32);
  new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
  return a;
}
