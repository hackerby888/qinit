// Qubic peer-protocol codec — the pure, framework-free wire layer for the TCP bridge (peer-server.ts).
// Mirrors core-lite src/network_messages/{header.h, network_message_type.h, entity.h, tick.h, contract.h,
// system_info.h}. Every packet is an 8-byte RequestResponseHeader (size[3] LE | type | dejavu[4]) followed by
// a typed payload, where `size` counts the header too. Response struct sizes follow the mainnet Qubic protocol
// (SPECTRUM_DEPTH 24, NUMBER_OF_TRANSACTIONS_PER_TICK 1024, NUMBER_OF_COMPUTORS 676) — a client zero-pads short
// payloads to its struct size but matches strictly on `type`, so we emit the meaningful field prefix.
export const HEADER_SIZE = 8;
export const SPECTRUM_DEPTH = 24; // RespondEntity sibling count (mainnet protocol)
export const TXS_PER_TICK = 1024; // NUMBER_OF_TRANSACTIONS_PER_TICK (mainnet protocol)
export const CLI_NUMBER_OF_COMPUTORS = 676; // NUMBER_OF_COMPUTORS — computor-list slot count (mainnet protocol)

// network_message_type.h — only the types the bridge handles.
export const MSG = {
  EXCHANGE_PUBLIC_PEERS: 0,
  BROADCAST_COMPUTORS: 2,
  BROADCAST_TICK: 3,
  BROADCAST_FUTURE_TICK_DATA: 8,
  REQUEST_COMPUTORS: 11,
  REQUEST_QUORUM_TICK: 14,
  REQUEST_TICK_DATA: 16,
  BROADCAST_TRANSACTION: 24,
  REQUEST_TRANSACTION_INFO: 26,
  REQUEST_CURRENT_TICK_INFO: 27,
  RESPOND_CURRENT_TICK_INFO: 28,
  REQUEST_TICK_TRANSACTIONS: 29,
  REQUEST_ENTITY: 31,
  RESPOND_ENTITY: 32,
  END_RESPONSE: 35,
  REQUEST_ISSUED_ASSETS: 36,
  RESPOND_ISSUED_ASSETS: 37,
  REQUEST_OWNED_ASSETS: 38,
  RESPOND_OWNED_ASSETS: 39,
  REQUEST_POSSESSED_ASSETS: 40,
  RESPOND_POSSESSED_ASSETS: 41,
  REQUEST_CONTRACT_FUNCTION: 42,
  RESPOND_CONTRACT_FUNCTION: 43,
  REQUEST_SYSTEM_INFO: 46,
  RESPOND_SYSTEM_INFO: 47,
  REQUEST_TX_STATUS: 201,
  RESPOND_TX_STATUS: 202,
  PROCESS_SPECIAL_COMMAND: 255,
} as const;

export interface Header {
  size: number; // total message size incl. header
  type: number;
  dejavu: number;
}

// Read the 8-byte header at `off`. Returns null if fewer than 8 bytes are buffered.
export function readHeader(buf: Uint8Array, off = 0): Header | null {
  if (buf.length - off < HEADER_SIZE) {
    return null;
  }

  const size = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
  const type = buf[off + 3];
  const dv = new DataView(buf.buffer, buf.byteOffset + off, HEADER_SIZE);
  const dejavu = dv.getUint32(4, true);
  return { size: size === 0 ? 0x7fffffff : size, type, dejavu };
}

// Frame a response: 8-byte header (size = 8 + payload, the response `type`, echoed dejavu) + payload.
export function frame(type: number, payload: Uint8Array, dejavu: number): Uint8Array {
  const size = HEADER_SIZE + payload.length;
  const out = new Uint8Array(size);
  out[0] = size & 0xff;
  out[1] = (size >> 8) & 0xff;
  out[2] = (size >> 16) & 0xff;
  out[3] = type & 0xff;
  new DataView(out.buffer).setUint32(4, dejavu >>> 0, true);
  out.set(payload, HEADER_SIZE);
  return out;
}

// The END_RESPONSE marker that terminates a streamed (vector) response.
export function endResponse(dejavu: number): Uint8Array {
  return frame(MSG.END_RESPONSE, new Uint8Array(0), dejavu);
}

// The ExchangePublicPeers handshake the node sends on connect (4 zero IPv4 peers).
export function exchangePublicPeers(): Uint8Array {
  return frame(MSG.EXCHANGE_PUBLIC_PEERS, new Uint8Array(16), 0);
}

// ---- request decoders ----
export interface ContractFunctionRequest {
  contractIndex: number;
  inputType: number;
  inputSize: number;
  input: Uint8Array;
}

// RequestContractFunction (contract.h): contractIndex(4) + inputType(2) + inputSize(2) + input[inputSize].
export function decodeContractFunction(p: Uint8Array): ContractFunctionRequest {
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const contractIndex = dv.getUint32(0, true);
  const inputType = dv.getUint16(4, true);
  const inputSize = dv.getUint16(6, true);
  return { contractIndex, inputType, inputSize, input: p.subarray(8, 8 + inputSize) };
}

// A 4-byte little-endian tick (RequestedTickData / RequestTxStatus / RequestedQuorumTick prefix).
export function decodeTick(p: Uint8Array): number {
  return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(0, true);
}

// ---- response encoders ----
export interface EntityFields {
  incomingAmount: bigint;
  outgoingAmount: bigint;
  numberOfIncomingTransfers: number;
  numberOfOutgoingTransfers: number;
  latestIncomingTransferTick: number;
  latestOutgoingTransferTick: number;
}

// RespondEntity (entity.h): EntityRecord(64) + tick(4) + spectrumIndex(4) + siblings[SPECTRUM_DEPTH*32].
export function encodeRespondEntity(id: Uint8Array, e: EntityFields, tick: number, spectrumIndex: number): Uint8Array {
  const buf = new Uint8Array(64 + 4 + 4 + SPECTRUM_DEPTH * 32);
  const dv = new DataView(buf.buffer);
  buf.set(id.subarray(0, 32), 0);
  dv.setBigInt64(32, e.incomingAmount, true);
  dv.setBigInt64(40, e.outgoingAmount, true);
  dv.setUint32(48, e.numberOfIncomingTransfers, true);
  dv.setUint32(52, e.numberOfOutgoingTransfers, true);
  dv.setUint32(56, e.latestIncomingTransferTick, true);
  dv.setUint32(60, e.latestOutgoingTransferTick, true);
  dv.setUint32(64, tick >>> 0, true);
  dv.setInt32(68, spectrumIndex, true);
  return buf;
}

export interface TickInfoFields {
  tickDuration: number;
  epoch: number;
  tick: number;
  numberOfAlignedVotes: number;
  numberOfMisalignedVotes: number;
  initialTick: number;
}

// RespondCurrentTickInfo (tick.h): tickDuration(2) epoch(2) tick(4) aligned(2) misaligned(2) initialTick(4).
export function encodeCurrentTickInfo(t: TickInfoFields): Uint8Array {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  dv.setUint16(0, t.tickDuration & 0xffff, true);
  dv.setUint16(2, t.epoch & 0xffff, true);
  dv.setUint32(4, t.tick >>> 0, true);
  dv.setUint16(8, t.numberOfAlignedVotes & 0xffff, true);
  dv.setUint16(10, t.numberOfMisalignedVotes & 0xffff, true);
  dv.setUint32(12, t.initialTick >>> 0, true);
  return buf;
}

export interface SystemInfoFields {
  version: number;
  epoch: number;
  tick: number;
  initialTick: number;
  latestCreatedTick: number;
  numberOfEntities: number;
  numberOfTransactions: number;
}

// RespondSystemInfo (system_info.h) — only the fields the engine can back; the rest stay zero (a client zero-pads).
export function encodeSystemInfo(s: SystemInfoFields): Uint8Array {
  const buf = new Uint8Array(128);
  const dv = new DataView(buf.buffer);
  dv.setInt16(0, s.version, true);
  dv.setUint16(2, s.epoch & 0xffff, true);
  dv.setUint32(4, s.tick >>> 0, true);
  dv.setUint32(8, s.initialTick >>> 0, true);
  dv.setUint32(12, s.latestCreatedTick >>> 0, true);
  dv.setUint32(24, s.numberOfEntities >>> 0, true);
  dv.setUint32(28, s.numberOfTransactions >>> 0, true);
  return buf;
}

// RespondTxStatus (the addon): currentTick(4) tick(4) txCount(4) moneyFlew[(TXS_PER_TICK+7)/8] +
// txDigests[txCount*32]. moneyFlew is a per-index bitmask of which txs moved money.
export function encodeTxStatus(currentTick: number, tick: number, txDigests: Uint8Array[], moneyFlew: boolean[]): Uint8Array {
  const flagBytes = (TXS_PER_TICK + 7) >> 3;
  const buf = new Uint8Array(4 + 4 + 4 + flagBytes + txDigests.length * 32);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, currentTick >>> 0, true);
  dv.setUint32(4, tick >>> 0, true);
  dv.setUint32(8, txDigests.length >>> 0, true);

  const flagsOff = 12;
  for (let i = 0; i < moneyFlew.length; i++) {
    if (moneyFlew[i]) {
      buf[flagsOff + (i >> 3)] |= 1 << (i & 7);
    }
  }

  let off = flagsOff + flagBytes;
  for (const d of txDigests) {
    buf.set(d.subarray(0, 32), off);
    off += 32;
  }
  return buf;
}

export interface OwnedAssetView {
  owner: Uint8Array; // 32 — the queried account
  issuer: Uint8Array; // 32
  name: string; // up to 7 ASCII (A-Z, digits)
  decimals: number;
  shares: bigint;
  managingContractIndex: number;
}

// RespondOwnedAssets (structs.h) — the AssetRecord ownership variant + the issuance AssetRecord + tick +
// universeIndex (siblings[ASSETS_DEPTH] are zero-padded by a client). AssetRecord is a 48-byte union:
// ownership = publicKey(32) type(1) pad(1) managingContractIndex(2) issuanceIndex(4) numberOfShares(8);
// issuance  = publicKey(32) type(1) name(7) numberOfDecimalPlaces(1) unitOfMeasurement(7). type: 1=issuance, 2=ownership.
export function encodeRespondOwnedAssets(v: OwnedAssetView): Uint8Array {
  const buf = new Uint8Array(ASSET_RECORD_SIZE + ASSET_RECORD_SIZE + 4 + 4);
  const dv = new DataView(buf.buffer);

  // [0..48] ownership record
  buf.set(v.owner.subarray(0, 32), 0);
  buf[32] = 2; // ASSET_TYPE_OWNERSHIP
  dv.setUint16(34, v.managingContractIndex & 0xffff, true);
  dv.setBigInt64(40, v.shares, true);

  // [48..96] issuance record
  buf.set(v.issuer.subarray(0, 32), 48);
  buf[48 + 32] = 1; // ASSET_TYPE_ISSUANCE
  for (let i = 0; i < 7 && i < v.name.length; i++) {
    buf[48 + 33 + i] = v.name.charCodeAt(i) & 0xff;
  }
  buf[48 + 40] = v.decimals & 0xff;

  // [96] tick, [100] universeIndex — left zero
  return buf;
}

const ASSET_RECORD_SIZE = 48;

// TickData (tick.h) for BROADCAST_FUTURE_TICK_DATA — computorIndex(2) epoch(2) tick(4) time(8) timelock(32)
// then transactionDigests[TXS_PER_TICK*32]. We fill the metadata + the known tx digests; a client zero-pads.
export function encodeTickData(epoch: number, tick: number, txDigests: Uint8Array[]): Uint8Array {
  const digestsOff = 48; // 2+2+4 + (millisecond 2 + second..year 6) + timelock 32
  const buf = new Uint8Array(digestsOff + txDigests.length * 32);
  const dv = new DataView(buf.buffer);
  dv.setUint16(2, epoch & 0xffff, true);
  dv.setUint32(4, tick >>> 0, true);

  let off = digestsOff;
  for (const d of txDigests) {
    buf.set(d.subarray(0, 32), off);
    off += 32;
  }
  return buf;
}
