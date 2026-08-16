// Qubic peer-protocol codec — the pure, framework-free wire layer for the TCP bridge (peer-server.ts).
// Mirrors core-lite src/network_messages/{header.h, network_message_type.h, entity.h, tick.h, contract.h}.
import {
    M256i,
    RequestResponseHeader,
    ASSET_TYPE,
    ASSET_RECORD_SIZE,
    SPECTRUM_DEPTH,
    ASSETS_DEPTH,
    TXS_PER_TICK,
    RequestTickData,
    RequestContractFunction,
    RespondCurrentTickInfo,
    RespondSystemInfo,
    RespondEntity,
    RespondOwnedAssets,
    RespondPossessedAssets,
    RespondTxStatusHeader,
} from "./wire";
import { MAINNET_COMPUTOR_COUNT } from "@qinit/proto";
import type { Id } from "../support/bytes";

export { SPECTRUM_DEPTH, ASSETS_DEPTH, TXS_PER_TICK };
export const HEADER_SIZE = RequestResponseHeader.SIZE; // 8 — network_messages/header.h
export const CLI_NUMBER_OF_COMPUTORS = MAINNET_COMPUTOR_COUNT;
export const QUORUM_VOTE_FLAGS_SIZE = Math.ceil(CLI_NUMBER_OF_COMPUTORS / 8);
// Core sends sizeof(RequestQuorumTick), including three bytes of tail padding.
export const REQUEST_QUORUM_TICK_SIZE = (RequestTickData.SIZE + QUORUM_VOTE_FLAGS_SIZE + 3) & ~3;
export const TICK_TRANSACTION_FLAGS_SIZE = TXS_PER_TICK / 8;
export const REQUEST_TICK_TRANSACTIONS_SIZE = RequestTickData.SIZE + TICK_TRANSACTION_FLAGS_SIZE;
const REQUEST_ASSETS_BY_INDEX_SIZE = 8;
const REQUEST_ASSETS_FILTER_SIZE = 112;
const RESPOND_ASSETS_SIZE = ASSET_RECORD_SIZE + 8;

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
    REQUEST_LOG: 44,
    RESPOND_LOG: 45,
    REQUEST_SYSTEM_INFO: 46,
    RESPOND_SYSTEM_INFO: 47,
    REQUEST_LOG_ID_RANGE_FROM_TX: 48,
    RESPOND_LOG_ID_RANGE_FROM_TX: 49,
    REQUEST_ALL_LOG_ID_RANGES_FROM_TX: 50,
    RESPOND_ALL_LOG_ID_RANGES_FROM_TX: 51,
    REQUEST_ASSETS: 52,
    RESPOND_ASSETS: 53,
    REQUEST_PRUNING_LOG: 56,
    RESPOND_PRUNING_LOG: 57,
    REQUEST_LOG_STATE_DIGEST: 58,
    RESPOND_LOG_STATE_DIGEST: 59,
    REQUEST_TX_STATUS: 201,
    RESPOND_TX_STATUS: 202,
    PROCESS_SPECIAL_COMMAND: 255,
} as const;

export interface PeerMessageHeader {
    size: number; // total message size incl. header
    type: number;
    dejavu: number;
}

// Read the 8-byte header at `off`. Returns null if fewer than 8 bytes are buffered.
export function readHeader(buf: Uint8Array, off = 0): PeerMessageHeader | null {
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
    return {
        contractIndex: r.contractIndex,
        inputType: r.inputType,
        inputSize: r.inputSize,
        input,
    };
}

export const ASSET_REQUEST_FLAG = {
    GET_SIBLINGS: 1 << 0,
    ANY_ISSUER: 1 << 1,
    ANY_ASSET_NAME: 1 << 2,
    ANY_OWNER: 1 << 3,
    ANY_OWNERSHIP_MANAGING_CONTRACT: 1 << 4,
    ANY_POSSESSOR: 1 << 5,
    ANY_POSSESSION_MANAGING_CONTRACT: 1 << 6,
} as const;

export type AssetsRequest =
    | {
          kind: "issuance";
          includeSiblings: boolean;
          issuer?: Id;
          name?: bigint;
      }
    | {
          kind: "ownership";
          includeSiblings: boolean;
          issuer: Id;
          name: bigint;
          owner?: Id;
          ownershipManagingContractIndex?: number;
      }
    | {
          kind: "possession";
          includeSiblings: boolean;
          issuer: Id;
          name: bigint;
          owner?: Id;
          possessor?: Id;
          ownershipManagingContractIndex?: number;
          possessionManagingContractIndex?: number;
      }
    | {
          kind: "index";
          includeSiblings: boolean;
          universeIndex: number;
      };

export function decodeAssetsRequest(p: Uint8Array): AssetsRequest | null {
    if (p.length < REQUEST_ASSETS_BY_INDEX_SIZE || p.length > REQUEST_ASSETS_FILTER_SIZE) {
        return null;
    }

    const data = new DataView(p.buffer, p.byteOffset, p.byteLength);
    const requestType = data.getUint16(0, true);
    const flags = data.getUint16(2, true);
    const includeSiblings = (flags & ASSET_REQUEST_FLAG.GET_SIBLINGS) !== 0;

    if (requestType === 3) {
        return {
            kind: "index",
            includeSiblings,
            universeIndex: data.getUint32(4, true),
        };
    }
    if (p.length !== REQUEST_ASSETS_FILTER_SIZE || requestType > 2) {
        return null;
    }

    const issuer = p.subarray(8, 40);
    const name = data.getBigUint64(40, true);
    const owner = p.subarray(48, 80);
    const possessor = p.subarray(80, 112);

    if (requestType === 0) {
        return {
            kind: "issuance",
            includeSiblings,
            issuer: (flags & ASSET_REQUEST_FLAG.ANY_ISSUER) !== 0 ? undefined : issuer,
            name: (flags & ASSET_REQUEST_FLAG.ANY_ASSET_NAME) !== 0 ? undefined : name,
        };
    }

    const ownershipManagingContractIndex = data.getUint16(4, true);
    const ownershipRequest = {
        includeSiblings,
        issuer,
        name,
        owner: (flags & ASSET_REQUEST_FLAG.ANY_OWNER) !== 0 ? undefined : owner,
        ownershipManagingContractIndex: (flags & ASSET_REQUEST_FLAG.ANY_OWNERSHIP_MANAGING_CONTRACT) !== 0 ? undefined : ownershipManagingContractIndex,
    };

    if (requestType === 1) {
        return { kind: "ownership", ...ownershipRequest };
    }

    return {
        kind: "possession",
        includeSiblings,
        issuer,
        name,
        owner: ownershipRequest.owner,
        possessor: (flags & ASSET_REQUEST_FLAG.ANY_POSSESSOR) !== 0 ? undefined : possessor,
        ownershipManagingContractIndex: ownershipRequest.ownershipManagingContractIndex,
        possessionManagingContractIndex: (flags & ASSET_REQUEST_FLAG.ANY_POSSESSION_MANAGING_CONTRACT) !== 0 ? undefined : data.getUint16(6, true),
    };
}

// A 4-byte little-endian tick (RequestedTickData / RequestTxStatus / RequestedQuorumTick prefix).
export function decodeTick(p: Uint8Array): number {
    return RequestTickData.wrap(p).tick;
}

export interface QuorumTickRequest {
    tick: number;
    voteFlags: Uint8Array;
}

export function decodeQuorumTickRequest(p: Uint8Array): QuorumTickRequest | null {
    if (p.length !== REQUEST_QUORUM_TICK_SIZE) {
        return null;
    }

    return {
        tick: decodeTick(p),
        voteFlags: p.subarray(RequestTickData.SIZE, RequestTickData.SIZE + QUORUM_VOTE_FLAGS_SIZE),
    };
}

export interface TickTransactionsRequest {
    tick: number;
    transactionFlags: Uint8Array;
}

export function decodeTickTransactionsRequest(p: Uint8Array): TickTransactionsRequest | null {
    if (p.length !== REQUEST_TICK_TRANSACTIONS_SIZE) {
        return null;
    }

    return {
        tick: decodeTick(p),
        transactionFlags: p.subarray(RequestTickData.SIZE),
    };
}

export function hasZeroLogPasscode(p: Uint8Array): boolean {
    if (p.length < 32) return false;
    for (let i = 0; i < 32; i++) {
        if (p[i] !== 0) return false;
    }
    return true;
}

export function decodeRequestLog(p: Uint8Array): { from: bigint; to: bigint } | null {
    if (p.length !== 48 || !hasZeroLogPasscode(p)) return null;
    const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
    return { from: d.getBigUint64(32, true), to: d.getBigUint64(40, true) };
}

export function decodeLogRangeRequest(p: Uint8Array): { tick: number; txId: number } | null {
    if (p.length !== 40 || !hasZeroLogPasscode(p)) return null;
    const d = new DataView(p.buffer, p.byteOffset, p.byteLength);
    return { tick: d.getUint32(32, true), txId: d.getUint32(36, true) };
}

export function decodeAllLogRangesRequest(p: Uint8Array): number | null {
    // The C++ struct is 40 bytes on the supported ABI: 32-byte passcode + tick + 4 bytes tail padding.
    if ((p.length !== 36 && p.length !== 40) || !hasZeroLogPasscode(p)) return null;
    return new DataView(p.buffer, p.byteOffset, p.byteLength).getUint32(32, true);
}

export function decodePruneLogRequest(p: Uint8Array): { from: bigint; to: bigint } | null {
    return decodeRequestLog(p);
}

export function decodeLogDigestRequest(p: Uint8Array): number | null {
    return decodeAllLogRangesRequest(p);
}

export function encodeLogRange(fromLogId: bigint, length: bigint): Uint8Array {
    const out = new Uint8Array(16);
    const d = new DataView(out.buffer);
    d.setBigInt64(0, fromLogId, true);
    d.setBigInt64(8, length, true);
    return out;
}

export function encodeAllLogRanges(ranges: ReadonlyArray<{ fromLogId: bigint; length: bigint }>): Uint8Array {
    const out = new Uint8Array(ranges.length * 16);
    const d = new DataView(out.buffer);
    for (let i = 0; i < ranges.length; i++) {
        d.setBigInt64(i * 8, ranges[i].fromLogId, true);
        d.setBigInt64((ranges.length + i) * 8, ranges[i].length, true);
    }
    return out;
}

export function encodePruneResult(result: number): Uint8Array {
    const out = new Uint8Array(8);
    new DataView(out.buffer).setBigInt64(0, BigInt(result), true);
    return out;
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
// siblings are the merkle proof; a client recomputes the spectrum root from EntityRecord and spectrumIndex.
export function encodeRespondEntity(id: Id, e: EntityFields, tick: number, spectrumIndex: number, siblings: Uint8Array[] = []): Uint8Array {
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
    owner: Id; // 32 — the queried account
    issuer: Id; // 32
    name: string; // up to 7 ASCII (A-Z, digits)
    decimals: number;
    shares: bigint;
    managingContractIndex: number;
    tick?: number;
    issuanceRecord?: Uint8Array;
}

// Encode ownership and issuance records with their universe Merkle proof.
export function encodeRespondOwnedAssets(v: OwnedAssetView, universeIndex = 0, siblings: Uint8Array[] = [], record?: Uint8Array): Uint8Array {
    const r = RespondOwnedAssets.alloc();

    const own = r.asset;
    if (record) {
        // the stored universe record verbatim — a rebuilt one would drop issuanceIndex and break the proof
        own.bytes.set(record.subarray(0, ASSET_RECORD_SIZE));
    } else {
        own.publicKey = v.owner;
        own.type = ASSET_TYPE.OWNERSHIP;
        own.managingContractIndex = v.managingContractIndex;
        own.numberOfShares = v.shares;
    }

    const iss = r.issuanceAsset;
    if (v.issuanceRecord) {
        iss.bytes.set(v.issuanceRecord.subarray(0, ASSET_RECORD_SIZE));
    } else {
        iss.publicKey = v.issuer;
        iss.type = ASSET_TYPE.ISSUANCE;
        iss.nameString = v.name;
        iss.numberOfDecimalPlaces = v.decimals;
    }

    r.tick = v.tick ?? 0;
    r.universeIndex = universeIndex;
    for (let i = 0; i < siblings.length && i < ASSETS_DEPTH; i++) {
        r.siblings.set(i, siblings[i]);
    }
    return r.bytes;
}

export interface PossessedAssetView {
    possessor: Id; // 32 — the queried account
    owner: Id; // 32
    issuer: Id; // 32
    name: string; // up to 7 ASCII
    decimals: number;
    shares: bigint;
    possessionManagingContract: number;
    ownershipManagingContract: number;
    tick?: number;
    ownershipRecord?: Uint8Array;
    issuanceRecord?: Uint8Array;
}

// Encode possession, ownership, and issuance records with their universe Merkle proof.
export function encodeRespondPossessedAssets(v: PossessedAssetView, universeIndex = 0, siblings: Uint8Array[] = [], record?: Uint8Array): Uint8Array {
    const r = RespondPossessedAssets.alloc();

    const pos = r.asset;
    if (record) {
        // the stored universe record verbatim — a rebuilt one would drop ownershipIndex and break the proof
        pos.bytes.set(record.subarray(0, ASSET_RECORD_SIZE));
    } else {
        pos.publicKey = v.possessor;
        pos.type = ASSET_TYPE.POSSESSION;
        pos.managingContractIndex = v.possessionManagingContract;
        pos.numberOfShares = v.shares;
    }

    const own = r.ownershipAsset;
    if (v.ownershipRecord) {
        own.bytes.set(v.ownershipRecord.subarray(0, ASSET_RECORD_SIZE));
    } else {
        own.publicKey = v.owner;
        own.type = ASSET_TYPE.OWNERSHIP;
        own.managingContractIndex = v.ownershipManagingContract;
        own.numberOfShares = v.shares;
    }

    const iss = r.issuanceAsset;
    if (v.issuanceRecord) {
        iss.bytes.set(v.issuanceRecord.subarray(0, ASSET_RECORD_SIZE));
    } else {
        iss.publicKey = v.issuer;
        iss.type = ASSET_TYPE.ISSUANCE;
        iss.nameString = v.name;
        iss.numberOfDecimalPlaces = v.decimals;
    }

    r.tick = v.tick ?? 0;
    r.universeIndex = universeIndex;
    for (let i = 0; i < siblings.length && i < ASSETS_DEPTH; i++) {
        r.siblings.set(i, siblings[i]);
    }
    return r.bytes;
}

export interface AssetRecordResponse {
    record: Uint8Array;
    tick: number;
    universeIndex: number;
    siblings?: Uint8Array[];
}

export function encodeRespondAssets(v: AssetRecordResponse): Uint8Array {
    const withSiblings = v.siblings !== undefined;
    const out = new Uint8Array(RESPOND_ASSETS_SIZE + (withSiblings ? ASSETS_DEPTH * 32 : 0));
    out.set(v.record.subarray(0, ASSET_RECORD_SIZE));

    const data = new DataView(out.buffer);
    data.setUint32(ASSET_RECORD_SIZE, v.tick, true);
    data.setUint32(ASSET_RECORD_SIZE + 4, v.universeIndex, true);

    if (v.siblings) {
        for (let index = 0; index < v.siblings.length && index < ASSETS_DEPTH; index++) {
            out.set(v.siblings[index].subarray(0, 32), RESPOND_ASSETS_SIZE + index * 32);
        }
    }

    return out;
}
