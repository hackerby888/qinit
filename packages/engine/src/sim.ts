// Layer 2 — chain-sim. Drives contracts + a single-authority testnet: deploy/registry, tick/epoch, the
// lifecycle sweep, the money model (spectrum of Entity records, invocationReward, transfer/burn,
// POST_INCOMING_TRANSFER), assets, and the faithful transaction dispatcher (applyTx) — a SC procedure call is
// just a tx to the contract address with inputType=procId + payload, exactly like qubic.cpp
// processTickTransaction. Mirrors core-lite qpi_spectrum_impl.h / qpi_asset_impl.h.
import { Contract, Entity, HostServices, KIND, SP } from "./runtime";
import { toHex, verifySync } from "./k12";
import { TraceRecorder } from "./trace";
import { Committee, type CommitteeOpts } from "./consensus";
import { FeeManager, type FeeMode } from "./fees";
import { SpectrumLedger } from "./spectrum";
import { OracleManager } from "./oracle";
import { AssetLedger, packAssetName, type AssetSnapshot } from "./assets";
import { TickConsensus, type TickRecord } from "./ticking";
import type { TickData } from "./wire";
import { PreManagementRightsTransferInput, PreManagementRightsTransferOutput, PostIncomingTransferInput, ContractId } from "./abi";
import { TxPool, type TxRecord } from "./txs";
import { ContractRegistry, K12_MAX_LEAF_BYTES } from "./registry";
import type { LogSink, LogLevel } from "./log";
import type { NativeLogger } from "./native-logger";
import { LOG_SC_BEGIN_EPOCH, LOG_SC_BEGIN_TICK, LOG_SC_END_EPOCH, LOG_SC_END_TICK, LOG_SC_INITIALIZE } from "./native-logger";
import type { DebugTrace } from "@qinit/core";

export type { AssetSnapshot };
export type { FeeMode } from "./fees";
export type { TickRecord } from "./ticking";
export type { TxRecord } from "./txs";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)
const EP_USER_PROCEDURE = 11; // contract_def.h USER_PROCEDURE_CALL (contractSystemProcedureCount=10, +1)
const ZERO32 = new Uint8Array(32);
const IPO_SHARE_COUNT = 676; // NUMBER_OF_COMPUTORS — a contract's IPO shares: one per computor (0..675)
const IPO_SHARE_PRICE = 1000000n; // default IPO price per share (Qu)

// qpi.h TransferType
const TT_STANDARD = 0;
const TT_PROCEDURE = 1;
const TT_QPI = 2;
const TT_DIVIDENDS = 3; // qpiDistributeDividends
const TT_PROCEDURE_BY_OTHER_CONTRACT = 6;

const EP_USER_FUNCTION = 12; // contract_def.h USER_FUNCTION_CALL (contractSystemProcedureCount=10, +2)
const MAX_CALL_DEPTH = 10; // NUMBER_OF_CONTRACT_EXECUTION_BUFFERS (recursion-depth guard)
const EMPTY = new Uint8Array(0);

// InterContractCallError (qpi.h:68-75) — the codes liteCallFunction/liteInvokeProcedure return.
const CALL_ERR_NONE = 0;
const CALL_ERR_INSUFFICIENT_FEES = 2; // CallErrorInsufficientFees — callee has no execution-fee reserve
const CALL_ERR_ALLOC = 3;
const CALL_ERR_INACTIVE = 4;

// Execution-fee model (core-lite doc/execution_fees.md, opt-in via `new Sim({ fees: "metered" })`); the reserve
// accounting itself lives in FeeManager (fees.ts).
const CONTRACT_COUNT = 1024; // MAX_NUMBER_OF_CONTRACTS — valid contract indices are 1..1023

const INVALID_PROPOSAL_INDEX = 0xffff; // qpi.h:1847 — setShareholderProposal's error sentinel

export interface ProcedureOpts {
  invocator?: Uint8Array; // 32-byte id of the caller (tx source)
  originator?: Uint8Array; // 32-byte id of the root initiator
  reward?: bigint; // invocationReward (Qu sent with the tx)
}



export class Sim {
  tickN = 0;
  epochN = 0;
  epochLength = 3000; // TESTNET_EPOCH_DURATION (core public_settings.h) — epoch switches when the tick crosses a multiple
  host: HostServices;
  onLog?: LogSink; // diagnostic log stream — a host (the IDE) subscribes; unset = no-op (see log.ts)
  private registry: ContractRegistry; // deployed contracts (instances + state) + deploy/fire + the computer digest
  private spectrum = new SpectrumLedger(); // entity balance records + the spectrum merkle (spectrumDigest)
  private oracle: OracleManager; // oracle queries + subscriptions (the query/reply are opaque bytes)
  private pitDepth = 0; // POST_INCOMING_TRANSFER reentrancy guard
  private assets = new AssetLedger({ contractId: (slot) => this.contractId(slot) }); // the asset universe + merkle
  private txpool = new TxPool(); // per-tick tx history + tx-by-id index + the mempool
  private tickTxCount = 0; // txs in the current tick (qpi numberOfTickTransactions); set at beginTick from the mempool batch
  private callDepth = 0; // inter-contract nesting depth
  private recorder = new TraceRecorder(); // debug-trace capture (opt-in via setDebug)
  private ticking: TickConsensus; // committee + per-tick quorum votes/TickData + the prev*Digest roots
  tickDuration = 50; // ms/tick surfaced to clients; set by the server to match its auto-tick interval
  timeBaseMs = Date.UTC(2024, 0, 1); // chain clock origin (tick 0); the chain clock = timeBaseMs + tick*tickDuration
  private mempoolMode: boolean; // when true, broadcast txs are deferred to their scheduled tick (opt-in)
  private fees: FeeManager; // per-contract execution-fee reserves + the fee-mode policy
  private nativeLogger?: NativeLogger;
  private computorOverride = new Map<number, Uint8Array>(); // test seam: qpi.computor(i) overrides (gtest harness)
  prevSpectrumDigestOverride?: Uint8Array; // test seam: corpus-pinned digest (native harness's etalonTick.prevSpectrumDigest)

  constructor(opts: { consensus?: CommitteeOpts; mempool?: boolean; fees?: FeeMode; defaultReserve?: bigint; liteTicking?: boolean; nativeLogger?: NativeLogger } = {}) {
    this.mempoolMode = opts.mempool ?? false;
    this.fees = new FeeManager(opts.fees ?? "off", opts.defaultReserve);
    this.nativeLogger = opts.nativeLogger;
    this.registry = new ContractRegistry(this.fees, this.recorder);
    this.ticking = new TickConsensus(
      {
        spectrumDigest: () => this.spectrumDigest(),
        universeDigest: () => this.universeDigest(),
        computerDigest: () => this.computerDigest(),
        tickTransactionDigests: (tick) => this.tickTransactions(tick).map((r) => r.digest),
        nowMs: () => this.nowMs(),
        tick: () => this.tickN,
        epoch: () => this.epochN,
      },
      opts.consensus ?? {},
      opts.liteTicking ?? false,
    );
    this.oracle = new OracleManager({
      contractBalance: (slot) => this.balance(this.contractId(slot)),
      debitContract: (slot, amount) => this.debit(this.contractId(slot), amount),
      notify: (slot, procId, input) => {
        const self = this.contractId(slot);
        this.runProcedure(slot, procId, input, self, self, 0n);
      },
      nowMs: () => this.nowMs(),
    });
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      nowMs: () => this.nowMs(),
      numberOfTickTransactions: () => this.tickTxCount,
      markDirty: (slot) => this.dirty.add(slot),
      log: (slot, level, msg) => {
        this.recorder.log(level, msg);
        this.nativeLogger?.log(slot, level, msg, this.epochN);
      },
      pauseLog: () => this.nativeLogger?.pause(),
      resumeLog: () => this.nativeLogger?.resume(),
      transfer: (slot, dest, amount, type) => this.doTransfer(slot, dest, amount, type),
      burn: (slot, amount, burnedFor) => this.doBurn(slot, amount, burnedFor),
      getEntity: (id) => this.entityOf(id),
      queryFeeReserve: (callerSlot, ci) => this.fees.queryFeeReserve(callerSlot, ci),
      issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) => this.assets.issueAsset(slot, name, issuer, decimals, shares, unit, invocator),
      isAssetIssued: (issuer, name) => (this.assets.isAssetIssued(issuer, name) ? 1 : 0),
      numberOfShares: (asset, ownSel, posSel) => this.assets.numberOfShares(asset, ownSel, posSel),
      numberOfPossessedShares: (name, issuer, owner, possessor, ownMgmt, posMgmt) => this.assets.numberOfPossessedShares(name, issuer, owner, possessor, ownMgmt, posMgmt),
      assetEnumerate: (asset, ownSel, posSel, kind) => this.assets.enumerate(asset, ownSel, posSel, kind),
      transferShares: (slot, name, issuer, owner, possessor, shares, newOwner) => this.assets.transferShareOwnershipAndPossession(slot, name, issuer, owner, possessor, shares, newOwner),
      acquireShares: (slot, name, issuer, owner, possessor, shares, srcOwnMgmt, srcPosMgmt, fee) => this.acquireShares(slot, name, issuer, owner, possessor, shares, srcOwnMgmt, srcPosMgmt, fee),
      releaseShares: (slot, name, issuer, owner, possessor, shares, dstOwnMgmt, dstPosMgmt, fee) => this.releaseShares(slot, name, issuer, owner, possessor, shares, dstOwnMgmt, dstPosMgmt, fee),
      dayOfWeek: (year, month, day) => (new Date(Date.UTC(2000 + year, month - 1, day)).getUTCDay() + 4) % 7, // qubic dayOfWeek: 0 = Wednesday
      signatureValidity: (entity, digest, signature) => (verifySync(entity, digest, signature) ? 1 : 0),
      bidInIPO: () => -1n, // the default IPO is already finalized (the 676 shares are held by the computors)
      ipoBidId: (_ci, i) => (i >= 0 && i < IPO_SHARE_COUNT ? this.ticking.getCommittee().computors[i % this.ticking.committeeSize()].publicKey : ZERO32),
      ipoBidPrice: (_ci, i) => (i >= 0 && i < IPO_SHARE_COUNT ? IPO_SHARE_PRICE : -3n), // -3 = invalid bid index (qpi.h)
      computeMiningFunction: () => ZERO32, // mining is not modeled in the dev engine
      initMiningSeed: () => {},
      getOracleQueryStatus: (queryId) => this.oracle.queryStatus(queryId),
      unsubscribeOracle: (sub) => this.oracle.unsubscribe(sub),
      queryOracle: (slot, ifaceIdx, query, procId, timeout, fee) => this.oracle.query(slot, ifaceIdx, query, procId, timeout, fee, -1),
      subscribeOracle: (slot, ifaceIdx, query, procId, period, notifyPrev, fee) => this.oracle.subscribe(slot, ifaceIdx, query, procId, period, notifyPrev, fee),
      getOracleQuery: (queryId) => this.oracle.getQuery(queryId),
      getOracleReply: (queryId) => this.oracle.getReply(queryId),
      isContractId: (id) => (this.contractSlotOf(id) >= 0 ? 1 : 0),
      arbitrator: () => this.ticking.getCommittee().arbitrator.publicKey,
      computor: (i) => this.computorOverride.get(i >>> 0) ?? this.ticking.getCommittee().computors[i % this.ticking.committeeSize()]?.publicKey ?? ZERO32,
      prevSpectrumDigest: () => this.prevSpectrumDigestOverride ?? this.ticking.prevSpectrumDigest(),
      prevUniverseDigest: () => this.ticking.prevUniverseDigest(),
      prevComputerDigest: () => this.ticking.prevComputerDigest(),
      distributeDividends: (slot, amountPerShare) => this.doDistributeDividends(slot, amountPerShare),
      callFunction: (callerSlot, calleeIdx, inputType, input, originator) => this.doCallFunction(callerSlot, calleeIdx, inputType, input, originator),
      invokeProcedure: (callerSlot, calleeIdx, inputType, input, reward, originator) => this.doInvokeProcedure(callerSlot, calleeIdx, inputType, input, reward, originator),
      nextId: (id) => this.nextId(id),
      prevId: (id) => this.prevId(id),
      setShareholderProposal: (callerSlot, calleeIdx, proposal, reward, originator) => this.doSetShareholderProposal(callerSlot, calleeIdx, proposal, reward, originator),
      setShareholderVotes: (callerSlot, calleeIdx, vote, reward, originator) => this.doSetShareholderVotes(callerSlot, calleeIdx, vote, reward, originator),
    };
  }

  // ---- execution fees (FeeManager owns the reserve accounting; these stay on the façade for the public API) ----
  // The current reserve of a contract (Contract-0's contractFeeReserves[index]); 0 if never funded.
  feeReserveOf(slot: number): bigint {
    return this.fees.getReserve(slot);
  }

  // Set a contract's reserve directly (tests / IDE faucet). A positive value clears any prior IPO-failed mark.
  setFeeReserve(slot: number, amount: bigint): void {
    this.fees.setReserve(slot, amount);
  }

  // Model the IPO outcome that seeds the reserve: finalPrice > 0 funds it to finalPrice * 676; finalPrice 0 is a
  // failed IPO — the contract is marked failed, its reserve stays 0, and burning can no longer refill it.
  ipo(slot: number, finalPrice: bigint): void {
    this.fees.ipo(slot, finalPrice);
  }

  // The deployed contracts + the per-tick dirty set live in ContractRegistry; exposed for the transport/peer
  // layers that read the slot map (e.g. registry size, per-slot lookups).
  get contracts(): Map<number, Contract> {
    return this.registry.contracts;
  }

  get dirty(): Set<number> {
    return this.registry.dirty;
  }

  // ---- spectrum (the ledger lives in SpectrumLedger; these stay on the façade for the public API) ----
  contractId(slot: number): Uint8Array {
    const id = ContractId.alloc();
    id.lane0 = BigInt(slot); // id(slot,0,0,0)
    return id.bytes;
  }

  private key(id: Uint8Array): string {
    return toHex(id.subarray(0, 32));
  }

  entityOf(id: Uint8Array): Entity | null {
    return this.spectrum.entityOf(id);
  }

  balance(id: Uint8Array): bigint {
    return this.spectrum.energy(id);
  }

  balanceOf(slot: number): bigint {
    return this.balance(this.contractId(slot));
  }

  credit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    this.spectrum.increaseEnergy(id, amount, tick);
  }

  debit(id: Uint8Array, amount: bigint, tick = this.tickN): void {
    this.spectrum.decreaseEnergy(id, amount, tick);
  }

  // Faucet: seed an identity with balance (the in-process testnet pre-funds test/seed accounts).
  fund(id: Uint8Array, amount: bigint): void {
    this.spectrum.increaseEnergy(id, amount, this.tickN);
  }

  // Test helper (core's notifyContractOfIncomingTransfer): MOVE `amount` from source to dest, then fire dest's
  // POST_INCOMING_TRANSFER callback — a full inbound transfer the corpus wants the contract to react to. The
  // move must debit the source: if the handler refunds (as RL does), crediting dest without debiting source
  // would leave the sender doubled.
  notifyIncomingTransfer(source: Uint8Array, dest: Uint8Array, amount: bigint, type: number): void {
    this.spectrum.decreaseEnergy(source, amount, this.tickN);
    this.spectrum.increaseEnergy(dest, amount, this.tickN);
    this.notifyPIT(dest, source, amount, type);
  }

  // gtest seam: override qpi.computor(i) so a corpus that seeds its own committee (the proposal-voting
  // contracts write broadcastedComputors.computors.publicKeys[i]) gets the same identities back from the
  // engine — otherwise the contract's proposer-is-a-computor check never matches. A zero key clears the
  // override (falls back to the real committee).
  setComputorKey(index: number, key: Uint8Array): void {
    if (key.every((b) => b === 0)) {
      this.computorOverride.delete(index >>> 0);
    } else {
      this.computorOverride.set(index >>> 0, key.slice(0, 32));
    }
  }

  // Wipe the ledger back to genesis (empty spectrum + empty universe) without touching deployed instances —
  // gtest isolation: each test starts from a clean balance/asset state. The deployed contract's own StateData
  // is reset separately (zeroState + INITIALIZE). Used only by the gtest runner (gtest.ts).
  resetLedger(): void {
    this.spectrum = new SpectrumLedger();
    this.assets = new AssetLedger({ contractId: (slot) => this.contractId(slot) });
  }

  // Spectrum iteration (qpi.nextId/prevId) — the next/previous occupied entity id; zero if none.
  nextId(id: Uint8Array): Uint8Array {
    return this.spectrum.nextId(id);
  }

  prevId(id: Uint8Array): Uint8Array {
    return this.spectrum.prevId(id);
  }

  // The slot index if `id` is a deployed contract's id (id(slot,0,0,0)), else -1.
  private contractSlotOf(id: Uint8Array): number {
    const c = ContractId.wrap(id);
    if (c.lane1 !== 0n || c.lane2 !== 0n || c.lane3 !== 0n) return -1; // upper lanes set ⇒ a regular entity, not a contract

    const slot = Number(c.lane0);
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

  // qpi.burn(amount, burnedFor): burn the caller's QU and credit it to a contract's execution-fee reserve. The
  // target is `burnedFor` when it's a valid index, else the caller itself (qpi.h burn). A failed-IPO target
  // can't be refilled. When fees are off the burn still debits balance (existing behaviour) but tracks no reserve.
  private doBurn(slot: number, amount: bigint, burnedFor: number): bigint {
    if (amount < 0n || amount > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const target = burnedFor < 1 || burnedFor >= CONTRACT_COUNT ? slot : burnedFor;
    if (this.fees.metered && this.fees.isFailed(target)) return -amount;

    const cur = this.contractId(slot);
    const remaining = this.balance(cur) - amount;
    if (remaining < 0n) return remaining;

    this.debit(cur, amount);
    if (this.fees.metered) this.fees.add(target, amount);

    return remaining;
  }

  // ---- share management rights / custody (qpi_asset_impl.h acquireShares / releaseShares). The asset ledger
  // lives in AssetLedger; acquire/release stay here because they weave the spectrum + a contract callback. ----
  private idEq(a: Uint8Array, b: Uint8Array): boolean {
    for (let i = 0; i < 32; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // The low-level management-rights move (AssetLedger owns it); kept on the façade for the public API.
  transferShareManagementRights(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, srcMgmt: number, dstMgmt: number, shares: bigint): boolean {
    return this.assets.transferShareManagementRights(name, issuer, owner, possessor, srcMgmt, dstMgmt, shares);
  }

  // Run a management-rights-transfer approval callback (PRE/POST_RELEASE/ACQUIRE_SHARES) on the other managing
  // contract. An absent callback denies the transfer (the node zeroes the output, so allowTransfer is false).
  private runManagementCallback(targetSlot: number, spId: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, fee: bigint, otherSlot: number): { allow: boolean; fee: bigint } {
    const c = this.contracts.get(targetSlot);
    if (!c || !c.hasSysproc(spId)) {
      return { allow: false, fee: 0n };
    }

    const req = PreManagementRightsTransferInput.alloc();
    req.asset.issuer = issuer;
    req.asset.assetName = name;
    req.owner = owner;
    req.possessor = possessor;
    req.shares = shares;
    req.offeredFee = fee;
    req.otherContractIndex = otherSlot;

    const out = this.registry.fire(c, KIND.SYSPROC, spId, req.bytes, { entryPoint: spId });
    const reply = PreManagementRightsTransferOutput.wrap(out);
    const allow = out.length >= 1 && reply.allowTransfer !== 0;
    const reqFee = out.length >= 16 ? reply.requestedFee : 0n;
    return { allow, fee: reqFee };
  }

  // qpi.acquireShares — the calling contract takes management rights of (owner,possessor)'s shares currently
  // managed by srcMgmt. The source managing contract approves via PRE_RELEASE_SHARES (and may charge a fee);
  // on success the shares become managed by callerSlot. Returns the paid fee (>= 0), -requestedFee if the
  // offered fee / balance is insufficient, INVALID_AMOUNT on any other error.
  acquireShares(callerSlot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, srcOwnMgmt: number, srcPosMgmt: number, offeredFee: bigint): bigint {
    if (!this.idEq(owner, possessor) || srcOwnMgmt !== srcPosMgmt) {
      return INVALID_AMOUNT;
    }
    if (srcPosMgmt === callerSlot || srcPosMgmt < 1 || srcPosMgmt >= CONTRACT_COUNT || shares <= 0n || offeredFee < 0n) {
      return INVALID_AMOUNT;
    }
    if (this.assets.numberOfPossessedShares(name, issuer, owner, possessor, srcPosMgmt, srcPosMgmt) < shares) {
      return INVALID_AMOUNT;
    }

    const cb = this.runManagementCallback(srcOwnMgmt, SP.PRE_RELEASE_SHARES, name, issuer, owner, possessor, shares, offeredFee, callerSlot);
    if (!cb.allow || cb.fee < 0n || cb.fee > MAX_AMOUNT) {
      return INVALID_AMOUNT;
    }
    if (cb.fee > offeredFee) {
      return -cb.fee;
    }

    if (cb.fee > 0n) {
      // the fee is a real qpi transfer to the releasing contract — its POST_INCOMING_TRANSFER fires
      if (this.doTransfer(callerSlot, this.contractId(srcOwnMgmt), cb.fee, TT_QPI) < 0n) {
        return -cb.fee;
      }
    }

    if (!this.transferShareManagementRights(name, issuer, owner, possessor, srcPosMgmt, callerSlot, shares)) {
      return INVALID_AMOUNT;
    }

    this.runManagementCallback(srcOwnMgmt, SP.POST_RELEASE_SHARES, name, issuer, owner, possessor, shares, cb.fee, callerSlot);
    return cb.fee;
  }

  // qpi.releaseShares — the calling contract (the current manager) releases management rights of the shares to
  // dstMgmt, which approves via PRE_ACQUIRE_SHARES. Mirror of acquireShares.
  releaseShares(callerSlot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, dstOwnMgmt: number, dstPosMgmt: number, offeredFee: bigint): bigint {
    if (!this.idEq(owner, possessor) || dstOwnMgmt !== dstPosMgmt) {
      return INVALID_AMOUNT;
    }
    if (dstPosMgmt === callerSlot || dstPosMgmt < 1 || dstPosMgmt >= CONTRACT_COUNT || shares <= 0n || offeredFee < 0n) {
      return INVALID_AMOUNT;
    }
    if (this.assets.numberOfPossessedShares(name, issuer, owner, possessor, callerSlot, callerSlot) < shares) {
      return INVALID_AMOUNT;
    }

    const cb = this.runManagementCallback(dstOwnMgmt, SP.PRE_ACQUIRE_SHARES, name, issuer, owner, possessor, shares, offeredFee, callerSlot);
    if (!cb.allow || cb.fee < 0n || cb.fee > MAX_AMOUNT) {
      return INVALID_AMOUNT;
    }
    if (cb.fee > offeredFee) {
      return -cb.fee;
    }

    if (cb.fee > 0n) {
      // the fee is a real qpi transfer to the acquiring contract — its POST_INCOMING_TRANSFER fires
      if (this.doTransfer(callerSlot, this.contractId(dstOwnMgmt), cb.fee, TT_QPI) < 0n) {
        return -cb.fee;
      }
    }

    if (!this.transferShareManagementRights(name, issuer, owner, possessor, callerSlot, dstPosMgmt, shares)) {
      return INVALID_AMOUNT;
    }

    this.runManagementCallback(dstOwnMgmt, SP.POST_ACQUIRE_SHARES, name, issuer, owner, possessor, shares, cb.fee, callerSlot);
    return cb.fee;
  }

  // distributeDividends (qpi_asset_impl.h): deduct amountPerShare * 676 from the contract up front, then pay
  // amountPerShare per share to every POSSESSOR of the contract's own share asset (issuer = zero id, name =
  // the contract's ticker), firing each contract receiver's POST_INCOMING_TRANSFER (type qpiDistributeDividends,
  // source = the contract id) nested mid-iteration. If fewer than 676 shares exist in the universe the
  // difference stays deducted (the node's post-IPO invariant is exactly 676 shares — see registerContractAsset).
  // Forbidden inside a POST_INCOMING_TRANSFER callback.
  private doDistributeDividends(slot: number, amountPerShare: bigint): number {
    if (this.pitDepth > 0) return 0; // forbidden inside POST_INCOMING_TRANSFER
    if (amountPerShare < 0n || amountPerShare * BigInt(IPO_SHARE_COUNT) > MAX_AMOUNT) return 0;

    const total = amountPerShare * BigInt(IPO_SHARE_COUNT);
    const cur = this.contractId(slot);
    if (this.balance(cur) < total) return 0;

    this.debit(cur, total);
    if (amountPerShare === 0n) {
      return 1;
    }

    const name = this.contractAssetNames.get(slot);
    if (name === undefined) return 1; // no share asset registered — nothing to pay (the deduction stands, like a shareless universe)

    for (const p of this.assets.possessionsOf(ZERO32, name)) {
      if (p.shares === 0n) continue;
      const dividend = amountPerShare * p.shares;
      this.credit(p.possessor, dividend);
      this.notifyPIT(p.possessor, cur, dividend, TT_DIVIDENDS);
    }

    return 1;
  }

  // The contract's share-asset name (its ticker, packed ASCII) — what distributeDividends iterates. System
  // contracts get it from contract_def.h's contractDescriptions (the gtest harness passes the catalog);
  // dynamic contracts get it at deploy.
  private contractAssetNames = new Map<number, bigint>();

  setContractAssetName(slot: number, name: bigint | string): void {
    this.contractAssetNames.set(slot, typeof name === "string" ? packAssetName(name) : name & 0xffffffffffffffn);
  }

  // Dev-deploy stand-in for the IPO: mint the contract's 676 shares (issuer = zero id) to `holder`, managed
  // by QX — mirrors the node's post-IPO state with the deployer standing in for the IPO winners. No-op if
  // the share asset already exists (redeploy).
  mintDeployShares(slot: number, name: bigint | string, holder: Uint8Array): void {
    const packed = typeof name === "string" ? packAssetName(name) : name & 0xffffffffffffffn;
    this.setContractAssetName(slot, packed);
    if (this.assets.isAssetIssued(ZERO32, packed)) return;

    this.assets.mintContractShares(1, packed, BigInt(IPO_SHARE_COUNT)); // minted to the zero-id holder, managed by QX
    this.assets.transferShareOwnershipAndPossession(1, packed, ZERO32, ZERO32, ZERO32, BigInt(IPO_SHARE_COUNT), holder);
  }

  // Read-only snapshot of the asset universe for inspection tools (AssetLedger owns it).
  assetUniverse(): AssetSnapshot[] {
    return this.assets.assetUniverse();
  }

  // Fire the dest contract's POST_INCOMING_TRANSFER callback (nested, synchronous), if registered.
  private notifyPIT(dest: Uint8Array, source: Uint8Array, amount: bigint, type: number): void {
    const slot = this.contractSlotOf(dest);
    if (slot < 0) return;

    const c = this.contracts.get(slot)!;
    if (!c.hasSysproc(SP.POST_INCOMING_TRANSFER)) return;

    const notice = PostIncomingTransferInput.alloc();
    notice.source = source;
    notice.amount = amount;
    notice.type = type;
    const input = notice.bytes;

    // POST_INCOMING_TRANSFER is a system-initiated callback: exempt from the fee gate (it runs even on a
    // dormant contract so it can receive transfers) but still metered, since a state change costs the digest.
    this.pitDepth++;
    try {
      this.registry.fire(c, KIND.SYSPROC, SP.POST_INCOMING_TRANSFER, input, { entryPoint: SP.POST_INCOMING_TRANSFER });
    } finally {
      this.pitDepth--;
    }
  }

  // Deploy + construct (ContractRegistry owns the instances); stays on the façade for the public API.
  deploy(slot: number, wasm: Uint8Array, extMem?: WebAssembly.Memory): Contract {
    this.nativeLogger?.begin(this.tickN, LOG_SC_INITIALIZE);
    let c: Contract;
    try {
      c = this.registry.deploy(slot, wasm, this.host, extMem);
    } finally {
      this.nativeLogger?.end();
    }
    this.emit("info", "deploy", `slot ${slot} deployed · ${(wasm.length / 1024) | 0}KB wasm`);
    if (c.stateSize > K12_MAX_LEAF_BYTES) {
      // A mainnet-sized state (e.g. QX ~600 MB) can't be K12-hashed, so it gets a zero computer-digest leaf
      // (see ContractRegistry.computerDigest). Surface it once here rather than silently every tick.
      this.emit("warn", "digest", `slot ${slot} state ${(c.stateSize / 1048576) | 0}MB > ${K12_MAX_LEAF_BYTES / 1048576}MB — excluded from computer digest (zero leaf)`);
    }
    return c;
  }

  // Private test-runner hook: production contracts never receive engine-specific imports.
  deployWithImports(slot: number, wasm: Uint8Array, imports: WebAssembly.Imports): Contract {
    this.nativeLogger?.begin(this.tickN, LOG_SC_INITIALIZE);
    try {
      return this.registry.deploy(slot, wasm, this.host, undefined, imports);
    } finally {
      this.nativeLogger?.end();
    }
  }

  undeploy(slot: number): boolean {
    const ok = this.registry.undeploy(slot);
    if (ok) this.emit("info", "deploy", `slot ${slot} undeployed`);
    return ok;
  }

  // Debug tracing — wired to the node's /dev/debug + /debug-trace RPC by the transport.
  setDebug(on: boolean): void {
    this.recorder.setEnabled(on);
  }

  getTrace(): DebugTrace {
    return this.recorder.trace();
  }

  // Emit a diagnostic log event to the subscribed sink (the IDE's engine-log popup). No-op when unset, so the
  // per-tick debug events cost only the message build when nobody is listening.
  private emit(level: LogLevel, cat: string, msg: string): void {
    this.onLog?.({ level, tick: this.tickN, cat, msg });
  }

  // Epoch-boundary sysprocs are exempt from the fee gate (execution_fees.md): they run even on a depleted
  // reserve to keep contract state valid.
  beginEpoch(): void {
    this.nativeLogger?.begin(this.tickN, LOG_SC_BEGIN_EPOCH);
    try {
      for (const s of this.registry.slots(true)) {
        const c = this.contracts.get(s)!;
        if (c.hasSysproc(SP.BEGIN_EPOCH)) this.registry.fire(c, KIND.SYSPROC, SP.BEGIN_EPOCH, new Uint8Array(0), { entryPoint: SP.BEGIN_EPOCH });
      }
    } finally { this.nativeLogger?.end(); }
  }

  endEpoch(): void {
    this.nativeLogger?.begin(this.tickN, LOG_SC_END_EPOCH);
    try {
      for (const s of this.registry.slots(false)) {
        const c = this.contracts.get(s)!;
        if (c.hasSysproc(SP.END_EPOCH)) this.registry.fire(c, KIND.SYSPROC, SP.END_EPOCH, new Uint8Array(0), { entryPoint: SP.END_EPOCH });
      }
    } finally { this.nativeLogger?.end(); }
  }

  // BEGIN_TICK / END_TICK are gated: a metered contract with a non-positive reserve is skipped (dormant) until
  // it is refilled.
  beginTick(): void {
    this.tickN++;
    this.tickTxCount = this.txpool.dueCount(this.tickN); // the tick's tx-set size, fixed before BEGIN_TICK (core-lite numberTickTransactions)
    this.emit("debug", "tick", `tick ${this.tickN} begin · ${this.tickTxCount} tx`);

    this.nativeLogger?.begin(this.tickN, LOG_SC_BEGIN_TICK);
    try {
      for (const s of this.registry.slots(true)) {
        // BEGIN_TICK: ascending 1->N
        const c = this.contracts.get(s)!;
        if (c.hasSysproc(SP.BEGIN_TICK) && this.fees.reserveOk(s)) this.registry.fire(c, KIND.SYSPROC, SP.BEGIN_TICK, new Uint8Array(0), { entryPoint: SP.BEGIN_TICK });
      }
    } finally { this.nativeLogger?.end(); }
  }

  endTick(): void {
    this.nativeLogger?.begin(this.tickN, LOG_SC_END_TICK);
    try {
      for (const s of this.registry.slots(false)) {
        // END_TICK: descending N->1
        const c = this.contracts.get(s)!;
        if (c.hasSysproc(SP.END_TICK) && this.fees.reserveOk(s)) this.registry.fire(c, KIND.SYSPROC, SP.END_TICK, new Uint8Array(0), { entryPoint: SP.END_TICK });
      }
    } finally { this.nativeLogger?.end(); }
    this.emit("debug", "tick", `tick ${this.tickN} end`);
  }

  // Advance one tick. When the new tick reaches an epoch boundary (a multiple of epochLength) the chain
  // switches epoch first — END_EPOCH of the closing epoch, epoch++, then BEGIN_EPOCH of the new one (core's
  // SystemProcedureID order) — before this tick's BEGIN_TICK/END_TICK run. This is how the live network
  // fires the epoch lifecycle; deploy still runs only INITIALIZE, so a contract's first BEGIN_EPOCH lands at
  // the next boundary (mirroring construction mid-epoch on the node).
  advance(): void {
    const nextTick = this.tickN + 1;
    if (this.epochLength > 0 && nextTick % this.epochLength === 0) {
      this.endEpoch();
      this.epochN++;
      this.beginEpoch();
      this.emit("info", "epoch", `epoch ${this.epochN - 1} → ${this.epochN}`);
    }
    this.beginTick();
    this.drainMempool();
    this.oracle.pump();
    this.endTick();
    this.ticking.finalizeTick();
    this.nativeLogger?.finalizeTick(this.tickN);
  }

  query(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.FUNCTION, it, input);
  }

  // Run a user procedure: POST_INCOMING_TRANSFER (procedureTransaction) if reward>0, then the procedure.
  // Does NOT credit — the caller (procedure() or applyTx()) has already moved the reward into the contract.
  private runProcedure(slot: number, it: number, input: Uint8Array, invocator: Uint8Array, originator: Uint8Array, reward: bigint, transferType = TT_PROCEDURE): Uint8Array {
    const c = this.contracts.get(slot)!;
    if (reward > 0n) this.notifyPIT(this.contractId(slot), invocator, reward, transferType);

    return this.registry.fire(c, KIND.PROCEDURE, it, input, { invocator, originator, invocationReward: reward, entryPoint: EP_USER_PROCEDURE });
  }

  // ---- oracle (OracleManager owns the queries/subscriptions; these stay on the façade for the public API) ----

  // Public resolve seam: the dev/test (or a node-mode oracle-machine adapter) supplies a query's reply, which
  // sets it SUCCESS and fires the contract's notification procedure. False for an unknown queryId.
  resolveOracle(queryId: bigint, reply: Uint8Array, status?: number): boolean {
    return status === undefined ? this.oracle.resolve(queryId, reply) : this.oracle.resolve(queryId, reply, status);
  }

  // PENDING oracle queries (dev/test discovery — the resolve seam's read side).
  pendingOracleQueries(): { queryId: bigint; slot: number; interfaceIndex: number; query: Uint8Array }[] {
    return this.oracle.pending();
  }

  // Register a reply provider (interfaceIndex, query) -> reply | null. Pending queries auto-resolve through it on
  // advance(). This is the mock/browser path; a real oracle-machine fetch plugs in behind this same seam.
  setOracleProvider(fn: ((interfaceIndex: number, query: Uint8Array) => Uint8Array | null) | null): void {
    this.oracle.setProvider(fn);
  }

  // Inter-contract function call (liteCallFunction) — route to whatever Contract is at calleeIdx (a user
  // contract or a wasm-deployed system contract; no native/wasm distinction). Returns the
  // InterContractCallError + the callee's output bytes.
  doCallFunction(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, originator: Uint8Array): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIdx);
    if (!callee) return { error: CALL_ERR_INACTIVE, output: EMPTY };
    if (calleeIdx >= callerSlot) return { error: CALL_ERR_INACTIVE, output: EMPTY }; // lower-index rule
    if (!this.fees.reserveOk(calleeIdx)) return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY }; // callee must have reserve
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
    if (!this.fees.reserveOk(calleeIdx)) return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY }; // callee must have reserve (reward not moved)
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

  private transferReward(callerSlot: number, calleeIdx: number, reward: bigint): void {
    const callerCid = this.contractId(callerSlot);
    if (this.balance(callerCid) < reward) return;

    this.debit(callerCid, reward);
    this.credit(this.contractId(calleeIdx), reward);
  }

  // Shareholder governance (qpi.setShareholderProposal) — invoke the callee's SET_SHAREHOLDER_PROPOSAL sysproc
  // (1024-byte proposal in, uint16 proposal index out). Mirrors contract_exec.h:805.
  doSetShareholderProposal(callerSlot: number, calleeIdx: number, proposal: Uint8Array, reward: bigint, originator: Uint8Array): number {
    if (calleeIdx === callerSlot || calleeIdx === 0 || !this.contracts.has(calleeIdx) || reward < 0n) return INVALID_PROPOSAL_INDEX;
    if (this.callDepth >= MAX_CALL_DEPTH) return INVALID_PROPOSAL_INDEX;

    const callee = this.contracts.get(calleeIdx)!;
    if (!callee.hasSysproc(SP.SET_SHAREHOLDER_PROPOSAL)) return INVALID_PROPOSAL_INDEX;
    if (!this.fees.reserveOk(calleeIdx)) return INVALID_PROPOSAL_INDEX; // dormant callee can't be invoked

    if (reward > 0n) this.transferReward(callerSlot, calleeIdx, reward);

    this.callDepth++;
    try {
      const out = this.registry.fire(callee, KIND.SYSPROC, SP.SET_SHAREHOLDER_PROPOSAL, proposal, { invocator: this.contractId(callerSlot), originator, entryPoint: SP.SET_SHAREHOLDER_PROPOSAL });
      return out.length >= 2 ? new DataView(out.buffer, out.byteOffset, out.byteLength).getUint16(0, true) : 0;
    } finally {
      this.callDepth--;
    }
  }

  // qpi.setShareholderVotes — invoke the callee's SET_SHAREHOLDER_VOTES sysproc; returns the success bit.
  doSetShareholderVotes(callerSlot: number, calleeIdx: number, vote: Uint8Array, reward: bigint, originator: Uint8Array): number {
    if (calleeIdx === callerSlot || calleeIdx === 0 || !this.contracts.has(calleeIdx) || reward < 0n) return 0;
    if (this.callDepth >= MAX_CALL_DEPTH) return 0;

    const callee = this.contracts.get(calleeIdx)!;
    if (!callee.hasSysproc(SP.SET_SHAREHOLDER_VOTES)) return 0;
    if (!this.fees.reserveOk(calleeIdx)) return 0; // dormant callee can't be invoked

    if (reward > 0n) this.transferReward(callerSlot, calleeIdx, reward);

    this.callDepth++;
    try {
      const out = this.registry.fire(callee, KIND.SYSPROC, SP.SET_SHAREHOLDER_VOTES, vote, { invocator: this.contractId(callerSlot), originator, entryPoint: SP.SET_SHAREHOLDER_VOTES });
      return out.length >= 1 ? out[0] : 0;
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

    // A dormant metered contract can't run a user procedure; nothing is credited so there is nothing to refund.
    if (!this.fees.reserveOk(slot)) {
      return EMPTY;
    }

    if (reward > 0n) this.credit(this.contractId(slot), reward);

    return this.runProcedure(slot, it, input ?? new Uint8Array(0), invocator, originator, reward);
  }

  // The faithful transaction dispatcher (qubic.cpp processTickTransaction). A SC procedure call is a tx to the
  // contract address with inputType=procId + payload; a plain transfer is any other (dest=user, or dest=contract
  // with a non-procedure inputType). Money moves first (debit source, credit dest), then routing by dest+type.
  applyTx(source: Uint8Array, dest: Uint8Array, amount: bigint, inputType: number, payload: Uint8Array, txId: string, digest: Uint8Array = ZERO32): { moneyFlew: boolean } {
    const tick = this.tickN;
    const txIndex = this.txpool.tickTransactions(tick).length;
    this.nativeLogger?.begin(tick, txIndex);
    try {
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

      if (isProcedure && !this.fees.reserveOk(slot)) {
        // Dormant contract (no execution-fee reserve): the procedure can't run and any attached amount is
        // refunded to the sender (execution_fees.md — "amounts are refunded if a contract cannot execute").
        if (moneyFlew) {
          this.debit(dest, amount, tick);
          this.credit(source, amount, tick);
          moneyFlew = false;
        }
        this.emit("warn", "fee", `slot ${slot} dormant — procedure it=${inputType} skipped${amount > 0n ? `, refunded ${amount}` : ""}`);
      } else if (isProcedure) {
        // Isolate a faulting procedure (a wasm trap like divide-by-zero, an abort, or a host error). Without this
        // the throw unwinds out of drainMempool and crashes the whole node — one buggy contract tx kills the tick
        // and every later tx in it. Snapshot the contract state and refund the attached amount on failure, so a
        // faulting tx neither persists partial state nor pockets the reward, and the tick still finalizes.
        // (Side effects on OTHER state — a transfer/asset op done before the trap — are not rolled back yet; full
        // cross-state tx atomicity is a separate concern.)
        const stateBefore = c.state().slice();
        try {
          this.runProcedure(slot, inputType, payload, source, source, reward);
        } catch (e) {
          c.writeState(stateBefore);
          if (moneyFlew) {
            this.debit(dest, amount, tick);
            this.credit(source, amount, tick);
            moneyFlew = false;
          }
          this.emit("warn", "tx", `slot ${slot} procedure it=${inputType} trapped: ${String((e as Error)?.message ?? e)}${amount > 0n ? `, refunded ${amount}` : ""}`);
        }
      } else if (reward > 0n) {
        this.notifyPIT(dest, source, reward, TT_STANDARD); // plain incoming transfer to a contract
      }
    }
    // dest is a plain user identity: the debit/credit above is the whole transfer.

    this.emit("info", "tx", `tx → ${slot >= 0 ? `slot ${slot}` : "user"} it=${inputType} amount=${amount} moneyFlew=${moneyFlew}`);
    this.txpool.record({ txId, tick, source: this.key(source), dest: this.key(dest), amount, inputType, moneyFlew, digest });
    return { moneyFlew };
    } finally {
      this.nativeLogger?.end();
    }
  }

  // Submit a broadcast tx. In mempool mode a tx whose scheduled tick is still ahead is held until the chain
  // reaches that tick (drained in advance), so it is recorded under that tick; otherwise — and always when
  // mempool mode is off — it applies immediately at the current tick.
  enqueueTx(scheduledTick: number, source: Uint8Array, dest: Uint8Array, amount: bigint, inputType: number, payload: Uint8Array, txId: string, digest: Uint8Array = ZERO32): { moneyFlew: boolean; queued: boolean } {
    if (!this.mempoolMode || scheduledTick <= this.tickN) {
      const r = this.applyTx(source, dest, amount, inputType, payload, txId, digest);
      return { moneyFlew: r.moneyFlew, queued: false };
    }

    this.txpool.queue(scheduledTick, { source, dest, amount, inputType, payload, txId, digest });
    return { moneyFlew: false, queued: true };
  }

  // Apply the txs scheduled for the current tick (mempool mode), recording them under it.
  private drainMempool(): void {
    for (const t of this.txpool.takeDue(this.tickN)) {
      try {
        this.applyTx(t.source, t.dest, t.amount, t.inputType, t.payload, t.txId, t.digest);
      } catch (e) {
        // Backstop: applyTx already isolates procedure faults; this guards any other unexpected throw so one tx
        // can never abort the tick's remaining txs or crash the node.
        this.emit("warn", "mempool", `tx ${t.txId} dropped: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }

  // ---- tickdata (the per-tick history + tx-by-id live in TxPool; these stay on the façade) ----
  tickTransactions(tick: number): TxRecord[] {
    return this.txpool.tickTransactions(tick);
  }

  txByHash(txId: string): TxRecord | undefined {
    return this.txpool.txByHash(txId);
  }

  digest(slot: number): string {
    return this.registry.digest(slot);
  }

  // ---- tick consensus (TickConsensus owns the committee + votes; these stay on the façade for the public API) ----
  getCommittee(): Committee {
    return this.ticking.getCommittee();
  }

  quorum(): number {
    return this.ticking.quorum();
  }

  // The chain clock (unix ms) at the current tick — deterministic: timeBaseMs + tick * tickDuration. Backs the
  // qpi date/time accessors + the tick-vote timestamp. Set timeBaseMs to wall-clock for a live feel.
  nowMs(): number {
    return this.timeBaseMs + this.tickN * this.tickDuration;
  }

  entityCount(): number {
    return this.spectrum.size;
  }


  txCount(): number {
    return this.txpool.size;
  }

  // computerDigest — the K12 merkle over the contract-state leaves (ContractRegistry owns the contracts).
  computerDigest(): Uint8Array {
    return this.registry.computerDigest();
  }

  // spectrumDigest — the root of the incremental 2^24 merkle over entity records (SpectrumLedger owns the tree).
  spectrumDigest(): Uint8Array {
    return this.spectrum.getSpectrumDigest();
  }

  // universeDigest — the root of the incremental 2^24 merkle over asset holdings (AssetLedger owns the tree).
  universeDigest(): Uint8Array {
    return this.assets.getUniverseDigest();
  }

  // Ownership / possession merkle proofs over the asset universe (AssetLedger owns the tree).
  universeProofOwned(ownerId: Uint8Array) {
    return this.assets.universeProofOwned(ownerId);
  }

  universeProofPossessed(possessorId: Uint8Array) {
    return this.assets.universeProofPossessed(possessorId);
  }

  // The merkle proof for an entity: its leaf index + the 24 sibling hashes from the leaf to the spectrum root.
  // A client recomputes the root from (EntityRecord, index, siblings) and checks it against spectrumDigest.
  spectrumProof(id: Uint8Array): { record: Uint8Array; index: number; siblings: Uint8Array[] } {
    return this.spectrum.spectrumProof(id);
  }

  // The finalized tick's quorum record / signed TickData / aligned-vote count (TickConsensus owns them).
  tickRecord(tick: number): TickRecord | undefined {
    return this.ticking.tickRecord(tick);
  }

  tickData(tick: number): TickData | undefined {
    return this.ticking.tickData(tick);
  }

  alignedVotes(tick = this.tickN): number {
    return this.ticking.alignedVotes(tick);
  }

  // The arbitrator-signed Computors wire list for the current epoch. slotCount pads for the peer-protocol bridge.
  signedComputorList(slotCount?: number): Uint8Array {
    return this.ticking.signedComputorList(slotCount);
  }
}
