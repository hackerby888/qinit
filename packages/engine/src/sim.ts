// Layer 2 — chain-sim. Drives contracts: deploy/registry, tick/epoch, the lifecycle sweep skeleton, and
// (phase 3) the money model — an in-memory spectrum (id -> balance), invocationReward crediting,
// transfer/burn, and the POST_INCOMING_TRANSFER trigger with anti-reentrancy. Mirrors core-lite
// qpi_spectrum_impl.h (__transfer / burn) and qubic.cpp's USER_PROCEDURE_CALL flow.
import { Contract, HostServices, KIND, SP } from "./runtime";
import { toHex } from "./k12";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)
const EP_USER_PROCEDURE = 11; // contract_def.h USER_PROCEDURE_CALL (contractSystemProcedureCount=10, +1)
const ZERO32 = new Uint8Array(32);
const NUMBER_OF_COMPUTORS = 8; // testnet dynamic-contracts committee (consensus-irrelevant for the dev sim)

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

export interface ProcedureOpts {
  invocator?: Uint8Array; // 32-byte id of the caller (tx source)
  originator?: Uint8Array; // 32-byte id of the root initiator
  reward?: bigint; // invocationReward (Qu sent with the tx)
}

export class Sim {
  tickN = 0;
  epochN = 0;
  contracts = new Map<number, Contract>();
  dirty = new Set<number>();
  host: HostServices;
  private ledger = new Map<string, bigint>(); // spectrum: hex(id) -> balance
  private pitDepth = 0; // POST_INCOMING_TRANSFER reentrancy guard
  private assets = new Map<string, AssetRec>(); // universe: assetKey -> issuance + holdings

  constructor() {
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      markDirty: (slot) => this.dirty.add(slot),
      log: () => {},
      transfer: (slot, dest, amount, type) => this.doTransfer(slot, dest, amount, type),
      burn: (slot, amount) => this.doBurn(slot, amount),
      issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) => this.doIssueAsset(slot, name, issuer, decimals, shares, unit, invocator),
      isAssetIssued: (issuer, name) => (this.findAsset(issuer, name) ? 1 : 0),
      numberOfShares: (asset, ownSel, posSel) => this.doNumberOfShares(asset, ownSel, posSel),
      numberOfPossessedShares: (name, issuer, owner, possessor, ownMgmt, posMgmt) => this.doNumberOfPossessedShares(name, issuer, owner, possessor, ownMgmt, posMgmt),
      transferShares: (slot, name, issuer, owner, possessor, shares, newOwner) => this.doTransferShares(slot, name, issuer, owner, possessor, shares, newOwner),
      distributeDividends: (slot, amountPerShare) => this.doDistributeDividends(slot, amountPerShare),
    };
  }

  // ---- ledger ----
  private contractId(slot: number): Uint8Array {
    const a = new Uint8Array(32);
    new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
    return a;
  }
  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }
  balance(id: Uint8Array): bigint {
    return this.ledger.get(this.key(id)) ?? 0n;
  }
  balanceOf(slot: number): bigint {
    return this.balance(this.contractId(slot));
  }
  credit(id: Uint8Array, amount: bigint): void {
    this.ledger.set(this.key(id), this.balance(id) + amount);
  }
  // The slot index if `id` is a deployed contract's id (id(slot,0,0,0)), else -1.
  private contractSlotOf(id: Uint8Array): number {
    const dv = new DataView(id.buffer, id.byteOffset, id.byteLength);
    if (dv.getBigUint64(8, true) !== 0n || dv.getBigUint64(16, true) !== 0n || dv.getBigUint64(24, true) !== 0n) return -1;
    const slot = Number(dv.getBigUint64(0, true));
    return this.contracts.has(slot) ? slot : -1;
  }

  // ---- transfer / burn (mirror qpi_spectrum_impl.h __transfer / burn) ----
  private doTransfer(slot: number, dest: Uint8Array, amount: bigint, type: number): bigint {
    if (this.pitDepth > 0 && this.contractSlotOf(dest) >= 0) return INVALID_AMOUNT; // no transfer-to-contract inside PIT
    if (amount < 0n || amount > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const cur = this.contractId(slot);
    const remaining = this.balance(cur) - amount;
    if (remaining < 0n) return remaining; // insufficient — nothing moves

    this.ledger.set(this.key(cur), remaining);
    this.credit(dest, amount);
    this.notifyPIT(dest, cur, amount, type);

    return remaining;
  }

  private doBurn(slot: number, amount: bigint): bigint {
    if (amount < 0n || amount > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const cur = this.contractId(slot);
    const remaining = this.balance(cur) - amount;
    if (remaining < 0n) return remaining;

    this.ledger.set(this.key(cur), remaining);

    return remaining;
  }

  // ---- assets / shares (mirror qpi_asset_impl.h; assets live in the universe, not the contract digest) ----
  private idEq(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false;
    return true;
  }
  private isZeroId(a: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) if (a[i] !== 0) return false;
    return true;
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

  // issueAsset: validate name (first byte A-Z, <=7 bytes), issuer (== this contract or invocator), shares range.
  // Mint all shares to the issuer (owner + possessor), managed by the issuing contract. Returns shares (0 on fail).
  private doIssueAsset(slot: number, name: bigint, issuer: Uint8Array, decimals: number, shares: bigint, unit: bigint, invocator: Uint8Array): bigint {
    const first = Number(name & 0xffn);
    if (first < 0x41 || first > 0x5a || name > 0xffffffffffffffn) return 0n;
    if (this.isZeroId(issuer) || (!this.idEq(issuer, this.contractId(slot)) && !this.idEq(issuer, invocator))) return 0n;
    if (shares <= 0n || shares > MAX_AMOUNT) return 0n;
    if (unit > 0xffffffffffffffn) return 0n;

    const k = this.assetKey(issuer, name);
    if (this.assets.has(k)) return 0n; // already issued

    const holdings = new Map<string, Holding>();
    holdings.set(this.holdingKey(issuer, issuer, slot, slot), { owner: issuer.slice(0, 32), possessor: issuer.slice(0, 32), ownMgmt: slot, posMgmt: slot, shares });
    this.assets.set(k, { issuer: issuer.slice(0, 32), name, decimals, unit, holdings });

    return shares;
  }

  // numberOfShares(Asset, AssetOwnershipSelect, AssetPossessionSelect) — sum holdings matching the selectors.
  private doNumberOfShares(assetB: Uint8Array, ownSelB: Uint8Array, posSelB: Uint8Array): bigint {
    const adv = new DataView(assetB.buffer, assetB.byteOffset, assetB.byteLength);
    const asset = this.findAsset(assetB.subarray(0, 32), adv.getBigUint64(32, true));
    if (!asset) return 0n;

    const odv = new DataView(ownSelB.buffer, ownSelB.byteOffset, ownSelB.byteLength);
    const pdv = new DataView(posSelB.buffer, posSelB.byteOffset, posSelB.byteLength);
    const ownId = ownSelB.subarray(0, 32), ownMgmt = odv.getUint16(32, true), anyOwner = ownSelB[34] !== 0, anyOwnMgmt = ownSelB[35] !== 0;
    const posId = posSelB.subarray(0, 32), posMgmt = pdv.getUint16(32, true), anyPos = posSelB[34] !== 0, anyPosMgmt = posSelB[35] !== 0;

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

  private doNumberOfPossessedShares(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, ownMgmt: number, posMgmt: number): bigint {
    const asset = this.findAsset(issuer, name);
    if (!asset) return 0n;
    const h = asset.holdings.get(this.holdingKey(owner, possessor, ownMgmt, posMgmt));
    return h ? h.shares : 0n;
  }

  // transferShareOwnershipAndPossession: move shares from (owner,possessor) managed by THIS contract to
  // (newOwner,newOwner). Returns the source's remaining shares; negative on insufficient; -shares if not found.
  private doTransferShares(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, newOwner: Uint8Array): bigint {
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

    return h.shares; // remaining shares of the source possessor
  }

  // Simplified: the in-PIT guard + range + balance (amountPerShare * NUMBER_OF_COMPUTORS) debit. The
  // per-shareholder computor-share payout is consensus-specific and not modeled in the dev sim.
  private doDistributeDividends(slot: number, amountPerShare: bigint): number {
    if (this.pitDepth > 0) return 0; // forbidden inside POST_INCOMING_TRANSFER
    if (amountPerShare < 0n || amountPerShare * BigInt(NUMBER_OF_COMPUTORS) > MAX_AMOUNT) return 0;

    const total = amountPerShare * BigInt(NUMBER_OF_COMPUTORS);
    const cur = this.contractId(slot);
    if (this.balance(cur) < total) return 0;

    this.ledger.set(this.key(cur), this.balance(cur) - total);

    return 1;
  }

  // Fire the dest contract's POST_INCOMING_TRANSFER callback (nested, synchronous), if registered.
  private notifyPIT(dest: Uint8Array, source: Uint8Array, amount: bigint, type: number): void {
    const slot = this.contractSlotOf(dest);
    if (slot < 0) return;

    const c = this.contracts.get(slot)!;
    if (!c.hasSysproc(SP.POST_INCOMING_TRANSFER)) return;

    const input = new Uint8Array(48); // PostIncomingTransfer_input { id(32), sint64(8), uint8(1) }
    input.set(source.subarray(0, 32), 0);
    new DataView(input.buffer).setBigInt64(32, amount, true);
    input[40] = type & 0xff;

    this.pitDepth++;
    try {
      c.invoke(KIND.SYSPROC, SP.POST_INCOMING_TRANSFER, input, { entryPoint: SP.POST_INCOMING_TRANSFER });
    } finally {
      this.pitDepth--;
    }
  }

  private slots(asc: boolean): number[] {
    return [...this.contracts.keys()].sort((a, b) => (asc ? a - b : b - a));
  }

  // Deploy + construct: node zeroes state then runs INITIALIZE (qubic.cpp contractProcessor INITIALIZE).
  deploy(slot: number, wasm: Uint8Array): Contract {
    const c = Contract.load(wasm, slot, this.host);
    this.contracts.set(slot, c);
    c.zeroState();
    if (c.hasSysproc(SP.INITIALIZE)) c.invoke(KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
    return c;
  }

  beginEpoch(): void {
    for (const s of this.slots(true)) {
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.BEGIN_EPOCH)) c.invoke(KIND.SYSPROC, SP.BEGIN_EPOCH, new Uint8Array(0), { entryPoint: SP.BEGIN_EPOCH });
    }
  }

  endEpoch(): void {
    for (const s of this.slots(false)) {
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.END_EPOCH)) c.invoke(KIND.SYSPROC, SP.END_EPOCH, new Uint8Array(0), { entryPoint: SP.END_EPOCH });
    }
  }

  beginTick(): void {
    this.tickN++;
    for (const s of this.slots(true)) {
      // BEGIN_TICK: ascending 1->N
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.BEGIN_TICK)) c.invoke(KIND.SYSPROC, SP.BEGIN_TICK, new Uint8Array(0), { entryPoint: SP.BEGIN_TICK });
    }
  }

  endTick(): void {
    for (const s of this.slots(false)) {
      // END_TICK: descending N->1
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.END_TICK)) c.invoke(KIND.SYSPROC, SP.END_TICK, new Uint8Array(0), { entryPoint: SP.END_TICK });
    }
  }

  query(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.FUNCTION, it, input);
  }

  // Invoke a user procedure. reward>0 credits the contract + fires POST_INCOMING_TRANSFER (procedureTransaction)
  // BEFORE the procedure runs (qubic.cpp contractProcessor USER_PROCEDURE_CALL).
  procedure(slot: number, it: number, input?: Uint8Array, opts: ProcedureOpts = {}): Uint8Array {
    const c = this.contracts.get(slot)!;
    const reward = opts.reward ?? 0n;
    const invocator = opts.invocator ?? ZERO32;
    const originator = opts.originator ?? invocator;

    if (reward > 0n) {
      this.credit(this.contractId(slot), reward);
      this.notifyPIT(this.contractId(slot), invocator, reward, 1 /*procedureTransaction*/);
    }

    return c.invoke(KIND.PROCEDURE, it, input, { invocator, originator, invocationReward: reward, entryPoint: EP_USER_PROCEDURE });
  }

  digest(slot: number): string {
    return this.contracts.get(slot)!.digest();
  }
}
