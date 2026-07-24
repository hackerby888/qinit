// Wire encodings for the on-chain chunked-upload deploy protocol (DYNAMIC_CONTRACTS.md §2.2).
// These payloads are sent to the reserved LITE_DEPLOY_ADDRESS.

// Lite transaction inputTypes + chunk sizing live in ./protocol (mirrored against core by the drift guard).
import { LITE_TX, CHUNK_DATA_MAX } from "./protocol";
import { WASM_ABI_VERSION, defineStruct, u16, u32, u64, blob } from "@qinit/core";
export { LITE_TX, CHUNK_DATA_MAX };

// Define wire layouts once so the protocol encoder and engine decoder cannot drift.
export const UploadBegin = defineStruct("UploadBegin", {
  sessionId: u64, // @0
  totalSize: u32, // @8
  chunkCount: u32, // @12
  finalHash: blob(32), // @16  (48 bytes total)
});
export const UploadChunkHeader = defineStruct(
  "UploadChunkHeader",
  {
    sessionId: u64, // @0
    seq: u32, // @8
    len: u16, // @12  (14-byte header; the chunk payload follows at SIZE)
  },
  { packed: true },
);
export const DeployMessage = defineStruct(
  "DeployMessage",
  {
    sessionId: u64, // @0
    targetSlot: u32, // @8
    finalHash: blob(32), // @12
    abiVersion: u32, // @44
    stateLayoutVersion: u32, // @48
    name: blob(32), // @52  null-padded contract name (84 bytes total)
  },
  { packed: true },
);

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

export function encodeUploadBegin(p: UploadBeginParams): Uint8Array {
  const m = UploadBegin.alloc();
  m.sessionId = p.sessionId;
  m.totalSize = p.totalSize;
  m.chunkCount = p.chunkCount;
  m.finalHash = hexToBytes(p.finalHashHex, 32);
  return m.bytes;
}

export interface UploadChunkParams {
  sessionId: bigint;
  seq: number;
  bytes: Uint8Array; // <= CHUNK_DATA_MAX
}

export function encodeUploadChunk(p: UploadChunkParams): Uint8Array {
  if (p.bytes.length > CHUNK_DATA_MAX) throw new Error("chunk too large");
  const b = new Uint8Array(UploadChunkHeader.SIZE + p.bytes.length);
  const m = UploadChunkHeader.wrap(b);
  m.sessionId = p.sessionId;
  m.seq = p.seq;
  m.len = p.bytes.length;
  b.set(p.bytes, UploadChunkHeader.SIZE);
  return b;
}

export interface DeployParams {
  sessionId: bigint;
  targetSlot: number;
  finalHashHex: string;
  abiVersion?: number;
  stateLayoutVersion?: number;
  name?: string; // stored on-chain per slot -> tooling resolves name -> slot
}

export function encodeDeploy(p: DeployParams): Uint8Array {
  const m = DeployMessage.alloc();
  m.sessionId = p.sessionId;
  m.targetSlot = p.targetSlot;
  m.finalHash = hexToBytes(p.finalHashHex, 32);
  m.abiVersion = p.abiVersion ?? WASM_ABI_VERSION;
  m.stateLayoutVersion = p.stateLayoutVersion ?? 0;
  const nm = (p.name ?? "").slice(0, 31);
  const name = new Uint8Array(32);
  for (let i = 0; i < nm.length; i++) name[i] = nm.charCodeAt(i) & 0x7f;
  m.name = name;
  return m.bytes;
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
