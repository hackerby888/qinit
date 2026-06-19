// Layer 2 — chain-sim. Drives contracts + a single-authority testnet: deploy/registry, tick/epoch, the
// lifecycle sweep, the money model (spectrum of Entity records, invocationReward, transfer/burn,
// POST_INCOMING_TRANSFER), assets, and the faithful transaction dispatcher (applyTx) — a SC procedure call is
// just a tx to the contract address with inputType=procId + payload, exactly like qubic.cpp
// processTickTransaction. Mirrors core-lite qpi_spectrum_impl.h / qpi_asset_impl.h.
import { Contract, Entity, HostServices, KIND, SP } from "./runtime";
import { toHex } from "./k12";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)
const EP_USER_PROCEDURE = 11; // contract_def.h USER_PROCEDURE_CALL (contractSystemProcedureCount=10, +1)
const ZERO32 = new Uint8Array(32);
const NUMBER_OF_COMPUTORS = 8; // testnet dynamic-contracts committee (consensus-irrelevant for the dev sim)

// qpi.h TransferType
const TT_STANDARD = 0;
const TT_PROCEDURE = 1;
const TT_QPI = 2;
const TT_PROCEDURE_BY_OTHER_CONTRACT = 6;

const EP_USER_FUNCTION = 12; // contract_def.h USER_FUNCTION_CALL (contractSystemProcedureCount=10, +2)
const MAX_CALL_DEPTH = 10; // NUMBER_OF_CONTRACT_EXECUTION_BUFFERS (recursion-depth guard)
const EMPTY = new Uint8Array(0);

// InterContractCallError (qpi.h:68-75) — the codes liteCallFunction/liteInvokeProcedure return.
const CALL_ERR_NONE = 0;
const CALL_ERR_ALLOC = 3;
const CALL_ERR_INACTIVE = 4;

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

export interface TxRecord {
  txId: string;
  tick: number;
  source: string; // hex id
  dest: string; // hex id
  amount: bigint;
  inputType: number;
  moneyFlew: boolean;
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
  private spectrum = new Map<string, Entity>(); // hex(id) -> Entity (balance = incoming - outgoing)
  private pitDepth = 0; // POST_INCOMING_TRANSFER reentrancy guard
  private assets = new Map<string, AssetRec>(); // universe: assetKey -> issuance + holdings
  private txByTick = new Map<number, TxRecord[]>();
  private txById = new Map<string, TxRecord>();
  private callDepth = 0; // inter-contract nesting depth

  constructor() {
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      markDirty: (slot) => this.dirty.add(slot),
      log: () => {},
      transfer: (slot, dest, amount, type) => this.doTransfer(slot, dest, amount, type),
      burn: (slot, amount) => this.doBurn(slot, amount),
      getEntity: (id) => this.entityOf(id),
      issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) => this.doIssueAsset(slot, name, issuer, decimals, shares, unit, invocator),
      isAssetIssued: (issuer, name) => (this.findAsset(issuer, name) ? 1 : 0),
      numberOfShares: (asset, ownSel, posSel) => this.doNumberOfShares(asset, ownSel, posSel),
      numberOfPossessedShares: (name, issuer, owner, possessor, ownMgmt, posMgmt) => this.doNumberOfPossessedShares(name, issuer, owner, possessor, ownMgmt, posMgmt),
      transferShares: (slot, name, issuer, owner, possessor, shares, newOwner) => this.doTransferShares(slot, name, issuer, owner, possessor, shares, newOwner),
      distributeDividends: (slot, amountPerShare) => this.doDistributeDividends(slot, amountPerShare),
      callFunction: (callerSlot, calleeIdx, inputType, input, originator) => this.doCallFunction(callerSlot, calleeIdx, inputType, input, originator),
      invokeProcedure: (callerSlot, calleeIdx, inputType, input, reward, originator) => this.doInvokeProcedure(callerSlot, calleeIdx, inputType, input, reward, originator),
    };
  }

  // ---- spectrum (Entity records; balance = incomingAmount - outgoingAmount) ----
  private contractId(slot: number): Uint8Array {
    const a = new Uint8Array(32);
    new DataView(a.buffer).setBigUint64(0, BigInt(slot), true);
    return a;
  }

  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }

  private emptyEntity(): Entity {
    return { incomingAmount: 0n, outgoingAmount: 0n, numberOfIncomingTransfers: 0, numberOfOutgoingTransfers: 0, latestIncomingTransferTick: 0, latestOutgoingTransferTick: 0 };
  }

  entityOf(id: Uint8Array): Entity | null {
    return this.spectrum.get(this.key(id)) ?? null;
  }

  balance(id: Uint8Array): bigint {
    const e = this.spectrum.get(this.key(id));
    return e ? e.incomingAmount - e.outgoingAmount : 0n;
  }

  balanceOf(slot: number): bigint {
    return this.balance(this.contractId(slot));
  }

  credit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    const k = this.key(id);
    let e = this.spectrum.get(k);
    if (!e) {
      e = this.emptyEntity();
      this.spectrum.set(k, e);
    }

    e.incomingAmount += amount;
    e.numberOfIncomingTransfers++;
    e.latestIncomingTransferTick = tick;
  }

  debit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    const k = this.key(id);
    let e = this.spectrum.get(k);
    if (!e) {
      e = this.emptyEntity();
      this.spectrum.set(k, e);
    }

    e.outgoingAmount += amount;
    e.numberOfOutgoingTransfers++;
    e.latestOutgoingTransferTick = tick;
  }

  // Faucet: seed an identity with balance (the in-process testnet pre-funds test/seed accounts).
  fund(id: Uint8Array, amount: bigint): void {
    this.credit(id, amount, this.tickN);
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

    this.debit(cur, amount);
    this.credit(dest, amount);
    this.notifyPIT(dest, cur, amount, type);

    return remaining;
  }

  private doBurn(slot: number, amount: bigint): bigint {
    if (amount < 0n || amount > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const cur = this.contractId(slot);
    const remaining = this.balance(cur) - amount;
    if (remaining < 0n) return remaining;

    this.debit(cur, amount);

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

    this.debit(cur, total);

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

  // Run a user procedure: POST_INCOMING_TRANSFER (procedureTransaction) if reward>0, then the procedure.
  // Does NOT credit — the caller (procedure() or applyTx()) has already moved the reward into the contract.
  private runProcedure(slot: number, it: number, input: Uint8Array, invocator: Uint8Array, originator: Uint8Array, reward: bigint, transferType = TT_PROCEDURE): Uint8Array {
    const c = this.contracts.get(slot)!;
    if (reward > 0n) this.notifyPIT(this.contractId(slot), invocator, reward, transferType);

    return c.invoke(KIND.PROCEDURE, it, input, { invocator, originator, invocationReward: reward, entryPoint: EP_USER_PROCEDURE });
  }

  // Inter-contract function call (liteCallFunction) — route to whatever Contract is at calleeIdx (a user
  // contract or a wasm-deployed system contract; no native/wasm distinction). Returns the
  // InterContractCallError + the callee's output bytes.
  doCallFunction(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, originator: Uint8Array): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIdx);
    if (!callee) return { error: CALL_ERR_INACTIVE, output: EMPTY };
    if (calleeIdx >= callerSlot) return { error: CALL_ERR_INACTIVE, output: EMPTY }; // lower-index rule
    if (this.callDepth >= MAX_CALL_DEPTH) return { error: CALL_ERR_ALLOC, output: EMPTY };

    this.callDepth++;
    try {
      const invocator = this.contractId(callerSlot);
      const output = callee.invoke(KIND.FUNCTION, inputType, input, { invocator, originator, invocationReward: 0n, entryPoint: EP_USER_FUNCTION });
      return { error: CALL_ERR_NONE, output };
    } finally {
      this.callDepth--;
    }
  }

  // Inter-contract procedure invocation (liteInvokeProcedure) — transfer the reward (caller contract -> callee
  // contract), then run the callee procedure (fires its POST_INCOMING_TRANSFER, procedureInvocationByOtherContract).
  doInvokeProcedure(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, reward: bigint, originator: Uint8Array): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIdx);
    if (!callee) return { error: CALL_ERR_INACTIVE, output: EMPTY };
    if (calleeIdx >= callerSlot) return { error: CALL_ERR_INACTIVE, output: EMPTY };
    if (this.callDepth >= MAX_CALL_DEPTH) return { error: CALL_ERR_ALLOC, output: EMPTY };

    let r = reward;
    if (r > 0n) {
      const callerCid = this.contractId(callerSlot);
      if (this.balance(callerCid) >= r) {
        this.debit(callerCid, r);
        this.credit(this.contractId(calleeIdx), r);
      } else {
        r = 0n; // insufficient — the node sets the reward to 0
      }
    }

    this.callDepth++;
    try {
      const invocator = this.contractId(callerSlot);
      const output = this.runProcedure(calleeIdx, inputType, input, invocator, originator, r, TT_PROCEDURE_BY_OTHER_CONTRACT);
      return { error: CALL_ERR_NONE, output };
    } finally {
      this.callDepth--;
    }
  }

  // Direct procedure call (IDE/tests convenience): credit the reward, then run. The canonical on-chain path is
  // applyTx (a tx to the contract address); this is the same effect without building a tx.
  procedure(slot: number, it: number, input?: Uint8Array, opts: ProcedureOpts = {}): Uint8Array {
    const reward = opts.reward ?? 0n;
    const invocator = opts.invocator ?? ZERO32;
    const originator = opts.originator ?? invocator;

    if (reward > 0n) this.credit(this.contractId(slot), reward);

    return this.runProcedure(slot, it, input ?? new Uint8Array(0), invocator, originator, reward);
  }

  // The faithful transaction dispatcher (qubic.cpp processTickTransaction). A SC procedure call is a tx to the
  // contract address with inputType=procId + payload; a plain transfer is any other (dest=user, or dest=contract
  // with a non-procedure inputType). Money moves first (debit source, credit dest), then routing by dest+type.
  applyTx(source: Uint8Array, dest: Uint8Array, amount: bigint, inputType: number, payload: Uint8Array, txId: string): { moneyFlew: boolean } {
    const tick = this.tickN;
    let moneyFlew = false;

    if (amount > 0n && this.balance(source) >= amount) {
      this.debit(source, amount, tick);
      this.credit(dest, amount, tick);
      moneyFlew = true;
    }
    const reward = moneyFlew ? amount : 0n;

    const slot = this.contractSlotOf(dest);
    if (slot >= 0) {
      const c = this.contracts.get(slot)!;
      const isProcedure = c.entries.some((e) => e.kind === KIND.PROCEDURE && e.it === inputType);

      if (isProcedure) {
        this.runProcedure(slot, inputType, payload, source, source, reward);
      } else if (reward > 0n) {
        this.notifyPIT(dest, source, reward, TT_STANDARD); // plain incoming transfer to a contract
      }
    }
    // dest is a plain user identity: the debit/credit above is the whole transfer.

    this.recordTx({ txId, tick, source: this.key(source), dest: this.key(dest), amount, inputType, moneyFlew });
    return { moneyFlew };
  }

  // ---- tickdata (lite: per-tick tx history + tx-by-id) ----
  private recordTx(r: TxRecord): void {
    let list = this.txByTick.get(r.tick);
    if (!list) {
      list = [];
      this.txByTick.set(r.tick, list);
    }

    list.push(r);
    this.txById.set(r.txId, r);
  }

  tickTransactions(tick: number): TxRecord[] {
    return this.txByTick.get(tick) ?? [];
  }

  txByHash(txId: string): TxRecord | undefined {
    return this.txById.get(txId);
  }

  digest(slot: number): string {
    return this.contracts.get(slot)!.digest();
  }
}
