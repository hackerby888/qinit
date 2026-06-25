// The asset universe — every issued asset and its share holdings, plus the incremental 2^24 merkle whose root is
// the universeDigest. The TS mirror of core-lite assets/assets.h + qpi_asset_impl.h (issueAsset /
// numberOfShares / numberOfPossessedShares / transferShareOwnershipAndPossession / transferShareManagementRights
// / getUniverseDigest). A pure ledger of the structural share state: it reaches the rest of the engine only for
// the contract-id derivation (the injected AssetHost). The fee / callback / spectrum orchestration of
// acquireShares / releaseShares / distributeDividends stays in Sim, which calls these primitives.
import { toHex, k12Bytes } from "./k12";
import { SparseMerkle } from "./merkle";
import { AssetRecord, ASSET_RECORD_SIZE } from "./wire";
import { Asset, AssetSelect } from "./abi";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h

interface Holding {
  owner: Uint8Array;
  possessor: Uint8Array;
  ownMgmt: number;
  posMgmt: number;
  shares: bigint;
}

interface AssetRec {
  issuer: Uint8Array;
  name: bigint;
  decimals: number;
  unit: bigint;
  holdings: Map<string, Holding>;
}

// A JSON-able view of one asset + its holdings, for inspection tools (the IDE assets panel).
export interface AssetSnapshot {
  issuer: string; // hex 32-byte id (a contract or user)
  name: string; // decoded ASCII name (e.g. "QX")
  decimals: number;
  unit: string;
  totalShares: string;
  holdings: { owner: string; possessor: string; ownMgmt: number; posMgmt: number; shares: string }[];
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

// A 48-byte AssetRecord (ownership type=2 / possession type=3 variant): publicKey(32) type(1) padding(1)
// managingContractIndex(2) crossRefIndex(4, left 0) numberOfShares(8). The universe merkle leaf.
function assetRecord(pubkey: Uint8Array, type: number, mgmt: number, shares: bigint): Uint8Array {
  const rec = AssetRecord.alloc();
  rec.publicKey = pubkey;
  rec.type = type;
  rec.managingContractIndex = mgmt;
  rec.numberOfShares = shares;
  return rec.bytes;
}

export class AssetLedger {
  private readonly host: AssetHost;
  private assets = new Map<string, AssetRec>(); // assetKey -> issuance + holdings
  private tree: SparseMerkle | null = null; // incremental 2^24 merkle; root = universeDigest
  private idx = new Map<string, number>(); // "o|p assetKey holdingKey" -> stable leaf index
  private dirty = new Set<string>(); // holdings whose leaf changed since the last digest

  constructor(host: AssetHost) {
    this.host = host;
  }

  private idEq(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  private isZeroId(a: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) if (a[i] !== 0) return false;
    return true;
  }

  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }

  private assetKey(issuer: Uint8Array, name: bigint): string {
    return toHex(issuer.subarray(0, 32)) + ":" + name.toString();
  }

  private holdingKey(owner: Uint8Array, possessor: Uint8Array, ownMgmt: number, posMgmt: number): string {
    return toHex(owner.subarray(0, 32)) + ":" + toHex(possessor.subarray(0, 32)) + ":" + ownMgmt + ":" + posMgmt;
  }

  private findAsset(issuer: Uint8Array, name: bigint): AssetRec | undefined {
    return this.assets.get(this.assetKey(issuer, name));
  }

  isAssetIssued(issuer: Uint8Array, name: bigint): boolean {
    return this.findAsset(issuer, name) !== undefined;
  }

  // issueAsset: validate name (first byte A-Z, <=7 bytes), issuer (== this contract or invocator), shares range.
  // Mint all shares to the issuer (owner + possessor), managed by the issuing contract. Returns shares (0 on fail).
  issueAsset(slot: number, name: bigint, issuer: Uint8Array, decimals: number, shares: bigint, unit: bigint, invocator: Uint8Array): bigint {
    const first = Number(name & 0xffn);
    if (first < 0x41 || first > 0x5a || name > 0xffffffffffffffn) return 0n;
    if (this.isZeroId(issuer) || (!this.idEq(issuer, this.host.contractId(slot)) && !this.idEq(issuer, invocator))) return 0n;
    if (shares <= 0n || shares > MAX_AMOUNT) return 0n;
    if (unit > 0xffffffffffffffn) return 0n;

    const k = this.assetKey(issuer, name);
    if (this.assets.has(k)) return 0n; // already issued

    const holdings = new Map<string, Holding>();
    holdings.set(this.holdingKey(issuer, issuer, slot, slot), { owner: issuer.slice(0, 32), possessor: issuer.slice(0, 32), ownMgmt: slot, posMgmt: slot, shares });
    this.assets.set(k, { issuer: issuer.slice(0, 32), name, decimals, unit, holdings });
    this.markHoldingDirty(k, this.holdingKey(issuer, issuer, slot, slot));

    return shares;
  }

  // numberOfShares(Asset, AssetOwnershipSelect, AssetPossessionSelect) — sum holdings matching the selectors.
  numberOfShares(assetB: Uint8Array, ownSelB: Uint8Array, posSelB: Uint8Array): bigint {
    const a = Asset.wrap(assetB);
    const asset = this.findAsset(a.issuer, a.assetName);
    if (!asset) return 0n;

    const own = AssetSelect.wrap(ownSelB);
    const pos = AssetSelect.wrap(posSelB);
    const ownId = own.id, ownMgmt = own.mgmt, anyOwner = own.anyId !== 0, anyOwnMgmt = own.anyMgmt !== 0;
    const posId = pos.id, posMgmt = pos.mgmt, anyPos = pos.anyId !== 0, anyPosMgmt = pos.anyMgmt !== 0;

    let sum = 0n;
    for (const h of asset.holdings.values()) {
      if (!anyOwner && !this.idEq(h.owner, ownId)) continue;
      if (!anyOwnMgmt && h.ownMgmt !== ownMgmt) continue;
      if (!anyPos && !this.idEq(h.possessor, posId)) continue;
      if (!anyPosMgmt && h.posMgmt !== posMgmt) continue;
      sum += h.shares;
    }
    return sum;
  }

  numberOfPossessedShares(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, ownMgmt: number, posMgmt: number): bigint {
    const asset = this.findAsset(issuer, name);
    if (!asset) return 0n;

    const h = asset.holdings.get(this.holdingKey(owner, possessor, ownMgmt, posMgmt));
    return h ? h.shares : 0n;
  }

  // transferShareOwnershipAndPossession: move shares from (owner,possessor) managed by THIS contract to
  // (newOwner,newOwner). Returns the source's remaining shares; negative on insufficient; -shares if not found.
  transferShareOwnershipAndPossession(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, newOwner: Uint8Array): bigint {
    if (shares <= 0n || shares > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const asset = this.findAsset(issuer, name);
    if (!asset) return -shares;

    const hk = this.holdingKey(owner, possessor, slot, slot); // must be managed by the current contract
    const h = asset.holdings.get(hk);
    if (!h) return -shares;
    if (h.shares < shares) return h.shares - shares; // insufficient -> no move

    h.shares -= shares;
    if (h.shares === 0n) asset.holdings.delete(hk);

    const dk = this.holdingKey(newOwner, newOwner, slot, slot);
    const d = asset.holdings.get(dk);
    if (d) d.shares += shares;
    else asset.holdings.set(dk, { owner: newOwner.slice(0, 32), possessor: newOwner.slice(0, 32), ownMgmt: slot, posMgmt: slot, shares });

    const ak = this.assetKey(issuer, name);
    this.markHoldingDirty(ak, hk);
    this.markHoldingDirty(ak, dk);

    return h.shares; // remaining shares of the source possessor
  }

  // The low-level management-rights move: shares of (owner,possessor) managed by srcMgmt become managed by
  // dstMgmt. Owner and possessor (always equal at the qpi level) are unchanged; only the managing contract
  // changes. Callback-free — Sim's acquire/release wrappers run the approval callbacks around this.
  transferShareManagementRights(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, srcMgmt: number, dstMgmt: number, shares: bigint): boolean {
    if (shares <= 0n) {
      return false;
    }

    const asset = this.findAsset(issuer, name);
    if (!asset) {
      return false;
    }

    const sk = this.holdingKey(owner, possessor, srcMgmt, srcMgmt);
    const src = asset.holdings.get(sk);
    if (!src || src.shares < shares) {
      return false;
    }

    src.shares -= shares;
    if (src.shares === 0n) {
      asset.holdings.delete(sk);
    }

    const dk = this.holdingKey(owner, possessor, dstMgmt, dstMgmt);
    const dst = asset.holdings.get(dk);
    if (dst) {
      dst.shares += shares;
    } else {
      asset.holdings.set(dk, { owner: owner.slice(0, 32), possessor: possessor.slice(0, 32), ownMgmt: dstMgmt, posMgmt: dstMgmt, shares });
    }

    const ak = this.assetKey(issuer, name);
    this.markHoldingDirty(ak, sk);
    this.markHoldingDirty(ak, dk);

    return true;
  }

  // Read-only snapshot of the asset universe (every issued asset + its share holdings) for inspection tools.
  // Plain JSON-able values: ids as hex, shares/unit as decimal strings, name decoded to its ASCII form.
  assetUniverse(): AssetSnapshot[] {
    const out: AssetSnapshot[] = [];
    for (const a of this.assets.values()) {
      let total = 0n;
      const holdings = [...a.holdings.values()].map((h) => {
        total += h.shares;
        return { owner: toHex(h.owner.subarray(0, 32)), possessor: toHex(h.possessor.subarray(0, 32)), ownMgmt: h.ownMgmt, posMgmt: h.posMgmt, shares: h.shares.toString() };
      });
      out.push({ issuer: toHex(a.issuer.subarray(0, 32)), name: assetNameToString(a.name), decimals: a.decimals, unit: a.unit.toString(), totalShares: total.toString(), holdings });
    }
    return out;
  }

  // The 48-byte AssetRecord ownership / possession variants — the universe leaves, byte-identical to what a
  // client hashes: publicKey(32) type(1) padding(1) managingContractIndex(2) crossRefIndex(4) numberOfShares(8).
  private ownershipRecord(owner: Uint8Array, ownMgmt: number, shares: bigint): Uint8Array {
    return assetRecord(owner, 2, ownMgmt, shares);
  }

  private possessionRecord(possessor: Uint8Array, posMgmt: number, shares: bigint): Uint8Array {
    return assetRecord(possessor, 3, posMgmt, shares);
  }

  // Assign (and remember) a stable leaf index for a universe key.
  private leafIndex(key: string): number {
    const existing = this.idx.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const next = this.idx.size;
    this.idx.set(key, next);
    return next;
  }

  private markHoldingDirty(assetKey: string, holdingKey: string): void {
    this.dirty.add(assetKey + " " + holdingKey);
  }

  // getUniverseDigest — the root of the incremental 2^24 merkle over asset holdings. A deleted holding's leaf
  // goes back to the empty-leaf hash. leaf = K12(holdingRecord).
  getUniverseDigest(): Uint8Array {
    if (!this.tree) {
      this.tree = new SparseMerkle(k12Bytes(new Uint8Array(ASSET_RECORD_SIZE)));
    }

    for (const gk of this.dirty) {
      const sep = gk.indexOf(" ");
      const asset = this.assets.get(gk.slice(0, sep));
      const h = asset?.holdings.get(gk.slice(sep + 1));
      const own = asset && h ? k12Bytes(this.ownershipRecord(h.owner, h.ownMgmt, h.shares)) : k12Bytes(new Uint8Array(ASSET_RECORD_SIZE));
      const pos = asset && h ? k12Bytes(this.possessionRecord(h.possessor, h.posMgmt, h.shares)) : k12Bytes(new Uint8Array(ASSET_RECORD_SIZE));
      this.tree.setLeaf(this.leafIndex("o " + gk), own);
      this.tree.setLeaf(this.leafIndex("p " + gk), pos);
    }
    this.dirty.clear();
    return this.tree.root();
  }

  // Ownership proof for each asset ownerId owns: the ownership AssetRecord + its universe index + siblings, plus
  // the issuance fields for the attached record. A client recomputes the universe root from the record.
  universeProofOwned(ownerId: Uint8Array): OwnedProof[] {
    this.getUniverseDigest();
    const ownerHex = this.key(ownerId);
    const out: OwnedProof[] = [];
    for (const [assetKey, asset] of this.assets) {
      for (const [hk, h] of asset.holdings) {
        if (this.key(h.owner) !== ownerHex) {
          continue;
        }
        const index = this.idx.get("o " + assetKey + " " + hk)!;
        out.push({ record: this.ownershipRecord(h.owner, h.ownMgmt, h.shares), issuer: asset.issuer, name: asset.name, decimals: asset.decimals, managingContractIndex: h.ownMgmt, shares: h.shares, index, siblings: this.tree!.siblings(index) });
      }
    }
    return out;
  }

  // Possession proof for each asset possessorId possesses (mirrors universeProofOwned).
  universeProofPossessed(possessorId: Uint8Array): PossessedProof[] {
    this.getUniverseDigest();
    const posHex = this.key(possessorId);
    const out: PossessedProof[] = [];
    for (const [assetKey, asset] of this.assets) {
      for (const [hk, h] of asset.holdings) {
        if (this.key(h.possessor) !== posHex) {
          continue;
        }
        const index = this.idx.get("p " + assetKey + " " + hk)!;
        out.push({ record: this.possessionRecord(h.possessor, h.posMgmt, h.shares), owner: h.owner, issuer: asset.issuer, name: asset.name, decimals: asset.decimals, managingContractIndex: h.posMgmt, shares: h.shares, index, siblings: this.tree!.siblings(index) });
      }
    }
    return out;
  }
}
