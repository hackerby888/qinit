// Contract IDs store the slot in the first little-endian uint64.
export function contractId(slot: number): Uint8Array {
  const id = new Uint8Array(32);
  new DataView(id.buffer).setBigUint64(0, BigInt(slot), true);
  return id;
}

export function readUint64LE(bytes: Uint8Array, offset = 0): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

export function readInt64LE(bytes: Uint8Array, offset = 0): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigInt64(offset, true);
}

export function readInt32LE(bytes: Uint8Array, offset = 0): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(offset, true);
}
