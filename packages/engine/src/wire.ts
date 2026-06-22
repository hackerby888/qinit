// Typed views over the Qubic wire structures — the TS mirror of core-lite src/network_messages/* (+ the m256i
// from common_def.h). Each class wraps a backing Uint8Array and reads/writes its fields in place (zero-copy,
// little-endian), so code operates on td.tick / record.numberOfShares instead of raw DataView offsets. The
// per-struct OFF block is the single source of layout truth; offsets are cited from the C++ struct.
import { toHex } from "./k12";

export const DIGEST_SIZE = 32; // m256i
export const SIG_SIZE = 64; // signature
export const TXS_PER_TICK = 4096; // NUMBER_OF_TRANSACTIONS_PER_TICK (common_def.h; must be 2^N)
export const CONTRACT_FEES_COUNT = 1024; // TickData.contractFees[MAX_NUMBER_OF_CONTRACTS]
export const SPECTRUM_DEPTH = 24; // common_def.h — spectrum merkle depth
export const ASSETS_DEPTH = 24; // common_def.h — universe merkle depth
export const ASSET_RECORD_SIZE = 48; // assets.h AssetRecord (union)

export const ASSET_TYPE = { ISSUANCE: 1, OWNERSHIP: 2, POSSESSION: 3 } as const;

// ---- m256i (common_def.h): a 32-byte value, used for every public key / digest / timelock. ----
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
    return new DataView(this.bytes.buffer, this.bytes.byteOffset, DIGEST_SIZE).getBigUint64(lane * 8, true);
  }

  setU64(lane: number, v: bigint): void {
    new DataView(this.bytes.buffer, this.bytes.byteOffset, DIGEST_SIZE).setBigUint64(lane * 8, v, true);
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

// ---- shared view base: typed little-endian accessors over a fixed window. ----
abstract class View {
  readonly bytes: Uint8Array; // the struct's own SIZE-byte window
  protected readonly dv: DataView;

  protected constructor(buf: Uint8Array, off: number, size: number) {
    this.bytes = buf.subarray(off, off + size);
    this.dv = new DataView(this.bytes.buffer, this.bytes.byteOffset, this.bytes.byteLength);
  }

  protected gU8(o: number): number {
    return this.dv.getUint8(o);
  }
  protected sU8(o: number, v: number): void {
    this.dv.setUint8(o, v & 0xff);
  }
  protected gU16(o: number): number {
    return this.dv.getUint16(o, true);
  }
  protected sU16(o: number, v: number): void {
    this.dv.setUint16(o, v & 0xffff, true);
  }
  protected gU32(o: number): number {
    return this.dv.getUint32(o, true);
  }
  protected sU32(o: number, v: number): void {
    this.dv.setUint32(o, v >>> 0, true);
  }
  protected gI64(o: number): bigint {
    return this.dv.getBigInt64(o, true);
  }
  protected sI64(o: number, v: bigint): void {
    this.dv.setBigInt64(o, v, true);
  }
  protected gBytes(o: number, n: number): Uint8Array {
    return this.bytes.subarray(o, o + n);
  }
  protected sBytes(o: number, v: Uint8Array, n: number): void {
    this.bytes.set(v.subarray(0, n), o);
  }
  protected gM256(o: number): M256i {
    return new M256i(this.bytes, o);
  }
  protected sM256(o: number, v: M256i | Uint8Array): void {
    this.bytes.set((v instanceof M256i ? v.bytes : v).subarray(0, DIGEST_SIZE), o);
  }
}

// ---- RequestResponseHeader (network_messages/header.h): 8 bytes; size is a 3-byte LE field. ----
export class RequestResponseHeader extends View {
  static readonly SIZE = 8;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, RequestResponseHeader.SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): RequestResponseHeader {
    return new RequestResponseHeader(buf, off);
  }

  static alloc(): RequestResponseHeader {
    return new RequestResponseHeader(new Uint8Array(RequestResponseHeader.SIZE));
  }

  get size(): number {
    return this.gU8(0) | (this.gU8(1) << 8) | (this.gU8(2) << 16);
  }
  set size(v: number) {
    this.sU8(0, v & 0xff);
    this.sU8(1, (v >> 8) & 0xff);
    this.sU8(2, (v >> 16) & 0xff);
  }
  get type(): number {
    return this.gU8(3);
  }
  set type(v: number) {
    this.sU8(3, v);
  }
  get dejavu(): number {
    return this.gU32(4);
  }
  set dejavu(v: number) {
    this.sU32(4, v);
  }
}

// ---- EntityRecord (network_messages/entity.h): 64 bytes; the spectrum merkle leaf. ----
export class EntityRecord extends View {
  static readonly SIZE = 64;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, EntityRecord.SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): EntityRecord {
    return new EntityRecord(buf, off);
  }

  static alloc(): EntityRecord {
    return new EntityRecord(new Uint8Array(EntityRecord.SIZE));
  }

  get publicKey(): M256i {
    return this.gM256(0);
  }
  set publicKey(v: M256i | Uint8Array) {
    this.sM256(0, v);
  }
  get incomingAmount(): bigint {
    return this.gI64(32);
  }
  set incomingAmount(v: bigint) {
    this.sI64(32, v);
  }
  get outgoingAmount(): bigint {
    return this.gI64(40);
  }
  set outgoingAmount(v: bigint) {
    this.sI64(40, v);
  }
  get numberOfIncomingTransfers(): number {
    return this.gU32(48);
  }
  set numberOfIncomingTransfers(v: number) {
    this.sU32(48, v);
  }
  get numberOfOutgoingTransfers(): number {
    return this.gU32(52);
  }
  set numberOfOutgoingTransfers(v: number) {
    this.sU32(52, v);
  }
  get latestIncomingTransferTick(): number {
    return this.gU32(56);
  }
  set latestIncomingTransferTick(v: number) {
    this.sU32(56, v);
  }
  get latestOutgoingTransferTick(): number {
    return this.gU32(60);
  }
  set latestOutgoingTransferTick(v: number) {
    this.sU32(60, v);
  }
}

// ---- AssetRecord (network_messages/assets.h): 48-byte union of issuance / ownership / possession. The caller
// reads the variant fields matching `type`; ownership/possession share offsets (issuanceIndex == ownershipIndex
// at @36). The @33 byte is explicit padding in the ownership/possession variants. ----
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
    return this.gM256(0);
  }
  set publicKey(v: M256i | Uint8Array) {
    this.sM256(0, v);
  }
  get type(): number {
    return this.gU8(32);
  }
  set type(v: number) {
    this.sU8(32, v);
  }

  // issuance variant
  get name(): Uint8Array {
    return this.gBytes(33, 7);
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
    const n = this.gBytes(33, 7);
    n.fill(0);
    for (let i = 0; i < Math.min(v.length, 7); i++) {
      n[i] = v.charCodeAt(i);
    }
  }
  get numberOfDecimalPlaces(): number {
    return this.gU8(40);
  }
  set numberOfDecimalPlaces(v: number) {
    this.sU8(40, v);
  }
  get unitOfMeasurement(): Uint8Array {
    return this.gBytes(41, 7);
  }

  // ownership / possession variants
  get managingContractIndex(): number {
    return this.gU16(34);
  }
  set managingContractIndex(v: number) {
    this.sU16(34, v);
  }
  get issuanceIndex(): number {
    return this.gU32(36);
  }
  set issuanceIndex(v: number) {
    this.sU32(36, v);
  }
  get ownershipIndex(): number {
    return this.gU32(36);
  }
  set ownershipIndex(v: number) {
    this.sU32(36, v);
  }
  get numberOfShares(): bigint {
    return this.gI64(40);
  }
  set numberOfShares(v: bigint) {
    this.sI64(40, v);
  }
}

// ---- Tick (network_messages/tick.h): the 352-byte computor vote. ----
export class Tick extends View {
  static readonly SIZE = 352;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, Tick.SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): Tick {
    return new Tick(buf, off);
  }

  static alloc(): Tick {
    return new Tick(new Uint8Array(Tick.SIZE));
  }

  get computorIndex(): number {
    return this.gU16(0);
  }
  set computorIndex(v: number) {
    this.sU16(0, v);
  }
  get epoch(): number {
    return this.gU16(2);
  }
  set epoch(v: number) {
    this.sU16(2, v);
  }
  get tick(): number {
    return this.gU32(4);
  }
  set tick(v: number) {
    this.sU32(4, v);
  }
  get millisecond(): number {
    return this.gU16(8);
  }
  set millisecond(v: number) {
    this.sU16(8, v);
  }
  get second(): number {
    return this.gU8(10);
  }
  set second(v: number) {
    this.sU8(10, v);
  }
  get minute(): number {
    return this.gU8(11);
  }
  set minute(v: number) {
    this.sU8(11, v);
  }
  get hour(): number {
    return this.gU8(12);
  }
  set hour(v: number) {
    this.sU8(12, v);
  }
  get day(): number {
    return this.gU8(13);
  }
  set day(v: number) {
    this.sU8(13, v);
  }
  get month(): number {
    return this.gU8(14);
  }
  set month(v: number) {
    this.sU8(14, v);
  }
  get year(): number {
    return this.gU8(15);
  }
  set year(v: number) {
    this.sU8(15, v);
  }
  get prevResourceTestingDigest(): number {
    return this.gU32(16);
  }
  set prevResourceTestingDigest(v: number) {
    this.sU32(16, v);
  }
  get saltedResourceTestingDigest(): number {
    return this.gU32(20);
  }
  set saltedResourceTestingDigest(v: number) {
    this.sU32(20, v);
  }
  get prevTransactionBodyDigest(): number {
    return this.gU32(24);
  }
  set prevTransactionBodyDigest(v: number) {
    this.sU32(24, v);
  }
  get saltedTransactionBodyDigest(): number {
    return this.gU32(28);
  }
  set saltedTransactionBodyDigest(v: number) {
    this.sU32(28, v);
  }
  get prevSpectrumDigest(): M256i {
    return this.gM256(32);
  }
  set prevSpectrumDigest(v: M256i | Uint8Array) {
    this.sM256(32, v);
  }
  get prevUniverseDigest(): M256i {
    return this.gM256(64);
  }
  set prevUniverseDigest(v: M256i | Uint8Array) {
    this.sM256(64, v);
  }
  get prevComputerDigest(): M256i {
    return this.gM256(96);
  }
  set prevComputerDigest(v: M256i | Uint8Array) {
    this.sM256(96, v);
  }
  get saltedSpectrumDigest(): M256i {
    return this.gM256(128);
  }
  set saltedSpectrumDigest(v: M256i | Uint8Array) {
    this.sM256(128, v);
  }
  get saltedUniverseDigest(): M256i {
    return this.gM256(160);
  }
  set saltedUniverseDigest(v: M256i | Uint8Array) {
    this.sM256(160, v);
  }
  get saltedComputerDigest(): M256i {
    return this.gM256(192);
  }
  set saltedComputerDigest(v: M256i | Uint8Array) {
    this.sM256(192, v);
  }
  get transactionDigest(): M256i {
    return this.gM256(224);
  }
  set transactionDigest(v: M256i | Uint8Array) {
    this.sM256(224, v);
  }
  get expectedNextTickTransactionDigest(): M256i {
    return this.gM256(256);
  }
  set expectedNextTickTransactionDigest(v: M256i | Uint8Array) {
    this.sM256(256, v);
  }
  get signature(): Uint8Array {
    return this.gBytes(288, SIG_SIZE);
  }
  set signature(v: Uint8Array) {
    this.sBytes(288, v, SIG_SIZE);
  }
}

export const TICKDATA_SIZE = 48 + TXS_PER_TICK * DIGEST_SIZE + CONTRACT_FEES_COUNT * 8 + SIG_SIZE; // 139376
const TICKDATA_DIGESTS_OFFSET = 48;
const TICKDATA_FEES_OFFSET = TICKDATA_DIGESTS_OFFSET + TXS_PER_TICK * DIGEST_SIZE; // 131120
const TICKDATA_SIG_OFFSET = TICKDATA_FEES_OFFSET + CONTRACT_FEES_COUNT * 8; // 139312

// ---- TickData (network_messages/tick.h; BROADCAST_FUTURE_TICK_DATA): the 139376-byte leader proposal. ----
export class TickData extends View {
  static readonly SIZE = TICKDATA_SIZE;
  static readonly SIG_OFFSET = TICKDATA_SIG_OFFSET;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, TickData.SIZE);
  }

  static wrap(buf: Uint8Array, off = 0): TickData {
    return new TickData(buf, off);
  }

  static alloc(): TickData {
    return new TickData(new Uint8Array(TickData.SIZE));
  }

  get computorIndex(): number {
    return this.gU16(0);
  }
  set computorIndex(v: number) {
    this.sU16(0, v);
  }
  get epoch(): number {
    return this.gU16(2);
  }
  set epoch(v: number) {
    this.sU16(2, v);
  }
  get tick(): number {
    return this.gU32(4);
  }
  set tick(v: number) {
    this.sU32(4, v);
  }
  get millisecond(): number {
    return this.gU16(8);
  }
  set millisecond(v: number) {
    this.sU16(8, v);
  }
  get second(): number {
    return this.gU8(10);
  }
  set second(v: number) {
    this.sU8(10, v);
  }
  get minute(): number {
    return this.gU8(11);
  }
  set minute(v: number) {
    this.sU8(11, v);
  }
  get hour(): number {
    return this.gU8(12);
  }
  set hour(v: number) {
    this.sU8(12, v);
  }
  get day(): number {
    return this.gU8(13);
  }
  set day(v: number) {
    this.sU8(13, v);
  }
  get month(): number {
    return this.gU8(14);
  }
  set month(v: number) {
    this.sU8(14, v);
  }
  get year(): number {
    return this.gU8(15);
  }
  set year(v: number) {
    this.sU8(15, v);
  }
  get timelock(): M256i {
    return this.gM256(16);
  }
  set timelock(v: M256i | Uint8Array) {
    this.sM256(16, v);
  }

  txDigest(i: number): M256i {
    return this.gM256(TICKDATA_DIGESTS_OFFSET + i * DIGEST_SIZE);
  }
  setTxDigest(i: number, v: M256i | Uint8Array): void {
    this.sM256(TICKDATA_DIGESTS_OFFSET + i * DIGEST_SIZE, v);
  }
  contractFee(i: number): bigint {
    return this.gI64(TICKDATA_FEES_OFFSET + i * 8);
  }
  setContractFee(i: number, v: bigint): void {
    this.sI64(TICKDATA_FEES_OFFSET + i * 8, v);
  }

  get signature(): Uint8Array {
    return this.gBytes(TICKDATA_SIG_OFFSET, SIG_SIZE);
  }
  set signature(v: Uint8Array) {
    this.sBytes(TICKDATA_SIG_OFFSET, v, SIG_SIZE);
  }
}

// ---- Transaction (network_messages/transactions.h): an 80-byte header then input[inputSize] then signature[64].
// Wraps the whole serialized tx; .input / .signature are computed from inputSize + the buffer length. ----
export class Transaction extends View {
  static readonly HEADER_SIZE = 80;

  constructor(buf: Uint8Array, off = 0) {
    super(buf, off, buf.length - off);
  }

  static wrap(buf: Uint8Array, off = 0): Transaction {
    return new Transaction(buf, off);
  }

  get sourcePublicKey(): M256i {
    return this.gM256(0);
  }
  set sourcePublicKey(v: M256i | Uint8Array) {
    this.sM256(0, v);
  }
  get destinationPublicKey(): M256i {
    return this.gM256(32);
  }
  set destinationPublicKey(v: M256i | Uint8Array) {
    this.sM256(32, v);
  }
  get amount(): bigint {
    return this.gI64(64);
  }
  set amount(v: bigint) {
    this.sI64(64, v);
  }
  get tick(): number {
    return this.gU32(72);
  }
  set tick(v: number) {
    this.sU32(72, v);
  }
  get inputType(): number {
    return this.gU16(76);
  }
  set inputType(v: number) {
    this.sU16(76, v);
  }
  get inputSize(): number {
    return this.gU16(78);
  }
  set inputSize(v: number) {
    this.sU16(78, v);
  }
  get input(): Uint8Array {
    return this.gBytes(Transaction.HEADER_SIZE, this.inputSize);
  }
  get signature(): Uint8Array {
    const start = Transaction.HEADER_SIZE + this.inputSize;
    return this.bytes.subarray(start, start + SIG_SIZE);
  }
}
