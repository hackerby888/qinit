// Qubic peer-protocol codec — the pure, framework-free wire layer for the TCP bridge (peer-server.ts).
// Mirrors core-lite src/network_messages/{header.h, network_message_type.h, entity.h, tick.h, contract.h,
// system_info.h}. Every packet is an 8-byte RequestResponseHeader (size[3] LE | type | dejavu[4]) followed by
// a typed payload, where `size` counts the header too. Response struct sizes follow the Qubic protocol
// (SPECTRUM_DEPTH 24, NUMBER_OF_TRANSACTIONS_PER_TICK 4096, NUMBER_OF_COMPUTORS 676) — a client zero-pads short
// payloads to its struct size but matches strictly on `type`, so we emit the meaningful field prefix.
import {
  M256i, RequestResponseHeader, ASSET_TYPE, SPECTRUM_DEPTH, ASSETS_DEPTH, TXS_PER_TICK,
  RequestTickData, RequestContractFunction, RespondCurrentTickInfo, RespondSystemInfo, RespondEntity,
  RespondOwnedAssets, RespondPossessedAssets, RespondTxStatusHeader,
} from "./wire";

export { SPECTRUM_DEPTH, ASSETS_DEPTH, TXS_PER_TICK };
export const HEADER_SIZE = RequestResponseHeader.SIZE; // 8 — network_messages/header.h
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

  const h = RequestResponseHeader.wrap(buf, off);
  return { size: h.size === 0 ? 0x7fffffff : h.size, type: h.type, dejavu: h.dejavu };
}

// Frame a response: 8-byte header (size = 8 + payload, the response `type`, echoed dejavu) + payload.
export function frame(type: number, payload: Uint8Array, dejavu: number): Uint8Array {
  const size = HEADER_SIZE + payload.length;
  const out = new Uint8Array(size);
  const h = RequestResponseHeader.wrap(out);
  h.size = size;
  h.type = type;
  h.dejavu = dejavu;
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

// RequestContractFunction (contract.h): the 8-byte header then input[inputSize].
export function decodeContractFunction(p: Uint8Array): ContractFunctionRequest {
  const r = RequestContractFunction.wrap(p);
  const input = p.subarray(RequestContractFunction.SIZE, RequestContractFunction.SIZE + r.inputSize);
  return { contractIndex: r.contractIndex, inputType: r.inputType, inputSize: r.inputSize, input };
}

// A 4-byte little-endian tick (RequestedTickData / RequestTxStatus / RequestedQuorumTick prefix).
export function decodeTick(p: Uint8Array): number {
  return RequestTickData.wrap(p).tick;
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

// RespondEntity (entity.h): EntityRecord(64) + tick(4) + spectrumIndex(4) + siblings[SPECTRUM_DEPTH*32]. The
// siblings are the merkle proof — a client recomputes the spectrum root from (EntityRecord, spectrumIndex,
// siblings) and checks it against the quorum-committed spectrumDigest.
export function encodeRespondEntity(id: Uint8Array, e: EntityFields, tick: number, spectrumIndex: number, siblings: Uint8Array[] = []): Uint8Array {
  const r = RespondEntity.alloc();

  const rec = r.entity;
  rec.publicKey = M256i.from(id);
  rec.incomingAmount = e.incomingAmount;
  rec.outgoingAmount = e.outgoingAmount;
  rec.numberOfIncomingTransfers = e.numberOfIncomingTransfers;
  rec.numberOfOutgoingTransfers = e.numberOfOutgoingTransfers;
  rec.latestIncomingTransferTick = e.latestIncomingTransferTick;
  rec.latestOutgoingTransferTick = e.latestOutgoingTransferTick;

  r.tick = tick;
  r.spectrumIndex = spectrumIndex;
  for (let i = 0; i < siblings.length && i < SPECTRUM_DEPTH; i++) {
    r.siblings.set(i, siblings[i]);
  }
  return r.bytes;
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
  const r = RespondCurrentTickInfo.alloc();
  r.tickDuration = t.tickDuration;
  r.epoch = t.epoch;
  r.tick = t.tick;
  r.numberOfAlignedVotes = t.numberOfAlignedVotes;
  r.numberOfMisalignedVotes = t.numberOfMisalignedVotes;
  r.initialTick = t.initialTick;
  return r.bytes;
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
  const r = RespondSystemInfo.alloc();
  r.version = s.version;
  r.epoch = s.epoch;
  r.tick = s.tick;
  r.initialTick = s.initialTick;
  r.latestCreatedTick = s.latestCreatedTick;
  r.numberOfEntities = s.numberOfEntities;
  r.numberOfTransactions = s.numberOfTransactions;
  return r.bytes;
}

// RespondTxStatus (the addon): currentTick(4) tick(4) txCount(4) moneyFlew[(TXS_PER_TICK+7)/8] +
// txDigests[txCount*32]. moneyFlew is a per-index bitmask of which txs moved money.
export function encodeTxStatus(currentTick: number, tick: number, txDigests: Uint8Array[], moneyFlew: boolean[]): Uint8Array {
  const flagBytes = (TXS_PER_TICK + 7) >> 3;
  const buf = new Uint8Array(RespondTxStatusHeader.SIZE + flagBytes + txDigests.length * 32);
  const h = RespondTxStatusHeader.wrap(buf);
  h.currentTick = currentTick;
  h.tick = tick;
  h.txCount = txDigests.length;

  const flagsOff = RespondTxStatusHeader.SIZE;
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
export function encodeRespondOwnedAssets(v: OwnedAssetView, universeIndex = 0, siblings: Uint8Array[] = []): Uint8Array {
  const r = RespondOwnedAssets.alloc();

  const own = r.asset;
  own.publicKey = v.owner;
  own.type = ASSET_TYPE.OWNERSHIP;
  own.managingContractIndex = v.managingContractIndex;
  own.numberOfShares = v.shares;

  const iss = r.issuanceAsset;
  iss.publicKey = v.issuer;
  iss.type = ASSET_TYPE.ISSUANCE;
  iss.nameString = v.name;
  iss.numberOfDecimalPlaces = v.decimals;

  // tick stays zero; universeIndex + siblings are the ownership-record merkle proof
  r.universeIndex = universeIndex;
  for (let i = 0; i < siblings.length && i < ASSETS_DEPTH; i++) {
    r.siblings.set(i, siblings[i]);
  }
  return r.bytes;
}

export interface PossessedAssetView {
  possessor: Uint8Array; // 32 — the queried account
  owner: Uint8Array; // 32
  issuer: Uint8Array; // 32
  name: string; // up to 7 ASCII
  decimals: number;
  shares: bigint;
  possessionManagingContract: number;
  ownershipManagingContract: number;
}

// RespondPossessedAssets (structs.h) — the possession AssetRecord + the ownership AssetRecord + the issuance
// AssetRecord + tick + universeIndex (siblings[ASSETS_DEPTH] zero-padded by a client). AssetRecord type:
// 1=issuance, 2=ownership, 3=possession. The possession variant's @36 field is the ownershipIndex (left zero).
export function encodeRespondPossessedAssets(v: PossessedAssetView, universeIndex = 0, siblings: Uint8Array[] = []): Uint8Array {
  const r = RespondPossessedAssets.alloc();

  const pos = r.asset;
  pos.publicKey = v.possessor;
  pos.type = ASSET_TYPE.POSSESSION;
  pos.managingContractIndex = v.possessionManagingContract;
  pos.numberOfShares = v.shares;

  const own = r.ownershipAsset;
  own.publicKey = v.owner;
  own.type = ASSET_TYPE.OWNERSHIP;
  own.managingContractIndex = v.ownershipManagingContract;
  own.numberOfShares = v.shares;

  const iss = r.issuanceAsset;
  iss.publicKey = v.issuer;
  iss.type = ASSET_TYPE.ISSUANCE;
  iss.nameString = v.name;
  iss.numberOfDecimalPlaces = v.decimals;

  // tick stays zero; universeIndex + siblings are the possession-record merkle proof
  r.universeIndex = universeIndex;
  for (let i = 0; i < siblings.length && i < ASSETS_DEPTH; i++) {
    r.siblings.set(i, siblings[i]);
  }
  return r.bytes;
}
