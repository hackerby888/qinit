// Typed views over the Qubic wire structures — the TS mirror of core-lite src/network_messages/* (+ the m256i
// from platform/m256.h). Layout is not hand-written: a struct is declared as a list of primitive codecs and
import { toHex } from "./k12";
import {
  type Codec,
  u8,
  u16,
  u24,
  u32,
  i16,
  i32,
  i64,
  u64,
  blob,
  array,
  sub,
  roundUp,
  View,
  defineStruct,
} from "@qinit/core";

export const DIGEST_SIZE = 32; // m256i
export const SIG_SIZE = 64; // signature
export const TXS_PER_TICK = 4096; // NUMBER_OF_TRANSACTIONS_PER_TICK (common_def.h; must be 2^N)
export const CONTRACT_FEES_COUNT = 1024; // TickData.contractFees[MAX_NUMBER_OF_CONTRACTS]
export const SPECTRUM_DEPTH = 24; // common_def.h — spectrum merkle depth
export const ASSETS_DEPTH = 24; // common_def.h — universe merkle depth
export const ASSET_RECORD_SIZE = 48; // assets.h AssetRecord (union)

export const ASSET_TYPE = { ISSUANCE: 1, OWNERSHIP: 2, POSSESSION: 3 } as const;

// ---- m256i (platform/m256.h): a 32-byte value (union of int*_t arrays, alignment 8), used for every public
// key / digest / timelock. Kept hand-written — it is a primitive, not a composed struct. ----
export class M256i {
  readonly bytes: Uint8Array; // a 32-byte window into the backing buffer (zero-copy)

  constructor(buf: Uint8Array, off = 0) {
    this.bytes = buf.subarray(off, off + DIGEST_SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): M256i {
    return new M256i(buf, off);
  }

  static alloc(): M256i {
    return new M256i(new Uint8Array(DIGEST_SIZE));
  }

  static zero(): M256i {
    return M256i.alloc();
  }

  static from(v: Uint8Array | string): M256i {
    const m = M256i.alloc();
    if (typeof v === "string") {
      for (let i = 0; i < DIGEST_SIZE; i++) {
        m.bytes[i] = parseInt(v.substr(i * 2, 2), 16);
      }
    } else {
      m.bytes.set(v.subarray(0, DIGEST_SIZE));
    }
    return m;
  }

  // the four 64-bit lanes (e.g. lane 0 holds a contract id / the spectrum-index low word)
  u64(lane: number): bigint {
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, DIGEST_SIZE).getBigUint64(
      lane * 8,
      true,
    );
  }

  setU64(lane: number, v: bigint): void {
    new DataView(this.bytes.buffer, this.bytes.byteOffset, DIGEST_SIZE).setBigUint64(
      lane * 8,
      v,
      true,
    );
  }

  set(v: M256i | Uint8Array): void {
    this.bytes.set((v instanceof M256i ? v.bytes : v).subarray(0, DIGEST_SIZE));
  }

  isZero(): boolean {
    return this.bytes.every((b) => b === 0);
  }

  equals(other: M256i | Uint8Array): boolean {
    const o = other instanceof M256i ? other.bytes : other;
    return o.length >= DIGEST_SIZE && this.bytes.every((b, i) => b === o[i]);
  }

  get hex(): string {
    return toHex(this.bytes);
  }
}

// ---- m256i codec: the one struct primitive that stays here, since it wraps the M256i value defined above. The
// generic codec kit (u8…u64, blob, array, sub, View, defineStruct) lives in struct.ts and is shared with abi.ts. ----
const m256: Codec<M256i> = {
  size: DIGEST_SIZE,
  align: 8,
  read(v, o) {
    return new M256i(v.bytes, o);
  },
  write(v, o, val) {
    const src = val instanceof M256i ? val.bytes : (val as unknown as Uint8Array);
    v.bytes.set(src.subarray(0, DIGEST_SIZE), o);
  },
};

// ---- RequestResponseHeader (network_messages/header.h): 8 bytes; size is a 3-byte LE field. ----
export const RequestResponseHeader = defineStruct("RequestResponseHeader", {
  size: u24,
  type: u8,
  dejavu: u32,
});
export type RequestResponseHeader = InstanceType<typeof RequestResponseHeader>;

// ---- EntityRecord (network_messages/entity.h): 64 bytes; the spectrum merkle leaf. ----
export const EntityRecord = defineStruct("EntityRecord", {
  publicKey: m256,
  incomingAmount: i64,
  outgoingAmount: i64,
  numberOfIncomingTransfers: u32,
  numberOfOutgoingTransfers: u32,
  latestIncomingTransferTick: u32,
  latestOutgoingTransferTick: u32,
});
export type EntityRecord = InstanceType<typeof EntityRecord>;

// ---- Tick (network_messages/tick.h): the 352-byte computor vote. ----
export const Tick = defineStruct("Tick", {
  computorIndex: u16,
  epoch: u16,
  tick: u32,
  millisecond: u16,
  second: u8,
  minute: u8,
  hour: u8,
  day: u8,
  month: u8,
  year: u8,
  prevResourceTestingDigest: u32,
  saltedResourceTestingDigest: u32,
  prevTransactionBodyDigest: u32,
  saltedTransactionBodyDigest: u32,
  prevSpectrumDigest: m256,
  prevUniverseDigest: m256,
  prevComputerDigest: m256,
  saltedSpectrumDigest: m256,
  saltedUniverseDigest: m256,
  saltedComputerDigest: m256,
  transactionDigest: m256,
  expectedNextTickTransactionDigest: m256,
  signature: blob(SIG_SIZE),
});
export type Tick = InstanceType<typeof Tick>;

// ---- TickData (network_messages/tick.h; BROADCAST_FUTURE_TICK_DATA): the 139376-byte leader proposal.
// transactionDigests[NUMBER_OF_TRANSACTIONS_PER_TICK] then contractFees[MAX_NUMBER_OF_CONTRACTS] then signature.
const TickDataBase = defineStruct("TickData", {
  computorIndex: u16,
  epoch: u16,
  tick: u32,
  millisecond: u16,
  second: u8,
  minute: u8,
  hour: u8,
  day: u8,
  month: u8,
  year: u8,
  timelock: m256,
  txDigests: array(m256, TXS_PER_TICK),
  contractFees: array(i64, CONTRACT_FEES_COUNT),
  signature: blob(SIG_SIZE),
});

// SIG_OFFSET is the start of the leader signature (the body hashed for the tick-data sig) — derived, not typed.
export const TickData = TickDataBase as typeof TickDataBase & { readonly SIG_OFFSET: number };
(TickData as { SIG_OFFSET: number }).SIG_OFFSET = TickDataBase.OFFSETS.signature;
export type TickData = InstanceType<typeof TickData>;
export const TICKDATA_SIZE = TickData.SIZE; // 139376

// ---- Transaction (network_messages/transactions.h): an 80-byte header then input[inputSize] then signature[64].
const TransactionHeader = defineStruct("TransactionHeader", {
  sourcePublicKey: m256,
  destinationPublicKey: m256,
  amount: i64,
  tick: u32,
  inputType: u16,
  inputSize: u16,
});

// Wraps the whole serialized tx; the header fields delegate to a TransactionHeader view, and .input / .signature
// are computed from inputSize + the buffer length (mirroring C++ inputPtr() / signaturePtr()).
export class Transaction {
  static readonly HEADER_SIZE = TransactionHeader.SIZE;

  readonly bytes: Uint8Array;
  private readonly header: InstanceType<typeof TransactionHeader>;

  constructor(buf: Uint8Array, off = 0) {
    this.bytes = buf.subarray(off);
    this.header = TransactionHeader.wrap(this.bytes);
  }

  static wrap(buf: Uint8Array, off = 0): Transaction {
    return new Transaction(buf, off);
  }

  get sourcePublicKey(): M256i {
    return this.header.sourcePublicKey;
  }
  set sourcePublicKey(v: M256i | Uint8Array) {
    this.header.sourcePublicKey = v as M256i;
  }
  get destinationPublicKey(): M256i {
    return this.header.destinationPublicKey;
  }
  set destinationPublicKey(v: M256i | Uint8Array) {
    this.header.destinationPublicKey = v as M256i;
  }
  get amount(): bigint {
    return this.header.amount;
  }
  set amount(v: bigint) {
    this.header.amount = v;
  }
  get tick(): number {
    return this.header.tick;
  }
  set tick(v: number) {
    this.header.tick = v;
  }
  get inputType(): number {
    return this.header.inputType;
  }
  set inputType(v: number) {
    this.header.inputType = v;
  }
  get inputSize(): number {
    return this.header.inputSize;
  }
  set inputSize(v: number) {
    this.header.inputSize = v;
  }

  get input(): Uint8Array {
    return this.bytes.subarray(Transaction.HEADER_SIZE, Transaction.HEADER_SIZE + this.inputSize);
  }
  get signature(): Uint8Array {
    const start = Transaction.HEADER_SIZE + this.inputSize;
    return this.bytes.subarray(start, start + SIG_SIZE);
  }
}

// ---- AssetRecord (network_messages/assets.h): a 48-byte union of issuance / ownership / possession. The caller
// reads the variant fields matching `type`. Variant offsets are derived from the same alignment cursor as the
const assetIssuance = layout([
  ["publicKey", DIGEST_SIZE, 8],
  ["type", 1, 1],
  ["name", 7, 1],
  ["numberOfDecimalPlaces", 1, 1],
  ["unitOfMeasurement", 7, 1],
]);
const assetOwnership = layout([
  ["publicKey", DIGEST_SIZE, 8],
  ["type", 1, 1],
  ["managingContractIndex", 2, 2],
  ["index", 4, 4],
  ["numberOfShares", 8, 8],
]);

export class AssetRecord extends View {
  static readonly SIZE = ASSET_RECORD_SIZE;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, AssetRecord.SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): AssetRecord {
    return new AssetRecord(buf, off);
  }

  static alloc(): AssetRecord {
    return new AssetRecord(new Uint8Array(AssetRecord.SIZE));
  }

  get publicKey(): M256i {
    return new M256i(this.bytes, assetOwnership.off.publicKey);
  }
  set publicKey(v: M256i | Uint8Array) {
    this.bytes.set(
      (v instanceof M256i ? v.bytes : v).subarray(0, DIGEST_SIZE),
      assetOwnership.off.publicKey,
    );
  }
  get type(): number {
    return this.dv.getUint8(assetOwnership.off.type);
  }
  set type(v: number) {
    this.dv.setUint8(assetOwnership.off.type, v & 0xff);
  }

  // issuance variant
  get name(): Uint8Array {
    return this.bytes.subarray(assetIssuance.off.name, assetIssuance.off.name + 7);
  }
  get nameString(): string {
    let s = "";
    for (const b of this.name) {
      if (b === 0) {
        break;
      }
      s += String.fromCharCode(b);
    }
    return s;
  }
  set nameString(v: string) {
    const n = this.name;
    n.fill(0);
    for (let i = 0; i < Math.min(v.length, 7); i++) {
      n[i] = v.charCodeAt(i);
    }
  }
  get numberOfDecimalPlaces(): number {
    return this.dv.getUint8(assetIssuance.off.numberOfDecimalPlaces);
  }
  set numberOfDecimalPlaces(v: number) {
    this.dv.setUint8(assetIssuance.off.numberOfDecimalPlaces, v & 0xff);
  }
  get unitOfMeasurement(): Uint8Array {
    return this.bytes.subarray(
      assetIssuance.off.unitOfMeasurement,
      assetIssuance.off.unitOfMeasurement + 7,
    );
  }

  // ownership / possession variants
  get managingContractIndex(): number {
    return this.dv.getUint16(assetOwnership.off.managingContractIndex, true);
  }
  set managingContractIndex(v: number) {
    this.dv.setUint16(assetOwnership.off.managingContractIndex, v & 0xffff, true);
  }
  get issuanceIndex(): number {
    return this.dv.getUint32(assetOwnership.off.index, true);
  }
  set issuanceIndex(v: number) {
    this.dv.setUint32(assetOwnership.off.index, v >>> 0, true);
  }
  get ownershipIndex(): number {
    return this.dv.getUint32(assetOwnership.off.index, true);
  }
  set ownershipIndex(v: number) {
    this.dv.setUint32(assetOwnership.off.index, v >>> 0, true);
  }
  get numberOfShares(): bigint {
    return this.dv.getBigInt64(assetOwnership.off.numberOfShares, true);
  }
  set numberOfShares(v: bigint) {
    this.dv.setBigInt64(assetOwnership.off.numberOfShares, v, true);
  }
}

// Derive a variant's field offsets + size from [name, size, align] triples, emulating the C compiler's
// natural-alignment placement (the same rule defineStruct uses, for the union variants that can't be a struct).
function layout(fields: [string, number, number][]): { off: Record<string, number>; size: number } {
  const off: Record<string, number> = {};

  let cursor = 0;
  let structAlign = 1;
  for (const [key, size, align] of fields) {
    cursor = roundUp(cursor, align);
    off[key] = cursor;
    cursor += size;
    if (align > structAlign) {
      structAlign = align;
    }
  }

  return { off, size: roundUp(cursor, structAlign) };
}

// ---- peer-protocol request/response structs (the bridge layer), mirrored from the same network_messages
// headers. The Respond* structs embed the record views above and carry a merkle-proof sibling tail. ----

// The 4-byte tick prefix shared by the tick-keyed requests (RequestedTickData / RequestTxStatus /
// RequestedQuorumTick all begin with `unsigned int tick`).
export const RequestTickData = defineStruct("RequestTickData", {
  tick: u32,
});
export type RequestTickData = InstanceType<typeof RequestTickData>;

// RequestContractFunction (contract.h): the fixed header before the variable input[inputSize].
export const RequestContractFunction = defineStruct("RequestContractFunction", {
  contractIndex: u32,
  inputType: u16,
  inputSize: u16,
});
export type RequestContractFunction = InstanceType<typeof RequestContractFunction>;

// RespondCurrentTickInfo (tick.h).
export const RespondCurrentTickInfo = defineStruct("RespondCurrentTickInfo", {
  tickDuration: u16,
  epoch: u16,
  tick: u32,
  numberOfAlignedVotes: u16,
  numberOfMisalignedVotes: u16,
  initialTick: u32,
});
export type RespondCurrentTickInfo = InstanceType<typeof RespondCurrentTickInfo>;

// RespondSystemInfo (system_info.h) — #pragma pack(1): no alignment padding (e.g. totalSpectrumAmount sits at
// the unaligned @68), so it is built packed. The engine fills the fields it can back; the rest stay zero.
export const RespondSystemInfo = defineStruct(
  "RespondSystemInfo",
  {
    version: i16,
    epoch: u16,
    tick: u32,
    initialTick: u32,
    latestCreatedTick: u32,
    initialMillisecond: u16,
    initialSecond: u8,
    initialMinute: u8,
    initialHour: u8,
    initialDay: u8,
    initialMonth: u8,
    initialYear: u8,
    numberOfEntities: u32,
    numberOfTransactions: u32,
    randomMiningSeed: m256,
    solutionThreshold: i32,
    totalSpectrumAmount: u64,
    currentEntityBalanceDustThreshold: u64,
    targetTickVoteSignature: u32,
    computorPacketSignature: u64,
    solutionAdditionalThreshold: u64,
    _reserve2: u64,
    _reserve3: u64,
    _reserve4: u64,
  },
  { packed: true },
);
export type RespondSystemInfo = InstanceType<typeof RespondSystemInfo>;

// RespondEntity (entity.h): EntityRecord + tick + spectrumIndex + the spectrum merkle-proof siblings.
export const RespondEntity = defineStruct("RespondEntity", {
  entity: sub(EntityRecord),
  tick: u32,
  spectrumIndex: i32,
  siblings: array(m256, SPECTRUM_DEPTH),
});
export type RespondEntity = InstanceType<typeof RespondEntity>;

// RespondOwnedAssets (assets.h): the ownership AssetRecord + the issuance AssetRecord + tick + universeIndex +
// the universe merkle-proof siblings.
export const RespondOwnedAssets = defineStruct("RespondOwnedAssets", {
  asset: sub(AssetRecord),
  issuanceAsset: sub(AssetRecord),
  tick: u32,
  universeIndex: u32,
  siblings: array(m256, ASSETS_DEPTH),
});
export type RespondOwnedAssets = InstanceType<typeof RespondOwnedAssets>;

// RespondPossessedAssets (assets.h): the possession + ownership + issuance AssetRecords + tick + universeIndex +
// the universe merkle-proof siblings.
export const RespondPossessedAssets = defineStruct("RespondPossessedAssets", {
  asset: sub(AssetRecord),
  ownershipAsset: sub(AssetRecord),
  issuanceAsset: sub(AssetRecord),
  tick: u32,
  universeIndex: u32,
  siblings: array(m256, ASSETS_DEPTH),
});
export type RespondPossessedAssets = InstanceType<typeof RespondPossessedAssets>;

// RespondTxStatus (qinit peer-protocol addon, RESPOND_TX_STATUS): the fixed header before the per-tick
// moneyFlew bitmask[(TXS_PER_TICK+7)/8] and the variable transactionDigests[txCount].
export const RespondTxStatusHeader = defineStruct("RespondTxStatusHeader", {
  currentTick: u32,
  tick: u32,
  txCount: u32,
});
export type RespondTxStatusHeader = InstanceType<typeof RespondTxStatusHeader>;
