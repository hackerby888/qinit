import { toHex, k12Bytes } from "./k12";
import { SparseMerkle } from "./merkle";
import { AssetRecord, ASSET_RECORD_SIZE } from "./wire";
import { Asset, AssetSelect } from "./abi";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)

const ASSET_CAPACITY = 1 << 24;
const ASSET_INDEX_MASK = ASSET_CAPACITY - 1;
const NO_ASSET_INDEX = -1;

const ISSUANCE = 1;
const OWNERSHIP = 2;
const POSSESSION = 3;

interface LedgerRecord {
  type: number;
  publicKey: Uint8Array;
  name: bigint;
  decimals: number;
  unit: bigint;
  mgmt: number;
  crossRef: number;
  shares: bigint;
}

export interface AssetEntry {
  owner: Uint8Array;
  possessor: Uint8Array;
  shares: bigint;
  ownMgmt: number;
  posMgmt: number;
}

export interface AssetSnapshot {
  issuer: string;
  name: string;
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

export interface AssetHost {
  contractId(slot: number): Uint8Array;
}

export function packAssetName(name: string): bigint {
  let packed = 0n;

  for (let index = 0; index < Math.min(name.length, 7); index++) {
    packed |=
      BigInt(name.charCodeAt(index) & 0xff) <<
      BigInt(index * 8);
  }

  return packed;
}

function assetNameToString(name: bigint): string {
  let text = "";
  let remaining = name;

  for (let index = 0; index < 8; index++) {
    const character = Number(remaining & 0xffn);
    remaining >>= 8n;

    if (character === 0) {
      break;
    }

    text += String.fromCharCode(character);
  }

  return text;
}

interface AssetSelection {
  id: Uint8Array;
  mgmt: number;
  anyId: boolean;
  anyMgmt: boolean;
}

function parseSelect(bytes: Uint8Array): AssetSelection {
  const selection = AssetSelect.wrap(bytes);

  return {
    id: selection.id,
    mgmt: selection.mgmt,
    anyId: selection.anyId !== 0,
    anyMgmt: selection.anyMgmt !== 0,
  };
}

const ANY_SELECT: AssetSelection = {
  id: new Uint8Array(32),
  mgmt: 0,
  anyId: true,
  anyMgmt: true,
};

export class AssetLedger {
  private readonly host: AssetHost;
  private table = new Map<number, LedgerRecord>();
  private firstIssuanceIndex = NO_ASSET_INDEX;
  private firstChildIndex = new Map<number, number>();
  private nextIndex = new Map<number, number>();
  private tree: SparseMerkle | null = null;
  private dirty = new Set<number>();

  constructor(host: AssetHost) {
    this.host = host;
  }

  private idEq(left: Uint8Array, right: Uint8Array): boolean {
    for (let index = 0; index < 32; index++) {
      if (left[index] !== right[index]) {
        return false;
      }
    }

    return true;
  }

  private isZeroId(id: Uint8Array): boolean {
    for (let index = 0; index < 32; index++) {
      if (id[index] !== 0) {
        return false;
      }
    }

    return true;
  }

  private startOf(publicKey: Uint8Array): number {
    const firstWord =
      publicKey[0] |
      (publicKey[1] << 8) |
      (publicKey[2] << 16) |
      (publicKey[3] << 24);

    return (firstWord >>> 0) & ASSET_INDEX_MASK;
  }

  private record(index: number): LedgerRecord | undefined {
    return this.table.get(index);
  }

  private setRecord(index: number, record: LedgerRecord): void {
    this.table.set(index, record);
    this.dirty.add(index);
  }

  private markDirty(index: number): void {
    this.dirty.add(index);
  }

  private addIssuance(index: number): void {
    this.nextIndex.set(index, this.firstIssuanceIndex);
    this.firstIssuanceIndex = index;
  }

  private addOwnership(
    issuanceIndex: number,
    ownershipIndex: number,
  ): void {
    this.nextIndex.set(
      ownershipIndex,
      this.firstChildIndex.get(issuanceIndex) ?? NO_ASSET_INDEX,
    );
    this.firstChildIndex.set(issuanceIndex, ownershipIndex);
  }

  private addPossession(
    ownershipIndex: number,
    possessionIndex: number,
  ): void {
    this.nextIndex.set(
      possessionIndex,
      this.firstChildIndex.get(ownershipIndex) ?? NO_ASSET_INDEX,
    );
    this.firstChildIndex.set(ownershipIndex, possessionIndex);
  }

  private issuanceIndex(issuer: Uint8Array, name: bigint): number {
    let index = this.startOf(issuer);

    for (;;) {
      const record = this.record(index);
      if (!record) {
        return NO_ASSET_INDEX;
      }

      if (
        record.type === ISSUANCE &&
        record.name === name &&
        this.idEq(record.publicKey, issuer)
      ) {
        return index;
      }

      index = (index + 1) & ASSET_INDEX_MASK;
    }
  }

  isAssetIssued(issuer: Uint8Array, name: bigint): boolean {
    return (
      this.issuanceIndex(issuer, name & 0xffffffffffffffn) !==
      NO_ASSET_INDEX
    );
  }

  private ownershipIndices(
    issuanceIndex: number,
    selection: AssetSelection,
  ): number[] {
    const indexes: number[] = [];

    if (!selection.anyId) {
      let index = this.startOf(selection.id);

      for (;;) {
        const record = this.record(index);
        if (!record) {
          break;
        }

        if (
          record.type === OWNERSHIP &&
          record.crossRef === issuanceIndex &&
          this.idEq(record.publicKey, selection.id) &&
          (selection.anyMgmt || record.mgmt === selection.mgmt)
        ) {
          indexes.push(index);
        }

        index = (index + 1) & ASSET_INDEX_MASK;
      }

      return indexes;
    }

    for (
      let index =
        this.firstChildIndex.get(issuanceIndex) ?? NO_ASSET_INDEX;
      index !== NO_ASSET_INDEX;
      index = this.nextIndex.get(index) ?? NO_ASSET_INDEX
    ) {
      const record = this.record(index)!;
      if (selection.anyMgmt || record.mgmt === selection.mgmt) {
        indexes.push(index);
      }
    }

    return indexes;
  }

  private possessionIndices(
    ownershipIndex: number,
    selection: AssetSelection,
  ): number[] {
    const indexes: number[] = [];

    if (!selection.anyId) {
      let index = this.startOf(selection.id);

      for (;;) {
        const record = this.record(index);
        if (!record) {
          break;
        }

        if (
          record.type === POSSESSION &&
          record.crossRef === ownershipIndex &&
          this.idEq(record.publicKey, selection.id) &&
          (selection.anyMgmt || record.mgmt === selection.mgmt)
        ) {
          indexes.push(index);
        }

        index = (index + 1) & ASSET_INDEX_MASK;
      }

      return indexes;
    }

    for (
      let index =
        this.firstChildIndex.get(ownershipIndex) ?? NO_ASSET_INDEX;
      index !== NO_ASSET_INDEX;
      index = this.nextIndex.get(index) ?? NO_ASSET_INDEX
    ) {
      const record = this.record(index)!;
      if (selection.anyMgmt || record.mgmt === selection.mgmt) {
        indexes.push(index);
      }
    }

    return indexes;
  }

  issueAssetRaw(
    issuer: Uint8Array,
    name: bigint,
    decimals: number,
    unit: bigint,
    shares: bigint,
    managingContractIndex: number,
  ): bigint {
    let issuanceIndex = this.startOf(issuer);

    for (;;) {
      const record = this.record(issuanceIndex);
      if (!record) {
        break;
      }

      if (
        record.type === ISSUANCE &&
        record.name === name &&
        this.idEq(record.publicKey, issuer)
      ) {
        return 0n;
      }

      issuanceIndex = (issuanceIndex + 1) & ASSET_INDEX_MASK;
    }

    this.setRecord(issuanceIndex, {
      type: ISSUANCE,
      publicKey: issuer.slice(0, 32),
      name,
      decimals,
      unit,
      mgmt: 0,
      crossRef: 0,
      shares: 0n,
    });

    let ownershipIndex = (issuanceIndex + 1) & ASSET_INDEX_MASK;
    while (this.record(ownershipIndex)) {
      ownershipIndex = (ownershipIndex + 1) & ASSET_INDEX_MASK;
    }

    this.setRecord(ownershipIndex, {
      type: OWNERSHIP,
      publicKey: issuer.slice(0, 32),
      name: 0n,
      decimals: 0,
      unit: 0n,
      mgmt: managingContractIndex,
      crossRef: issuanceIndex,
      shares,
    });

    let possessionIndex = (ownershipIndex + 1) & ASSET_INDEX_MASK;
    while (this.record(possessionIndex)) {
      possessionIndex = (possessionIndex + 1) & ASSET_INDEX_MASK;
    }

    this.setRecord(possessionIndex, {
      type: POSSESSION,
      publicKey: issuer.slice(0, 32),
      name: 0n,
      decimals: 0,
      unit: 0n,
      mgmt: managingContractIndex,
      crossRef: ownershipIndex,
      shares,
    });

    this.addIssuance(issuanceIndex);
    this.addOwnership(issuanceIndex, ownershipIndex);
    this.addPossession(ownershipIndex, possessionIndex);

    return shares;
  }

  issueAsset(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    decimals: number,
    shares: bigint,
    unit: bigint,
    invocator: Uint8Array,
  ): bigint {
    const firstCharacter = Number(name & 0xffn);
    if (
      firstCharacter < 0x41 ||
      firstCharacter > 0x5a ||
      name > 0xffffffffffffffn
    ) {
      return 0n;
    }

    for (let index = 1; index < 7; index++) {
      const character = Number(
        (name >> BigInt(index * 8)) & 0xffn,
      );
      if (character === 0) {
        for (let tailIndex = index + 1; tailIndex < 7; tailIndex++) {
          const tailCharacter = Number(
            (name >> BigInt(tailIndex * 8)) & 0xffn,
          );
          if (tailCharacter !== 0) {
            return 0n;
          }
        }

        break;
      }
    }

    for (let index = 1; index < 7; index++) {
      const character = Number(
        (name >> BigInt(index * 8)) & 0xffn,
      );
      const isDigit = character >= 0x30 && character <= 0x39;
      const isUppercaseLetter =
        character >= 0x41 && character <= 0x5a;

      if (character === 0 || isDigit || isUppercaseLetter) {
        continue;
      }

      return 0n;
    }

    if (this.isZeroId(issuer)) {
      return 0n;
    }

    const isAuthorizedIssuer =
      this.idEq(issuer, this.host.contractId(slot)) ||
      this.idEq(issuer, invocator);
    if (!isAuthorizedIssuer) {
      return 0n;
    }
    if (shares <= 0n || shares > MAX_AMOUNT) {
      return 0n;
    }
    if (unit > 0xffffffffffffffn) {
      return 0n;
    }

    return this.issueAssetRaw(issuer, name, decimals, unit, shares, slot);
  }

  mintContractShares(qxSlot: number, name: bigint, shares: bigint): void {
    this.issueAssetRaw(
      new Uint8Array(32),
      name & 0xffffffffffffffn,
      0,
      0n,
      shares,
      qxSlot,
    );
  }

  numberOfShares(
    assetBytes: Uint8Array,
    ownershipSelectionBytes: Uint8Array,
    possessionSelectionBytes: Uint8Array,
  ): bigint {
    const asset = Asset.wrap(assetBytes);
    const ownership = parseSelect(ownershipSelectionBytes);
    const possession = parseSelect(possessionSelectionBytes);

    return this.numberOfSharesSel(
      asset.issuer,
      asset.assetName & 0xffffffffffffffn,
      ownership,
      possession,
    );
  }

  private numberOfSharesSel(
    issuer: Uint8Array,
    name: bigint,
    ownership: AssetSelection,
    possession: AssetSelection,
  ): bigint {
    const issuanceIndex = this.issuanceIndex(issuer, name);
    if (issuanceIndex === NO_ASSET_INDEX) {
      return 0n;
    }

    let total = 0n;

    if (possession.anyId && possession.anyMgmt) {
      for (const ownershipIndex of this.ownershipIndices(
        issuanceIndex,
        ownership,
      )) {
        total += this.record(ownershipIndex)!.shares;
      }
    } else {
      for (const ownershipIndex of this.ownershipIndices(
        issuanceIndex,
        ownership,
      )) {
        for (const possessionIndex of this.possessionIndices(
          ownershipIndex,
          possession,
        )) {
          total += this.record(possessionIndex)!.shares;
        }
      }
    }

    return total;
  }

  enumerate(
    assetBytes: Uint8Array,
    ownershipSelectionBytes: Uint8Array,
    possessionSelectionBytes: Uint8Array,
    kind: number,
  ): AssetEntry[] {
    const asset = Asset.wrap(assetBytes);
    const ownership = parseSelect(ownershipSelectionBytes);
    const possession = parseSelect(possessionSelectionBytes);
    const issuanceIndex = this.issuanceIndex(
      asset.issuer,
      asset.assetName & 0xffffffffffffffn,
    );

    if (issuanceIndex === NO_ASSET_INDEX) {
      return [];
    }

    const entries: AssetEntry[] = [];

    for (const ownershipIndex of this.ownershipIndices(
      issuanceIndex,
      ownership,
    )) {
      const ownershipRecord = this.record(ownershipIndex)!;

      if (kind === 0) {
        entries.push({
          owner: ownershipRecord.publicKey,
          possessor: ownershipRecord.publicKey,
          shares: ownershipRecord.shares,
          ownMgmt: ownershipRecord.mgmt,
          posMgmt: 0,
        });
        continue;
      }

      for (const possessionIndex of this.possessionIndices(
        ownershipIndex,
        possession,
      )) {
        const possessionRecord = this.record(possessionIndex)!;
        entries.push({
          owner: ownershipRecord.publicKey,
          possessor: possessionRecord.publicKey,
          shares: possessionRecord.shares,
          ownMgmt: ownershipRecord.mgmt,
          posMgmt: possessionRecord.mgmt,
        });
      }
    }

    return entries;
  }

  possessionsOf(issuer: Uint8Array, name: bigint): AssetEntry[] {
    const issuanceIndex = this.issuanceIndex(
      issuer,
      name & 0xffffffffffffffn,
    );
    if (issuanceIndex === NO_ASSET_INDEX) {
      return [];
    }

    const entries: AssetEntry[] = [];

    for (const ownershipIndex of this.ownershipIndices(
      issuanceIndex,
      ANY_SELECT,
    )) {
      const ownership = this.record(ownershipIndex)!;

      for (const possessionIndex of this.possessionIndices(
        ownershipIndex,
        ANY_SELECT,
      )) {
        const possession = this.record(possessionIndex)!;
        entries.push({
          owner: ownership.publicKey,
          possessor: possession.publicKey,
          shares: possession.shares,
          ownMgmt: ownership.mgmt,
          posMgmt: possession.mgmt,
        });
      }
    }

    return entries;
  }

  numberOfPossessedShares(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    ownershipManager: number,
    possessionManager: number,
  ): bigint {
    const issuanceIndex = this.issuanceIndex(
      issuer,
      name & 0xffffffffffffffn,
    );
    if (issuanceIndex === NO_ASSET_INDEX) {
      return 0n;
    }

    let ownershipIndex = this.startOf(owner);

    for (;;) {
      const record = this.record(ownershipIndex);
      if (!record) {
        return 0n;
      }

      if (
        record.type === OWNERSHIP &&
        record.crossRef === issuanceIndex &&
        this.idEq(record.publicKey, owner) &&
        record.mgmt === ownershipManager
      ) {
        break;
      }

      ownershipIndex = (ownershipIndex + 1) & ASSET_INDEX_MASK;
    }

    let possessionIndex = this.startOf(possessor);

    for (;;) {
      const record = this.record(possessionIndex);
      if (!record) {
        return 0n;
      }

      if (
        record.type === POSSESSION &&
        record.crossRef === ownershipIndex &&
        this.idEq(record.publicKey, possessor) &&
        record.mgmt === possessionManager
      ) {
        return record.shares;
      }

      possessionIndex = (possessionIndex + 1) & ASSET_INDEX_MASK;
    }
  }

  private transferOwnershipAndPossessionIdx(
    sourceOwnershipIndex: number,
    sourcePossessionIndex: number,
    destination: Uint8Array,
    shares: bigint,
  ): boolean {
    if (shares <= 0n) {
      return false;
    }

    const sourceOwnership = this.record(sourceOwnershipIndex);
    const sourcePossession = this.record(sourcePossessionIndex);
    if (
      !sourceOwnership ||
      sourceOwnership.type !== OWNERSHIP ||
      sourceOwnership.shares < shares ||
      !sourcePossession ||
      sourcePossession.type !== POSSESSION ||
      sourcePossession.shares < shares ||
      sourcePossession.crossRef !== sourceOwnershipIndex
    ) {
      return false;
    }

    if (this.isZeroId(destination)) {
      const issuance = this.record(sourceOwnership.crossRef)!;
      if (this.isZeroId(issuance.publicKey)) {
        return false;
      }

      sourceOwnership.shares -= shares;
      sourcePossession.shares -= shares;
      this.markDirty(sourceOwnershipIndex);
      this.markDirty(sourcePossessionIndex);

      return true;
    }

    let destinationOwnershipIndex = this.startOf(destination);

    for (;;) {
      const destinationOwnership = this.record(
        destinationOwnershipIndex,
      );
      if (
        !destinationOwnership ||
        (destinationOwnership.type === OWNERSHIP &&
          destinationOwnership.mgmt === sourceOwnership.mgmt &&
          destinationOwnership.crossRef ===
            sourceOwnership.crossRef &&
          this.idEq(destinationOwnership.publicKey, destination))
      ) {
        break;
      }

      destinationOwnershipIndex =
        (destinationOwnershipIndex + 1) & ASSET_INDEX_MASK;
    }

    sourceOwnership.shares -= shares;
    const destinationOwnership = this.record(
      destinationOwnershipIndex,
    );
    if (!destinationOwnership) {
      this.setRecord(destinationOwnershipIndex, {
        type: OWNERSHIP,
        publicKey: destination.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: sourceOwnership.mgmt,
        crossRef: sourceOwnership.crossRef,
        shares,
      });
      this.addOwnership(
        sourceOwnership.crossRef,
        destinationOwnershipIndex,
      );
    } else {
      destinationOwnership.shares += shares;
    }

    let destinationPossessionIndex = this.startOf(destination);

    for (;;) {
      const destinationPossession = this.record(
        destinationPossessionIndex,
      );
      if (
        !destinationPossession ||
        (destinationPossession.type === POSSESSION &&
          destinationPossession.mgmt === sourcePossession.mgmt &&
          destinationPossession.crossRef ===
            destinationOwnershipIndex &&
          this.idEq(destinationPossession.publicKey, destination))
      ) {
        break;
      }

      destinationPossessionIndex =
        (destinationPossessionIndex + 1) & ASSET_INDEX_MASK;
    }

    sourcePossession.shares -= shares;
    const destinationPossession = this.record(
      destinationPossessionIndex,
    );
    if (!destinationPossession) {
      this.setRecord(destinationPossessionIndex, {
        type: POSSESSION,
        publicKey: destination.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: sourcePossession.mgmt,
        crossRef: destinationOwnershipIndex,
        shares,
      });
      this.addPossession(
        destinationOwnershipIndex,
        destinationPossessionIndex,
      );
    } else {
      destinationPossession.shares += shares;
    }

    this.markDirty(sourceOwnershipIndex);
    this.markDirty(sourcePossessionIndex);
    this.markDirty(destinationOwnershipIndex);
    this.markDirty(destinationPossessionIndex);

    return true;
  }

  transferShareOwnershipAndPossession(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    newOwner: Uint8Array,
  ): bigint {
    if (shares <= 0n || shares > MAX_AMOUNT) {
      return -(MAX_AMOUNT + 1n);
    }

    const issuanceIndex = this.issuanceIndex(
      issuer,
      name & 0xffffffffffffffn,
    );
    if (issuanceIndex === NO_ASSET_INDEX) {
      return -shares;
    }

    let ownershipIndex = this.startOf(owner);

    for (;;) {
      const record = this.record(ownershipIndex);
      if (!record) {
        return -shares;
      }

      if (
        record.type === OWNERSHIP &&
        record.crossRef === issuanceIndex &&
        this.idEq(record.publicKey, owner) &&
        record.mgmt === slot
      ) {
        break;
      }

      ownershipIndex = (ownershipIndex + 1) & ASSET_INDEX_MASK;
    }

    let possessionIndex = this.startOf(possessor);

    for (;;) {
      const possession = this.record(possessionIndex);
      if (!possession) {
        return -shares;
      }

      if (
        possession.type === POSSESSION &&
        possession.crossRef === ownershipIndex &&
        this.idEq(possession.publicKey, possessor)
      ) {
        if (possession.mgmt !== slot) {
          return -shares;
        }
        if (possession.shares < shares) {
          return possession.shares - shares;
        }

        const transferred = this.transferOwnershipAndPossessionIdx(
          ownershipIndex,
          possessionIndex,
          newOwner,
          shares,
        );
        if (!transferred) {
          return INVALID_AMOUNT;
        }

        return possession.shares;
      }

      possessionIndex = (possessionIndex + 1) & ASSET_INDEX_MASK;
    }
  }

  private transferManagementRightsIdx(
    sourceOwnershipIndex: number,
    sourcePossessionIndex: number,
    destinationOwnershipManager: number,
    destinationPossessionManager: number,
    shares: bigint,
  ): boolean {
    const sourceOwnership = this.record(sourceOwnershipIndex);
    const sourcePossession = this.record(sourcePossessionIndex);

    if (
      !sourceOwnership ||
      sourceOwnership.type !== OWNERSHIP ||
      sourceOwnership.shares < shares ||
      !sourcePossession ||
      sourcePossession.type !== POSSESSION ||
      sourcePossession.shares < shares ||
      sourcePossession.crossRef !== sourceOwnershipIndex
    ) {
      return false;
    }

    let destinationOwnershipIndex = this.startOf(
      sourceOwnership.publicKey,
    );

    for (;;) {
      const destinationOwnership = this.record(
        destinationOwnershipIndex,
      );
      if (
        !destinationOwnership ||
        (destinationOwnership.type === OWNERSHIP &&
          destinationOwnership.mgmt === destinationOwnershipManager &&
          destinationOwnership.crossRef ===
            sourceOwnership.crossRef &&
          this.idEq(
            destinationOwnership.publicKey,
            sourceOwnership.publicKey,
          ))
      ) {
        break;
      }

      destinationOwnershipIndex =
        (destinationOwnershipIndex + 1) & ASSET_INDEX_MASK;
    }

    sourceOwnership.shares -= shares;
    const destinationOwnership = this.record(
      destinationOwnershipIndex,
    );
    if (!destinationOwnership) {
      this.setRecord(destinationOwnershipIndex, {
        type: OWNERSHIP,
        publicKey: sourceOwnership.publicKey.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: destinationOwnershipManager,
        crossRef: sourceOwnership.crossRef,
        shares,
      });
      this.addOwnership(
        sourceOwnership.crossRef,
        destinationOwnershipIndex,
      );
    } else {
      destinationOwnership.shares += shares;
    }

    let destinationPossessionIndex = this.startOf(
      sourcePossession.publicKey,
    );

    for (;;) {
      const destinationPossession = this.record(
        destinationPossessionIndex,
      );
      if (
        !destinationPossession ||
        (destinationPossession.type === POSSESSION &&
          destinationPossession.mgmt === destinationPossessionManager &&
          destinationPossession.crossRef ===
            destinationOwnershipIndex &&
          this.idEq(
            destinationPossession.publicKey,
            sourcePossession.publicKey,
          ))
      ) {
        break;
      }

      destinationPossessionIndex =
        (destinationPossessionIndex + 1) & ASSET_INDEX_MASK;
    }

    sourcePossession.shares -= shares;
    const destinationPossession = this.record(
      destinationPossessionIndex,
    );
    if (!destinationPossession) {
      this.setRecord(destinationPossessionIndex, {
        type: POSSESSION,
        publicKey: sourcePossession.publicKey.slice(0, 32),
        name: 0n,
        decimals: 0,
        unit: 0n,
        mgmt: destinationPossessionManager,
        crossRef: destinationOwnershipIndex,
        shares,
      });
      this.addPossession(
        destinationOwnershipIndex,
        destinationPossessionIndex,
      );
    } else {
      destinationPossession.shares += shares;
    }

    this.markDirty(sourceOwnershipIndex);
    this.markDirty(sourcePossessionIndex);
    this.markDirty(destinationOwnershipIndex);
    this.markDirty(destinationPossessionIndex);

    return true;
  }

  transferShareManagementRights(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    sourceManager: number,
    destinationManager: number,
    shares: bigint,
  ): boolean {
    if (shares <= 0n) {
      return false;
    }

    const issuanceIndex = this.issuanceIndex(
      issuer,
      name & 0xffffffffffffffn,
    );
    if (issuanceIndex === NO_ASSET_INDEX) {
      return false;
    }

    for (const ownershipIndex of this.ownershipIndices(issuanceIndex, {
      id: owner,
      mgmt: sourceManager,
      anyId: false,
      anyMgmt: false,
    })) {
      const possessionSelection = {
        id: possessor,
        mgmt: sourceManager,
        anyId: false,
        anyMgmt: false,
      };

      for (const possessionIndex of this.possessionIndices(
        ownershipIndex,
        possessionSelection,
      )) {
        return this.transferManagementRightsIdx(
          ownershipIndex,
          possessionIndex,
          destinationManager,
          destinationManager,
          shares,
        );
      }
    }

    return false;
  }

  assetUniverse(): AssetSnapshot[] {
    const assets: AssetSnapshot[] = [];

    for (
      let issuanceIndex = this.firstIssuanceIndex;
      issuanceIndex !== NO_ASSET_INDEX;
      issuanceIndex =
        this.nextIndex.get(issuanceIndex) ?? NO_ASSET_INDEX
    ) {
      const issuance = this.record(issuanceIndex)!;
      let totalShares = 0n;
      const holdings: AssetSnapshot["holdings"] = [];

      for (const ownershipIndex of this.ownershipIndices(
        issuanceIndex,
        ANY_SELECT,
      )) {
        const ownership = this.record(ownershipIndex)!;
        totalShares += ownership.shares;

        for (const possessionIndex of this.possessionIndices(
          ownershipIndex,
          ANY_SELECT,
        )) {
          const possession = this.record(possessionIndex)!;
          holdings.push({
            owner: toHex(ownership.publicKey),
            possessor: toHex(possession.publicKey),
            ownMgmt: ownership.mgmt,
            posMgmt: possession.mgmt,
            shares: possession.shares.toString(),
          });
        }
      }

      assets.push({
        issuer: toHex(issuance.publicKey),
        name: assetNameToString(issuance.name),
        decimals: issuance.decimals,
        unit: issuance.unit.toString(),
        totalShares: totalShares.toString(),
        holdings,
      });
    }

    return assets;
  }

  private recordBytes(index: number): Uint8Array {
    const ledgerRecord = this.record(index);
    const wireRecord = AssetRecord.alloc();

    if (!ledgerRecord) {
      return wireRecord.bytes;
    }

    wireRecord.publicKey = ledgerRecord.publicKey;
    wireRecord.type = ledgerRecord.type;

    if (ledgerRecord.type === ISSUANCE) {
      let remainingName = ledgerRecord.name;
      const nameBytes = wireRecord.name;

      for (let byteIndex = 0; byteIndex < 7; byteIndex++) {
        nameBytes[byteIndex] = Number(remainingName & 0xffn);
        remainingName >>= 8n;
      }

      wireRecord.numberOfDecimalPlaces = ledgerRecord.decimals;
      let remainingUnit = ledgerRecord.unit;
      const unitBytes = wireRecord.unitOfMeasurement;

      for (let byteIndex = 0; byteIndex < 7; byteIndex++) {
        unitBytes[byteIndex] = Number(remainingUnit & 0xffn);
        remainingUnit >>= 8n;
      }
    } else {
      wireRecord.managingContractIndex = ledgerRecord.mgmt;
      wireRecord.issuanceIndex = ledgerRecord.crossRef;
      wireRecord.numberOfShares = ledgerRecord.shares;
    }

    return wireRecord.bytes;
  }

  getUniverseDigest(): Uint8Array {
    if (!this.tree) {
      const emptyRecordDigest = k12Bytes(
        new Uint8Array(ASSET_RECORD_SIZE),
      );
      this.tree = new SparseMerkle(emptyRecordDigest);
    }

    for (const index of this.dirty) {
      this.tree.setLeaf(index, k12Bytes(this.recordBytes(index)));
    }

    this.dirty.clear();
    return this.tree.root();
  }

  universeProofOwned(ownerId: Uint8Array): OwnedProof[] {
    this.getUniverseDigest();
    const proofs: OwnedProof[] = [];

    for (
      let issuanceIndex = this.firstIssuanceIndex;
      issuanceIndex !== NO_ASSET_INDEX;
      issuanceIndex =
        this.nextIndex.get(issuanceIndex) ?? NO_ASSET_INDEX
    ) {
      const issuance = this.record(issuanceIndex)!;

      for (const ownershipIndex of this.ownershipIndices(
        issuanceIndex,
        ANY_SELECT,
      )) {
        const ownership = this.record(ownershipIndex)!;
        if (!this.idEq(ownership.publicKey, ownerId)) {
          continue;
        }

        proofs.push({
          record: this.recordBytes(ownershipIndex),
          issuer: issuance.publicKey,
          name: issuance.name,
          decimals: issuance.decimals,
          managingContractIndex: ownership.mgmt,
          shares: ownership.shares,
          index: ownershipIndex,
          siblings: this.tree!.siblings(ownershipIndex),
        });
      }
    }

    return proofs;
  }

  universeProofPossessed(possessorId: Uint8Array): PossessedProof[] {
    this.getUniverseDigest();
    const proofs: PossessedProof[] = [];

    for (
      let issuanceIndex = this.firstIssuanceIndex;
      issuanceIndex !== NO_ASSET_INDEX;
      issuanceIndex =
        this.nextIndex.get(issuanceIndex) ?? NO_ASSET_INDEX
    ) {
      const issuance = this.record(issuanceIndex)!;

      for (const ownershipIndex of this.ownershipIndices(
        issuanceIndex,
        ANY_SELECT,
      )) {
        const ownership = this.record(ownershipIndex)!;

        for (const possessionIndex of this.possessionIndices(
          ownershipIndex,
          ANY_SELECT,
        )) {
          const possession = this.record(possessionIndex)!;
          if (!this.idEq(possession.publicKey, possessorId)) {
            continue;
          }

          proofs.push({
            record: this.recordBytes(possessionIndex),
            owner: ownership.publicKey,
            issuer: issuance.publicKey,
            name: issuance.name,
            decimals: issuance.decimals,
            managingContractIndex: possession.mgmt,
            shares: possession.shares,
            index: possessionIndex,
            siblings: this.tree!.siblings(possessionIndex),
          });
        }
      }
    }

    return proofs;
  }
}
