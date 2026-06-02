// Wire encodings for the on-chain chunked-upload deploy protocol (DYNAMIC_CONTRACTS.md §2.2).
// These payloads ride lite-range transaction inputTypes to the system destination (dest == 0).
// Little-endian, packed. The core host-side handlers mirror these exact layouts.

// Lite transaction inputTypes (must match the core's processTickTransaction cases).
export const LITE_TX = {
  UPLOAD_BEGIN: 240,
  UPLOAD_CHUNK: 241,
  DEPLOY: 242,
} as const;

// MAX_INPUT_SIZE is 1024; UploadChunk header is 14 bytes -> 1008 data bytes/chunk.
export const CHUNK_DATA_MAX = 1008;

function hexToBytes(hex: string, len: number): Uint8Array {
  if (hex.length !== len * 2) throw new Error(`expected ${len}-byte hex, got ${hex.length / 2}`);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export interface UploadBeginParams {
  sessionId: bigint;
  totalSize: number;
  chunkCount: number;
  finalHashHex: string; // 32-byte K12, hex
}

// sessionId(8) totalSize(4) chunkCount(4) finalHash(32) = 48
export function encodeUploadBegin(p: UploadBeginParams): Uint8Array {
  const b = new Uint8Array(48);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, p.sessionId, true);
  v.setUint32(8, p.totalSize, true);
  v.setUint32(12, p.chunkCount, true);
  b.set(hexToBytes(p.finalHashHex, 32), 16);
  return b;
}

export interface UploadChunkParams {
  sessionId: bigint;
  seq: number;
  bytes: Uint8Array; // <= CHUNK_DATA_MAX
}

// sessionId(8) seq(4) len(2) bytes(len) ; header = 14
export function encodeUploadChunk(p: UploadChunkParams): Uint8Array {
  if (p.bytes.length > CHUNK_DATA_MAX) throw new Error("chunk too large");
  const b = new Uint8Array(14 + p.bytes.length);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, p.sessionId, true);
  v.setUint32(8, p.seq, true);
  v.setUint16(12, p.bytes.length, true);
  b.set(p.bytes, 14);
  return b;
}

export interface DeployParams {
  sessionId: bigint;
  targetSlot: number;
  finalHashHex: string;
  abiVersion?: number;
  stateLayoutVersion?: number;
}

// sessionId(8) targetSlot(4) finalHash(32) abiVersion(4) stateLayoutVersion(4) = 52
export function encodeDeploy(p: DeployParams): Uint8Array {
  const b = new Uint8Array(52);
  const v = new DataView(b.buffer);
  v.setBigUint64(0, p.sessionId, true);
  v.setUint32(8, p.targetSlot, true);
  b.set(hexToBytes(p.finalHashHex, 32), 12);
  v.setUint32(44, p.abiVersion ?? 1, true);
  v.setUint32(48, p.stateLayoutVersion ?? 0, true);
  return b;
}

export function chunkSo(bytes: Uint8Array, size = CHUNK_DATA_MAX): Uint8Array[] {
  const chunks: Uint8Array[] = [];
  for (let off = 0; off < bytes.length; off += size) chunks.push(bytes.subarray(off, off + size));
  return chunks;
}

export function newSessionId(): bigint {
  const r = new Uint8Array(8);
  crypto.getRandomValues(r);
  return new DataView(r.buffer).getBigUint64(0, true);
}
