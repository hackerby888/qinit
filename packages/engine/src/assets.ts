// Asset universe mirroring core-lite's 2^24-slot open-addressing table.
// Stores 48-byte issuance, ownership, and possession records.
import { toHex, k12Bytes } from "./k12";
import { SparseMerkle } from "./merkle";
import { AssetRecord, ASSET_RECORD_SIZE } from "./wire";
import { Asset, AssetSelect } from "./abi";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)

const CAP = 1 << 24; // ASSETS_CAPACITY (2^ASSETS_DEPTH) — also the universe merkle width
const MASK = CAP - 1;
const NO_IDX = -1; // NO_ASSET_INDEX

const EMPTY = 0,
  ISSUANCE = 1,
  OWNERSHIP = 2,
  POSSESSION = 3;

interface Rec {
  type: number;
  publicKey: Uint8Array; // 32 bytes
  // issuance variant
  name: bigint; // low 7 bytes of the packed ASCII name
  decimals: number;
  unit: bigint; // low 7 bytes
  // ownership / possession variants
  mgmt: number; // managingContractIndex
  crossRef: number; // issuanceIndex (ownership) / ownershipIndex (possession)
  shares: bigint;
}

// One enumerated asset record returned to the contract-side iterator (assetEnumerate).
export interface AssetEntry {
  owner: Uint8Array;
  possessor: Uint8Array;
  shares: bigint;
  ownMgmt: number;
  posMgmt: number;
}

// A JSON-able view of one asset + its holdings, for inspection tools (the IDE assets panel).
export interface AssetSnapshot {
  issuer: string; // hex 32-byte id (a contract or user)
  name: string; // decoded ASCII name (e.g. "QX")
  decimals: number;
  unit: string;
  totalShares: string;
  holdings: {
    owner: string;
    possessor: string;
    ownMgmt: number;
    posMgmt: number;
    shares: string;
  }[];
}

// The proof rows returned for an owner's / possessor's holdings.
export interface OwnedProof {
  record: Uint8Array;
  issuer: Uint8Array;
  name: bigint;
  decimals: number;
  managingContractIndex: number;
  shares: bigint;
  index: number;
  siblings: Uint8Array[];
}

export interface PossessedProof extends OwnedProof {
  owner: Uint8Array;
}

// The one seam the AssetLedger needs from the rest of the engine: the contract-id derivation, to validate that
// an issuer is the issuing contract itself.
export interface AssetHost {
  contractId(slot: number): Uint8Array;
}

// Pack an ASCII ticker into the qpi asset-name u64 (little-endian bytes, up to 7 chars).
export function packAssetName(s: string): bigint {
  let n = 0n;
  for (let i = 0; i < Math.min(s.length, 7); i++) {
    n |= BigInt(s.charCodeAt(i) & 0xff) << BigInt(i * 8);
  }
  return n;
}

// A qpi asset name is a uint64 of packed little-endian ASCII (A-Z then 0-9/A-Z, up to 7 bytes, zero-padded).
function assetNameToString(name: bigint): string {
  let s = "";
  let n = name;
  for (let i = 0; i < 8; i++) {
    const c = Number(n & 0xffn);
    n >>= 8n;
    if (c === 0) {
      break;
    }
    s += String.fromCharCode(c);
  }
  return s;
}

// The parsed ownership/possession selects (AssetOwnershipSelect / AssetPossessionSelect).
interface Select {
  id: Uint8Array;
  mgmt: number;
  anyId: boolean;
  anyMgmt: boolean;
}

function parseSelect(b: Uint8Array): Select {
  const s = AssetSelect.wrap(b);
  return { id: s.id, mgmt: s.mgmt, anyId: s.anyId !== 0, anyMgmt: s.anyMgmt !== 0 };
}

const ANY_SELECT: Select = { id: new Uint8Array(32), mgmt: 0, anyId: true, anyMgmt: true };

export class AssetLedger {
  private readonly host: AssetHost;
  private table = new Map<number, Rec>(); // slot -> record; an absent slot is an EMPTY record
  private issuancesFirst = NO_IDX; // IndexLists.issuancesFirstIdx
  private opFirst = new Map<number, number>(); // IndexLists.ownershipsPossessionsFirstIdx
  private nextIdx = new Map<number, number>(); // IndexLists.nextIdx
  private tree: SparseMerkle | null = null; // incremental 2^24 merkle over table positions; root = universeDigest
  private dirty = new Set<number>(); // slots whose leaf changed since the last digest (assetChangeFlags)

  constructor(host: AssetHost) {
    this.host = host;
  }

  private idEq(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  private isZeroId(a: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) {
      if (a[i] !== 0) return false;
    }
    return true;
  }

  // publicKey.m256i_u32[0] — the probe start of every lookup.
  private startOf(pub: Uint8Array): number {
    return ((pub[0] | (pub[1] << 8) | (pub[2] << 16) | (pub[3] << 24)) >>> 0) & MASK;
  }

  private rec(idx: number): Rec | undefined {
    return this.table.get(idx);
  }

  private place(idx: number, r: Rec): void {
    this.table.set(idx, r);
    this.dirty.add(idx);
  }

  private markDirty(idx: number): void {
    this.dirty.add(idx);
  }

  // ---- index lists (assets.h AssetStorage::IndexLists — LIFO singly-linked) ----

  private addIssuance(idx: number): void {
    this.nextIdx.set(idx, this.issuancesFirst);
    this.issuancesFirst = idx;
  }

  private addOwnership(issuanceIdx: number, idx: number): void {
    this.nextIdx.set(idx, this.opFirst.get(issuanceIdx) ?? NO_IDX);
    this.opFirst.set(issuanceIdx, idx);
  }

  private addPossession(ownershipIdx: number, idx: number): void {
    this.nextIdx.set(idx, this.opFirst.get(ownershipIdx) ?? NO_IDX);
    this.opFirst.set(ownershipIdx, idx);
  }

  // ---- core lookups (assets.h) ----

  // issuanceIndex(issuer, assetName): linear probe from issuer's u32 until an EMPTY slot.
  private issuanceIndex(issuer: Uint8Array, name: bigint): number {
    let idx = this.startOf(issuer);
    for (;;) {
      const r = this.rec(idx);
      if (!r) return NO_IDX;
      if (r.type === ISSUANCE && r.name === name && this.idEq(r.publicKey, issuer)) return idx;
      idx = (idx + 1) & MASK;
    }
  }

  isAssetIssued(issuer: Uint8Array, name: bigint): boolean {
    return this.issuanceIndex(issuer, name & 0xffffffffffffffn) !== NO_IDX;
  }

  // ---- ownership / possession iteration (qpi_asset_impl.h AssetOwnership/PossessionIterator) ----
  // Specific id -> hash-probe from the id's u32 (collecting every matching record until an EMPTY slot);

  private ownershipIndices(issuanceIdx: number, sel: Select): number[] {
    const out: number[] = [];
    if (!sel.anyId) {
      let idx = this.startOf(sel.id);
      for (;;) {
        const r = this.rec(idx);
        if (!r) break;
        if (
          r.type === OWNERSHIP &&
          r.crossRef === issuanceIdx &&
          this.idEq(r.publicKey, sel.id) &&
          (sel.anyMgmt || r.mgmt === sel.mgmt)
        )
          out.push(idx);
        idx = (idx + 1) & MASK;
      }
      return out;
    }
    for (
      let idx = this.opFirst.get(issuanceIdx) ?? NO_IDX;
      idx !== NO_IDX;
      idx = this.nextIdx.get(idx) ?? NO_IDX
    ) {
      const r = this.rec(idx)!;
      if (sel.anyMgmt || r.mgmt === sel.mgmt) out.push(idx);
    }
    return out;
  }

  private possessionIndices(ownershipIdx: number, sel: Select): number[] {
    const out: number[] = [];
    if (!sel.anyId) {
      let idx = this.startOf(sel.id);
      for (;;) {
        const r = this.rec(idx);
        if (!r) break;
        if (
          r.type === POSSESSION &&
          r.crossRef === ownershipIdx &&
          this.idEq(r.publicKey, sel.id) &&
          (sel.anyMgmt || r.mgmt === sel.mgmt)
        )
          out.push(idx);
        idx = (idx + 1) & MASK;
      }
      return out;
    }
    for (
      let idx = this.opFirst.get(ownershipIdx) ?? NO_IDX;
      idx !== NO_IDX;
      idx = this.nextIdx.get(idx) ?? NO_IDX
    ) {
      const r = this.rec(idx)!;
      if (sel.anyMgmt || r.mgmt === sel.mgmt) out.push(idx);
    }
    return out;
  }

  // ---- issueAsset (assets.h asset layer): 3 records at consecutive probe chains; 0 if already issued ----

  issueAssetRaw(
    issuer: Uint8Array,
    name: bigint,
    decimals: number,
    unit: bigint,
    shares: bigint,
    mgmt: number,
  ): bigint {
    let issuanceIdx = this.startOf(issuer);
    for (;;) {
      const r = this.rec(issuanceIdx);
      if (!r) break;
      if (r.type === ISSUANCE && r.name === name && this.idEq(r.publicKey, issuer)) return 0n; // already issued
      issuanceIdx = (issuanceIdx + 1) & MASK;
    }
    this.place(issuanceIdx, {
      type: ISSUANCE,
      publicKey: issuer.slice(0, 32),
      name,
      decimals,
      unit,
      mgmt: 0,
      crossRef: 0,
      shares: 0n,
    });

    let ownershipIdx = (issuanceIdx + 1) & MASK;
    while (this.rec(ownershipIdx)) ownershipIdx = (ownershipIdx + 1) & MASK;
    this.place(ownershipIdx, {
      type: OWNERSHIP,
      publicKey: issuer.slice(0, 32),
      name: 0n,
      decimals: 0,
      unit: 0n,
      mgmt,
      crossRef: issuanceIdx,
      shares,
    });

    let possessionIdx = (ownershipIdx + 1) & MASK;
    while (this.rec(possessionIdx)) possessionIdx = (possessionIdx + 1) & MASK;
    this.place(possessionIdx, {
      type: POSSESSION,
      publicKey: issuer.slice(0, 32),
      name: 0n,
      decimals: 0,
      unit: 0n,
      mgmt,
      crossRef: ownershipIdx,
      shares,
    });

    this.addIssuance(issuanceIdx);
    this.addOwnership(issuanceIdx, ownershipIdx);
    this.addPossession(ownershipIdx, possessionIdx);

    return shares;
  }

  // qpi.issueAsset (qpi_asset_impl.h wrapper): full name/issuer/shares/unit validation, then the asset layer.
  issueAsset(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    decimals: number,
    shares: bigint,
    unit: bigint,
    invocator: Uint8Array,
  ): bigint {
    const first = Number(name & 0xffn);
    if (first < 0x41 || first > 0x5a || name > 0xffffffffffffffn) return 0n;
    // no character may follow the first zero byte
    for (let i = 1; i < 7; i++) {
      if (Number((name >> BigInt(i * 8)) & 0xffn) === 0) {
        for (let j = i + 1; j < 7; j++) {
          if (Number((name >> BigInt(j * 8)) & 0xffn) !== 0) return 0n;
        }
        break;
      }
    }
    // the tail characters must be 0-9 or A-Z
    for (let i = 1; i < 7; i++) {
      const c = Number((name >> BigInt(i * 8)) & 0xffn);
      if (c === 0 || (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a)) continue;
      return 0n;
    }
    if (
      this.isZeroId(issuer) ||
      (!this.idEq(issuer, this.host.contractId(slot)) && !this.idEq(issuer, invocator))
    )
      return 0n;
    if (shares <= 0n || shares > MAX_AMOUNT) return 0n;
    if (unit > 0xffffffffffffffn) return 0n;

    return this.issueAssetRaw(issuer, name, decimals, unit, shares, slot);
  }

  // Contract-share issuance (the NULL_ID-issuer convention): used by the gtest harness (issueContractShares)
  // and the dev deploy path. The node creates these via the real issueAsset with a zero issuer.
  mintContractShares(qxSlot: number, name: bigint, shares: bigint): void {
    this.issueAssetRaw(new Uint8Array(32), name & 0xffffffffffffffn, 0, 0n, shares, qxSlot);
  }

  // ---- numberOfShares (assets.h): ownership sums when possession is any/any, else possession sums ----

  numberOfShares(assetB: Uint8Array, ownSelB: Uint8Array, posSelB: Uint8Array): bigint {
    const a = Asset.wrap(assetB);
    const own = parseSelect(ownSelB);
    const pos = parseSelect(posSelB);
    return this.numberOfSharesSel(a.issuer, a.assetName & 0xffffffffffffffn, own, pos);
  }

  private numberOfSharesSel(issuer: Uint8Array, name: bigint, own: Select, pos: Select): bigint {
    const issuanceIdx = this.issuanceIndex(issuer, name);
    if (issuanceIdx === NO_IDX) return 0n;

    let sum = 0n;
    if (pos.anyId && pos.anyMgmt) {
      for (const ownershipIndex of this.ownershipIndices(issuanceIdx, own)) {
        sum += this.rec(ownershipIndex)!.shares;
      }
    } else {
      for (const ownershipIndex of this.ownershipIndices(issuanceIdx, own)) {
        for (const possessionIndex of this.possessionIndices(ownershipIndex, pos)) {
          sum += this.rec(possessionIndex)!.shares;
        }
      }
    }
    return sum;
  }

  // Enumerate ownership or possession records in the node's LIFO index order.
  // Kind 0 selects ownership; kind 1 selects possession.
  enumerate(
    assetB: Uint8Array,
    ownSelB: Uint8Array,
    posSelB: Uint8Array,
    kind: number,
  ): AssetEntry[] {
    const a = Asset.wrap(assetB);
    const own = parseSelect(ownSelB);
    const pos = parseSelect(posSelB);
    const issuanceIdx = this.issuanceIndex(a.issuer, a.assetName & 0xffffffffffffffn);
    if (issuanceIdx === NO_IDX) return [];

    const out: AssetEntry[] = [];
    for (const oi of this.ownershipIndices(issuanceIdx, own)) {
      const o = this.rec(oi)!;
      if (kind === 0) {
        out.push({
          owner: o.publicKey,
          possessor: o.publicKey,
          shares: o.shares,
          ownMgmt: o.mgmt,
          posMgmt: 0,
        });
        continue;
      }
      for (const pi of this.possessionIndices(oi, pos)) {
        const p = this.rec(pi)!;
        out.push({
          owner: o.publicKey,
          possessor: p.publicKey,
          shares: p.shares,
          ownMgmt: o.mgmt,
          posMgmt: p.mgmt,
        });
      }
    }
    return out;
  }

  // All possession records of an asset (dividends: every possessor of the contract's own shares).
  possessionsOf(issuer: Uint8Array, name: bigint): AssetEntry[] {
    const issuanceIdx = this.issuanceIndex(issuer, name & 0xffffffffffffffn);
    if (issuanceIdx === NO_IDX) return [];

    const out: AssetEntry[] = [];
    for (const oi of this.ownershipIndices(issuanceIdx, ANY_SELECT)) {
      const o = this.rec(oi)!;
      for (const pi of this.possessionIndices(oi, ANY_SELECT)) {
        const p = this.rec(pi)!;
        out.push({
          owner: o.publicKey,
          possessor: p.publicKey,
          shares: p.shares,
          ownMgmt: o.mgmt,
          posMgmt: p.mgmt,
        });
      }
    }
    return out;
  }

  // numberOfPossessedShares (assets.h): exact-match drill-down issuance -> ownership (mgmt must equal) ->
  // possession (mgmt must equal); 0 if any level probes to an EMPTY slot first.
  numberOfPossessedShares(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    ownMgmt: number,
    posMgmt: number,
  ): bigint {
    const issuanceIdx = this.issuanceIndex(issuer, name & 0xffffffffffffffn);
    if (issuanceIdx === NO_IDX) return 0n;

    let ownershipIdx = this.startOf(owner);
    for (;;) {
      const r = this.rec(ownershipIdx);
      if (!r) return 0n;
      if (
        r.type === OWNERSHIP &&
        r.crossRef === issuanceIdx &&
        this.idEq(r.publicKey, owner) &&
        r.mgmt === ownMgmt
      )
        break;
      ownershipIdx = (ownershipIdx + 1) & MASK;
    }

    let possessionIdx = this.startOf(possessor);
    for (;;) {
      const r = this.rec(possessionIdx);
      if (!r) return 0n;
      if (
        r.type === POSSESSION &&
        r.crossRef === ownershipIdx &&
        this.idEq(r.publicKey, possessor) &&
        r.mgmt === posMgmt
      )
        return r.shares;
      possessionIdx = (possessionIdx + 1) & MASK;
    }
  }

  // ---- transferShareOwnershipAndPossession ----

  // Asset layer (assets.h): move `shares` from the source ownership+possession pair to destinationPublicKey,
  // preserving each record's managingContractIndex. A zero destination burns (refused for contract shares).
  private transferOwnershipAndPossessionIdx(
    sourceOwnershipIdx: number,
    sourcePossessionIdx: number,
    destination: Uint8Array,
    shares: bigint,
  ): boolean {
    if (shares <= 0n) return false;

    const so = this.rec(sourceOwnershipIdx);
    const sp = this.rec(sourcePossessionIdx);
    if (
      !so ||
      so.type !== OWNERSHIP ||
      so.shares < shares ||
      !sp ||
      sp.type !== POSSESSION ||
      sp.shares < shares ||
      sp.crossRef !== sourceOwnershipIdx
    )
      return false;

    if (this.isZeroId(destination)) {
      // burn — refused for contract shares (zero-id issuer)
      const issuance = this.rec(so.crossRef)!;
      if (this.isZeroId(issuance.publicKey)) return false;
      so.shares -= shares;
      sp.shares -= shares;
      this.markDirty(sourceOwnershipIdx);
      this.markDirty(sourcePossessionIdx);
      return true;
    }

    let destOwnershipIdx = this.startOf(destination);
    for (;;) {
      const r = this.rec(destOwnershipIdx);
      if (
        !r ||
        (r.type === OWNERSHIP &&
          r.mgmt === so.mgmt &&
          r.crossRef === so.crossRef &&
          this.idEq(r.publicKey, destination))
      )
        break;
      destOwnershipIdx = (destOwnershipIdx + 1) & MASK;
    }
    so.shares -= shares;
    const dOwn = this.rec(destOwnershipIdx);
    if (!dOwn) {
      this.place(destOwnershipIdx, {
        type: OWNERSHIP,
        publicKey: destination.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: so.mgmt,
        crossRef: so.crossRef,
        shares,
      });
      this.addOwnership(so.crossRef, destOwnershipIdx);
    } else {
      dOwn.shares += shares;
    }

    let destPossessionIdx = this.startOf(destination);
    for (;;) {
      const r = this.rec(destPossessionIdx);
      if (
        !r ||
        (r.type === POSSESSION &&
          r.mgmt === sp.mgmt &&
          r.crossRef === destOwnershipIdx &&
          this.idEq(r.publicKey, destination))
      )
        break;
      destPossessionIdx = (destPossessionIdx + 1) & MASK;
    }
    sp.shares -= shares;
    const dPos = this.rec(destPossessionIdx);
    if (!dPos) {
      this.place(destPossessionIdx, {
        type: POSSESSION,
        publicKey: destination.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: sp.mgmt,
        crossRef: destOwnershipIdx,
        shares,
      });
      this.addPossession(destOwnershipIdx, destPossessionIdx);
    } else {
      dPos.shares += shares;
    }

    this.markDirty(sourceOwnershipIdx);
    this.markDirty(sourcePossessionIdx);
    this.markDirty(destOwnershipIdx);
    this.markDirty(destPossessionIdx);
    return true;
  }

  // Transfer both records only when the calling contract manages ownership and possession.
  // Return the node-compatible remaining balance or negative failure code.
  transferShareOwnershipAndPossession(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    newOwner: Uint8Array,
  ): bigint {
    if (shares <= 0n || shares > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const issuanceIdx = this.issuanceIndex(issuer, name & 0xffffffffffffffn);
    if (issuanceIdx === NO_IDX) return -shares;

    let ownershipIdx = this.startOf(owner);
    for (;;) {
      const r = this.rec(ownershipIdx);
      if (!r) return -shares;
      if (
        r.type === OWNERSHIP &&
        r.crossRef === issuanceIdx &&
        this.idEq(r.publicKey, owner) &&
        r.mgmt === slot
      )
        break;
      ownershipIdx = (ownershipIdx + 1) & MASK;
    }

    let possessionIdx = this.startOf(possessor);
    for (;;) {
      const r = this.rec(possessionIdx);
      if (!r) return -shares;
      if (
        r.type === POSSESSION &&
        r.crossRef === ownershipIdx &&
        this.idEq(r.publicKey, possessor)
      ) {
        if (r.mgmt !== slot) return -shares;
        if (r.shares < shares) return r.shares - shares;
        if (!this.transferOwnershipAndPossessionIdx(ownershipIdx, possessionIdx, newOwner, shares))
          return INVALID_AMOUNT;
        return r.shares;
      }
      possessionIdx = (possessionIdx + 1) & MASK;
    }
  }

  // ---- transferShareManagementRights (assets.h): only managingContractIndex changes; identities stay ----

  private transferManagementRightsIdx(
    sourceOwnershipIdx: number,
    sourcePossessionIdx: number,
    dstOwnMgmt: number,
    dstPosMgmt: number,
    shares: bigint,
  ): boolean {
    const so = this.rec(sourceOwnershipIdx);
    const sp = this.rec(sourcePossessionIdx);
    if (
      !so ||
      so.type !== OWNERSHIP ||
      so.shares < shares ||
      !sp ||
      sp.type !== POSSESSION ||
      sp.shares < shares ||
      sp.crossRef !== sourceOwnershipIdx
    )
      return false;

    let destOwnershipIdx = this.startOf(so.publicKey);
    for (;;) {
      const r = this.rec(destOwnershipIdx);
      if (
        !r ||
        (r.type === OWNERSHIP &&
          r.mgmt === dstOwnMgmt &&
          r.crossRef === so.crossRef &&
          this.idEq(r.publicKey, so.publicKey))
      )
        break;
      destOwnershipIdx = (destOwnershipIdx + 1) & MASK;
    }
    so.shares -= shares;
    const dOwn = this.rec(destOwnershipIdx);
    if (!dOwn) {
      this.place(destOwnershipIdx, {
        type: OWNERSHIP,
        publicKey: so.publicKey.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: dstOwnMgmt,
        crossRef: so.crossRef,
        shares,
      });
      this.addOwnership(so.crossRef, destOwnershipIdx);
    } else {
      dOwn.shares += shares;
    }

    let destPossessionIdx = this.startOf(sp.publicKey);
    for (;;) {
      const r = this.rec(destPossessionIdx);
      if (
        !r ||
        (r.type === POSSESSION &&
          r.mgmt === dstPosMgmt &&
          r.crossRef === destOwnershipIdx &&
          this.idEq(r.publicKey, sp.publicKey))
      )
        break;
      destPossessionIdx = (destPossessionIdx + 1) & MASK;
    }
    sp.shares -= shares;
    const dPos = this.rec(destPossessionIdx);
    if (!dPos) {
      this.place(destPossessionIdx, {
        type: POSSESSION,
        publicKey: sp.publicKey.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: dstPosMgmt,
        crossRef: destOwnershipIdx,
        shares,
      });
      this.addPossession(destOwnershipIdx, destPossessionIdx);
    } else {
      dPos.shares += shares;
    }

    this.markDirty(sourceOwnershipIdx);
    this.markDirty(sourcePossessionIdx);
    this.markDirty(destOwnershipIdx);
    this.markDirty(destPossessionIdx);
    return true;
  }

  // Resolve the caller-managed pair used by Sim's acquire/release wrappers.
  // The node rejects split custody at the QPI level.
  transferShareManagementRights(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    srcMgmt: number,
    dstMgmt: number,
    shares: bigint,
  ): boolean {
    if (shares <= 0n) return false;

    const issuanceIdx = this.issuanceIndex(issuer, name & 0xffffffffffffffn);
    if (issuanceIdx === NO_IDX) return false;

    for (const oi of this.ownershipIndices(issuanceIdx, {
      id: owner,
      mgmt: srcMgmt,
      anyId: false,
      anyMgmt: false,
    })) {
      for (const pi of this.possessionIndices(oi, {
        id: possessor,
        mgmt: srcMgmt,
        anyId: false,
        anyMgmt: false,
      })) {
        return this.transferManagementRightsIdx(oi, pi, dstMgmt, dstMgmt, shares);
      }
    }
    return false;
  }

  // Read-only snapshot of the asset universe (every issued asset + its records) for inspection tools.
  // Plain JSON-able values: ids as hex, shares/unit as decimal strings, name decoded to its ASCII form.
  assetUniverse(): AssetSnapshot[] {
    const out: AssetSnapshot[] = [];
    for (let ii = this.issuancesFirst; ii !== NO_IDX; ii = this.nextIdx.get(ii) ?? NO_IDX) {
      const iss = this.rec(ii)!;
      let total = 0n;
      const holdings: AssetSnapshot["holdings"] = [];
      for (const oi of this.ownershipIndices(ii, ANY_SELECT)) {
        const o = this.rec(oi)!;
        total += o.shares;
        for (const pi of this.possessionIndices(oi, ANY_SELECT)) {
          const p = this.rec(pi)!;
          holdings.push({
            owner: toHex(o.publicKey),
            possessor: toHex(p.publicKey),
            ownMgmt: o.mgmt,
            posMgmt: p.mgmt,
            shares: p.shares.toString(),
          });
        }
      }
      out.push({
        issuer: toHex(iss.publicKey),
        name: assetNameToString(iss.name),
        decimals: iss.decimals,
        unit: iss.unit.toString(),
        totalShares: total.toString(),
        holdings,
      });
    }
    return out;
  }

  // ---- universe merkle (position-indexed, like the node's assetDigests over assets[]) ----

  // The 48-byte AssetRecord at a slot — the universe merkle leaf bytes (an absent slot is all-zero).
  private recordBytes(idx: number): Uint8Array {
    const r = this.rec(idx);
    const rec = AssetRecord.alloc();
    if (!r) return rec.bytes;

    rec.publicKey = r.publicKey;
    rec.type = r.type;
    if (r.type === ISSUANCE) {
      let n = r.name;
      const nb = rec.name;
      for (let i = 0; i < 7; i++) {
        nb[i] = Number(n & 0xffn);
        n >>= 8n;
      }
      rec.numberOfDecimalPlaces = r.decimals;
      let u = r.unit;
      const ub = rec.unitOfMeasurement;
      for (let i = 0; i < 7; i++) {
        ub[i] = Number(u & 0xffn);
        u >>= 8n;
      }
    } else {
      rec.managingContractIndex = r.mgmt;
      rec.issuanceIndex = r.crossRef;
      rec.numberOfShares = r.shares;
    }
    return rec.bytes;
  }

  // getUniverseDigest — the root of the incremental 2^24 merkle over table positions. leaf = K12(record).
  getUniverseDigest(): Uint8Array {
    if (!this.tree) {
      this.tree = new SparseMerkle(k12Bytes(new Uint8Array(ASSET_RECORD_SIZE)));
    }

    for (const idx of this.dirty) {
      this.tree.setLeaf(idx, k12Bytes(this.recordBytes(idx)));
    }
    this.dirty.clear();
    return this.tree.root();
  }

  // Ownership proof for each asset ownerId owns: the ownership AssetRecord + its universe index + siblings,
  // plus the issuance fields for the attached record. A client recomputes the universe root from the record.
  universeProofOwned(ownerId: Uint8Array): OwnedProof[] {
    this.getUniverseDigest();
    const out: OwnedProof[] = [];
    for (let ii = this.issuancesFirst; ii !== NO_IDX; ii = this.nextIdx.get(ii) ?? NO_IDX) {
      const iss = this.rec(ii)!;
      for (const oi of this.ownershipIndices(ii, ANY_SELECT)) {
        const o = this.rec(oi)!;
        if (!this.idEq(o.publicKey, ownerId)) continue;
        out.push({
          record: this.recordBytes(oi),
          issuer: iss.publicKey,
          name: iss.name,
          decimals: iss.decimals,
          managingContractIndex: o.mgmt,
          shares: o.shares,
          index: oi,
          siblings: this.tree!.siblings(oi),
        });
      }
    }
    return out;
  }

  // Possession proof for each asset possessorId possesses (mirrors universeProofOwned).
  universeProofPossessed(possessorId: Uint8Array): PossessedProof[] {
    this.getUniverseDigest();
    const out: PossessedProof[] = [];
    for (let ii = this.issuancesFirst; ii !== NO_IDX; ii = this.nextIdx.get(ii) ?? NO_IDX) {
      const iss = this.rec(ii)!;
      for (const oi of this.ownershipIndices(ii, ANY_SELECT)) {
        const o = this.rec(oi)!;
        for (const pi of this.possessionIndices(oi, ANY_SELECT)) {
          const p = this.rec(pi)!;
          if (!this.idEq(p.publicKey, possessorId)) continue;
          out.push({
            record: this.recordBytes(pi),
            owner: o.publicKey,
            issuer: iss.publicKey,
            name: iss.name,
            decimals: iss.decimals,
            managingContractIndex: p.mgmt,
            shares: p.shares,
            index: pi,
            siblings: this.tree!.siblings(pi),
          });
        }
      }
    }
    return out;
  }
}
