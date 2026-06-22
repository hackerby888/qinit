// Layer 2 — chain-sim. Drives contracts + a single-authority testnet: deploy/registry, tick/epoch, the
// lifecycle sweep, the money model (spectrum of Entity records, invocationReward, transfer/burn,
// POST_INCOMING_TRANSFER), assets, and the faithful transaction dispatcher (applyTx) — a SC procedure call is
// just a tx to the contract address with inputType=procId + payload, exactly like qubic.cpp
// processTickTransaction. Mirrors core-lite qpi_spectrum_impl.h / qpi_asset_impl.h.
import { Contract, Entity, HostServices, KIND, SP } from "./runtime";
import { toHex, k12Bytes, verifySync } from "./k12";
import { SparseMerkle } from "./merkle";
import { TraceRecorder } from "./trace";
import {
  Committee, type CommitteeOpts, type TickStateDigests,
  buildTickVote, buildTickData, voteIsAligned, merkleRoot,
  DEFAULT_NUMBER_OF_COMPUTORS, MAX_NUMBER_OF_CONTRACTS,
} from "./consensus";
import type { DebugTrace } from "@qinit/core";

const MAX_AMOUNT = 1000000000000000n; // ISSUANCE_RATE(1e12) * 1000 — core-lite network_messages/common_def.h
const INVALID_AMOUNT = -9223372036854775808n; // qpi.h INVALID_AMOUNT (INT64_MIN)
const EP_USER_PROCEDURE = 11; // contract_def.h USER_PROCEDURE_CALL (contractSystemProcedureCount=10, +1)
const ZERO32 = new Uint8Array(32);
const TICK_HISTORY = 2000; // ticks of TickData + quorum records retained (memory bound; each TickData ~41 KB)
const ASSET_RECORD_SIZE = 48; // structs.h AssetRecord (union) — the universe merkle leaf size
const IPO_SHARE_COUNT = 676; // NUMBER_OF_COMPUTORS — a contract's IPO shares: one per computor (0..675)
const IPO_SHARE_PRICE = 1000000n; // default IPO price per share (Qu)

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
const CALL_ERR_INSUFFICIENT_FEES = 2; // CallErrorInsufficientFees — callee has no execution-fee reserve
const CALL_ERR_ALLOC = 3;
const CALL_ERR_INACTIVE = 4;

// Execution-fee model (core-lite doc/execution_fees.md, opt-in via `new Sim({ fees: "metered" })`).
const CONTRACT_COUNT = 1024; // MAX_NUMBER_OF_CONTRACTS — valid contract indices are 1..1023
const IPO_COMPUTORS = 676n; // NUMBER_OF_COMPUTORS — a completed IPO funds the reserve to finalPrice * 676
const DEFAULT_FEE_RESERVE = 1000000000n; // seed reserve a metered deploy gets (a faked successful IPO); override via Sim opts / ipo()

const INVALID_PROPOSAL_INDEX = 0xffff; // qpi.h:1847 — setShareholderProposal's error sentinel

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

export interface TxRecord {
  txId: string;
  tick: number;
  source: string; // hex id
  dest: string; // hex id
  amount: bigint;
  inputType: number;
  moneyFlew: boolean;
  digest: Uint8Array; // K12(full signed tx) — the tick's TickData transactionDigests entry
}

export interface ProcedureOpts {
  invocator?: Uint8Array; // 32-byte id of the caller (tx source)
  originator?: Uint8Array; // 32-byte id of the root initiator
  reward?: bigint; // invocationReward (Qu sent with the tx)
}

// A finalized tick's consensus record: the N computor votes, the aligned-vote count, and the etalon digests
// they committed to. Stored per tick for the quorum-tick / current-tick-info queries.
export interface TickRecord {
  votes: Uint8Array[];
  aligned: number;
  total: number;
  digests: TickStateDigests;
  tickData: Uint8Array; // the leader's signed TickData; the votes commit transaction = K12(tickData)
}

// A broadcast tx awaiting its scheduled tick (mempool mode). Holds the decoded applyTx arguments.
interface QueuedTx {
  source: Uint8Array;
  dest: Uint8Array;
  amount: bigint;
  inputType: number;
  payload: Uint8Array;
  txId: string;
  digest: Uint8Array; // K12(full signed tx)
}

// Execution-fee accounting mode. "off" keeps the original behaviour (every contract always runs, queryFeeReserve
// is a positive constant) so the IDE and existing digests are unchanged. "metered" turns on the fee model:
// per-contract reserves, the cost meter, and the gating from doc/execution_fees.md.
export type FeeMode = "off" | "metered";

export class Sim {
  tickN = 0;
  epochN = 0;
  epochLength = 3000; // TESTNET_EPOCH_DURATION (core public_settings.h) — epoch switches when the tick crosses a multiple
  contracts = new Map<number, Contract>();
  dirty = new Set<number>();
  host: HostServices;
  private spectrum = new Map<string, Entity>(); // hex(id) -> Entity (balance = incoming - outgoing)
  private spectrumTree: SparseMerkle | null = null; // incremental 2^24 merkle; root = spectrumDigest
  private spectrumIdx = new Map<string, number>(); // entity id -> stable leaf index
  private spectrumDirty = new Set<string>(); // entity ids whose leaf changed since the last digest
  private universeTree: SparseMerkle | null = null; // incremental 2^24 merkle; root = universeDigest
  private universeIdx = new Map<string, number>(); // assetKey\0holdingKey -> stable leaf index
  private universeDirty = new Set<string>(); // holdings whose leaf changed since the last digest
  private lastDigests: { spectrum: Uint8Array; universe: Uint8Array; computer: Uint8Array } = { spectrum: ZERO32, universe: ZERO32, computer: ZERO32 }; // previous tick's committed roots (qpi prev*Digest)
  private pitDepth = 0; // POST_INCOMING_TRANSFER reentrancy guard
  private assets = new Map<string, AssetRec>(); // universe: assetKey -> issuance + holdings
  private txByTick = new Map<number, TxRecord[]>();
  private txById = new Map<string, TxRecord>();
  private callDepth = 0; // inter-contract nesting depth
  private recorder = new TraceRecorder(); // debug-trace capture (opt-in via setDebug)
  private consensusOpts: CommitteeOpts; // computor-committee config (always-on quorum consensus)
  private committee: Committee | null = null; // derived lazily on first advance (needs initK12 resolved)
  private ticks = new Map<number, TickRecord>(); // per-tick quorum record: votes + aligned count + digests
  tickDuration = 50; // ms/tick surfaced to clients; set by the server to match its auto-tick interval
  timeBaseMs = Date.UTC(2024, 0, 1); // chain clock origin (tick 0); the chain clock = timeBaseMs + tick*tickDuration
  private mempoolMode: boolean; // when true, broadcast txs are deferred to their scheduled tick (opt-in)
  private mempool = new Map<number, QueuedTx[]>(); // scheduled tick -> txs awaiting that tick
  private feeMode: FeeMode; // "off" (default; IDE behaviour) or "metered" (execution-fee model on)
  private feeReserve = new Map<number, bigint>(); // per-contract executionFeeReserve (Contract-0 contractFeeReserves)
  private feeFailed = new Set<number>(); // contracts whose IPO failed (finalPrice 0) — reserve can't be refilled
  private defaultReserve: bigint; // reserve a metered deploy is seeded with when not explicitly IPO'd / set

  constructor(opts: { consensus?: CommitteeOpts; mempool?: boolean; fees?: FeeMode; defaultReserve?: bigint } = {}) {
    this.consensusOpts = opts.consensus ?? {};
    this.mempoolMode = opts.mempool ?? false;
    this.feeMode = opts.fees ?? "off";
    this.defaultReserve = opts.defaultReserve ?? DEFAULT_FEE_RESERVE;
    this.host = {
      tick: () => this.tickN,
      epoch: () => this.epochN,
      nowMs: () => this.nowMs(),
      markDirty: (slot) => this.dirty.add(slot),
      log: (_slot, level, msg) => this.recorder.log(level, msg),
      transfer: (slot, dest, amount, type) => this.doTransfer(slot, dest, amount, type),
      burn: (slot, amount, burnedFor) => this.doBurn(slot, amount, burnedFor),
      getEntity: (id) => this.entityOf(id),
      queryFeeReserve: (callerSlot, ci) => this.doQueryFeeReserve(callerSlot, ci),
      issueAsset: (slot, name, issuer, decimals, shares, unit, invocator) => this.doIssueAsset(slot, name, issuer, decimals, shares, unit, invocator),
      isAssetIssued: (issuer, name) => (this.findAsset(issuer, name) ? 1 : 0),
      numberOfShares: (asset, ownSel, posSel) => this.doNumberOfShares(asset, ownSel, posSel),
      numberOfPossessedShares: (name, issuer, owner, possessor, ownMgmt, posMgmt) => this.doNumberOfPossessedShares(name, issuer, owner, possessor, ownMgmt, posMgmt),
      transferShares: (slot, name, issuer, owner, possessor, shares, newOwner) => this.doTransferShares(slot, name, issuer, owner, possessor, shares, newOwner),
      acquireShares: (slot, name, issuer, owner, possessor, shares, srcOwnMgmt, srcPosMgmt, fee) => this.acquireShares(slot, name, issuer, owner, possessor, shares, srcOwnMgmt, srcPosMgmt, fee),
      releaseShares: (slot, name, issuer, owner, possessor, shares, dstOwnMgmt, dstPosMgmt, fee) => this.releaseShares(slot, name, issuer, owner, possessor, shares, dstOwnMgmt, dstPosMgmt, fee),
      dayOfWeek: (year, month, day) => (new Date(Date.UTC(2000 + year, month - 1, day)).getUTCDay() + 4) % 7, // qubic dayOfWeek: 0 = Wednesday
      signatureValidity: (entity, digest, signature) => (verifySync(entity, digest, signature) ? 1 : 0),
      bidInIPO: () => -1n, // the default IPO is already finalized (the 676 shares are held by the computors)
      ipoBidId: (_ci, i) => (i >= 0 && i < IPO_SHARE_COUNT ? this.getCommittee().computors[i % this.committeeSize()].publicKey : ZERO32),
      ipoBidPrice: (_ci, i) => (i >= 0 && i < IPO_SHARE_COUNT ? IPO_SHARE_PRICE : -3n), // -3 = invalid bid index (qpi.h)
      computeMiningFunction: () => ZERO32, // mining is not modeled in the dev engine
      initMiningSeed: () => {},
      getOracleQueryStatus: () => 0, // oracle is not modeled — ORACLE_QUERY_STATUS default
      unsubscribeOracle: () => 0,
      isContractId: (id) => (this.contractSlotOf(id) >= 0 ? 1 : 0),
      arbitrator: () => this.getCommittee().arbitrator.publicKey,
      computor: (i) => this.getCommittee().computors[i % this.committeeSize()]?.publicKey ?? ZERO32,
      prevSpectrumDigest: () => this.lastDigests.spectrum,
      prevUniverseDigest: () => this.lastDigests.universe,
      prevComputerDigest: () => this.lastDigests.computer,
      distributeDividends: (slot, amountPerShare) => this.doDistributeDividends(slot, amountPerShare),
      callFunction: (callerSlot, calleeIdx, inputType, input, originator) => this.doCallFunction(callerSlot, calleeIdx, inputType, input, originator),
      invokeProcedure: (callerSlot, calleeIdx, inputType, input, reward, originator) => this.doInvokeProcedure(callerSlot, calleeIdx, inputType, input, reward, originator),
      nextId: (id) => this.nextId(id),
      prevId: (id) => this.prevId(id),
      setShareholderProposal: (callerSlot, calleeIdx, proposal, reward, originator) => this.doSetShareholderProposal(callerSlot, calleeIdx, proposal, reward, originator),
      setShareholderVotes: (callerSlot, calleeIdx, vote, reward, originator) => this.doSetShareholderVotes(callerSlot, calleeIdx, vote, reward, originator),
    };
  }

  // ---- execution fees (core-lite doc/execution_fees.md; the whole block is inert when feeMode === "off") ----
  // The current reserve of a contract (Contract-0's contractFeeReserves[index]); 0 if never funded.
  feeReserveOf(slot: number): bigint {
    return this.feeReserve.get(slot) ?? 0n;
  }

  // Set a contract's reserve directly (tests / IDE faucet). A positive value clears any prior IPO-failed mark.
  setFeeReserve(slot: number, amount: bigint): void {
    this.feeReserve.set(slot, amount);
    if (amount > 0n) {
      this.feeFailed.delete(slot);
    }
  }

  // Model the IPO outcome that seeds the reserve: finalPrice > 0 funds it to finalPrice * 676; finalPrice 0 is a
  // failed IPO — the contract is marked failed, its reserve stays 0, and burning can no longer refill it.
  ipo(slot: number, finalPrice: bigint): void {
    if (finalPrice > 0n) {
      this.feeReserve.set(slot, finalPrice * IPO_COMPUTORS);
      this.feeFailed.delete(slot);
    } else {
      this.feeReserve.set(slot, 0n);
      this.feeFailed.add(slot);
    }
  }

  // The gate the spec checks before fee-bearing entry points: a metered contract must hold a positive reserve.
  // Always true when fees are off.
  private reserveOk(slot: number): boolean {
    return this.feeMode === "off" || (this.feeReserve.get(slot) ?? 0n) > 0n;
  }

  private addFeeReserve(slot: number, amount: bigint): void {
    if (amount <= 0n) {
      return;
    }
    this.feeReserve.set(slot, (this.feeReserve.get(slot) ?? 0n) + amount);
  }

  // Debit a completed call's metered cost. The reserve is a sint64 and may go non-positive — that leaves the
  // contract dormant until refilled (the next reserveOk check fails), matching the spec.
  private subFeeReserve(slot: number, cost: bigint): void {
    if (cost <= 0n) {
      return;
    }
    this.feeReserve.set(slot, (this.feeReserve.get(slot) ?? 0n) - cost);
  }

  // Run a contract entry and, when metered, debit its measured cost from its own reserve. Every Sim-driven
  // procedure / sysproc / callback goes through here; read-only function queries deliberately do not (they are
  // never charged). Re-entrant frames each report their own lastCost, so nested calls are charged correctly.
  private fire(c: Contract, kind: number, it: number, input: Uint8Array, ctx: { invocator?: Uint8Array; originator?: Uint8Array; invocationReward?: bigint; entryPoint?: number }): Uint8Array {
    const out = c.invoke(kind, it, input, ctx);
    if (this.feeMode === "metered") {
      this.subFeeReserve(c.slot, c.lastCost);
    }
    return out;
  }

  // qpi.queryFeeReserve(contractIndex): off => the legacy positive constant; metered => the live reserve, with
  // an out-of-range index resolving to the caller's own contract (qpi_spectrum_impl.h queryFeeReserve).
  private doQueryFeeReserve(callerSlot: number, ci: number): bigint {
    if (this.feeMode === "off") {
      return 1000000n;
    }
    const idx = ci < 1 || ci >= CONTRACT_COUNT ? callerSlot : ci;
    return this.feeReserve.get(idx) ?? 0n;
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
    this.spectrumDirty.add(k);
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
    this.spectrumDirty.add(k);
  }

  // Faucet: seed an identity with balance (the in-process testnet pre-funds test/seed accounts).
  fund(id: Uint8Array, amount: bigint): void {
    this.credit(id, amount, this.tickN);
  }

  // Spectrum iteration (qpi.nextId/prevId) — the next/previous occupied entity id; zero if none. The node
  // walks the spectrum hash array; the dev engine uses a deterministic id order over the occupied entities.
  nextId(id: Uint8Array): Uint8Array {
    const target = this.key(id);
    let best: string | null = null;
    for (const k of this.spectrum.keys()) {
      if (k > target && (best === null || k < best)) best = k;
    }

    return best === null ? new Uint8Array(32) : hexToBytes32(best);
  }

  prevId(id: Uint8Array): Uint8Array {
    const target = this.key(id);
    let best: string | null = null;
    for (const k of this.spectrum.keys()) {
      if (k < target && (best === null || k > best)) best = k;
    }

    return best === null ? new Uint8Array(32) : hexToBytes32(best);
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

  // qpi.burn(amount, burnedFor): burn the caller's QU and credit it to a contract's execution-fee reserve. The
  // target is `burnedFor` when it's a valid index, else the caller itself (qpi.h burn). A failed-IPO target
  // can't be refilled. When fees are off the burn still debits balance (existing behaviour) but tracks no reserve.
  private doBurn(slot: number, amount: bigint, burnedFor: number): bigint {
    if (amount < 0n || amount > MAX_AMOUNT) return -(MAX_AMOUNT + 1n);

    const target = burnedFor < 1 || burnedFor >= CONTRACT_COUNT ? slot : burnedFor;
    if (this.feeMode === "metered" && this.feeFailed.has(target)) return -amount;

    const cur = this.contractId(slot);
    const remaining = this.balance(cur) - amount;
    if (remaining < 0n) return remaining;

    this.debit(cur, amount);
    if (this.feeMode === "metered") this.addFeeReserve(target, amount);

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
    this.markHoldingDirty(k, this.holdingKey(issuer, issuer, slot, slot));

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

    const ak = this.assetKey(issuer, name);
    this.markHoldingDirty(ak, hk);
    this.markHoldingDirty(ak, dk);

    return h.shares; // remaining shares of the source possessor
  }

  // ---- share management rights / custody (qpi_asset_impl.h acquireShares / releaseShares) ----
  // The low-level state move: shares of (owner,possessor) managed by srcMgmt become managed by dstMgmt. Owner and
  // possessor (always equal at the qpi level) are unchanged; only the managing contract changes. Callback-free —
  // the acquire/release wrappers below run the management-rights-transfer approval callbacks.
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

  // Run a management-rights-transfer approval callback (PRE/POST_RELEASE/ACQUIRE_SHARES) on the other managing
  // contract. An absent callback denies the transfer (the node zeroes the output, so allowTransfer is false).
  private runManagementCallback(targetSlot: number, spId: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, fee: bigint, otherSlot: number): { allow: boolean; fee: bigint } {
    const c = this.contracts.get(targetSlot);
    if (!c || !c.hasSysproc(spId)) {
      return { allow: false, fee: 0n };
    }

    const input = new Uint8Array(128); // PreManagementRightsTransfer_input { Asset(40) owner(32) possessor(32) shares(8) offeredFee(8) otherContractIndex(2) }
    const dv = new DataView(input.buffer);
    input.set(issuer.subarray(0, 32), 0); // Asset.issuer
    dv.setBigUint64(32, name, true); // Asset.assetName
    input.set(owner.subarray(0, 32), 40);
    input.set(possessor.subarray(0, 32), 72);
    dv.setBigInt64(104, shares, true);
    dv.setBigInt64(112, fee, true);
    dv.setUint16(120, otherSlot & 0xffff, true);

    const out = this.fire(c, KIND.SYSPROC, spId, input, { entryPoint: spId });
    const odv = new DataView(out.buffer, out.byteOffset, out.byteLength);
    const allow = out.length >= 1 && out[0] !== 0; // PreManagementRightsTransfer_output { bool allowTransfer; sint64 requestedFee }
    const reqFee = out.length >= 16 ? odv.getBigInt64(8, true) : 0n;
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
    if (this.doNumberOfPossessedShares(name, issuer, owner, possessor, srcPosMgmt, srcPosMgmt) < shares) {
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
      const caller = this.contractId(callerSlot);
      if (this.balance(caller) < cb.fee) {
        return -cb.fee;
      }
      this.debit(caller, cb.fee);
      this.credit(this.contractId(srcOwnMgmt), cb.fee);
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
    if (this.doNumberOfPossessedShares(name, issuer, owner, possessor, callerSlot, callerSlot) < shares) {
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
      const caller = this.contractId(callerSlot);
      if (this.balance(caller) < cb.fee) {
        return -cb.fee;
      }
      this.debit(caller, cb.fee);
      this.credit(this.contractId(dstOwnMgmt), cb.fee);
    }

    if (!this.transferShareManagementRights(name, issuer, owner, possessor, callerSlot, dstPosMgmt, shares)) {
      return INVALID_AMOUNT;
    }

    this.runManagementCallback(dstOwnMgmt, SP.POST_ACQUIRE_SHARES, name, issuer, owner, possessor, shares, cb.fee, callerSlot);
    return cb.fee;
  }

  // distributeDividends — pay amountPerShare to each holder of the contract's IPO shares (the 676 computors,
  // one share each by default). Total = amountPerShare * IPO_SHARE_COUNT, debited from the contract; each
  // shareholder is credited its share of the total, firing its POST_INCOMING_TRANSFER if it is a contract.
  // Forbidden inside a POST_INCOMING_TRANSFER callback.
  private doDistributeDividends(slot: number, amountPerShare: bigint): number {
    if (this.pitDepth > 0) return 0; // forbidden inside POST_INCOMING_TRANSFER
    if (amountPerShare < 0n || amountPerShare * BigInt(IPO_SHARE_COUNT) > MAX_AMOUNT) return 0;

    const total = amountPerShare * BigInt(IPO_SHARE_COUNT);
    const cur = this.contractId(slot);
    if (this.balance(cur) < total) return 0;

    if (amountPerShare === 0n) {
      return 1;
    }

    const committee = this.getCommittee();
    const base = Math.floor(IPO_SHARE_COUNT / committee.size);
    const rem = IPO_SHARE_COUNT % committee.size;
    this.debit(cur, total);

    for (let j = 0; j < committee.size; j++) {
      const sharesHeld = BigInt(base + (j < rem ? 1 : 0)); // 676 shares spread over the committee
      const payout = amountPerShare * sharesHeld;
      const holder = committee.computors[j].publicKey;
      this.credit(holder, payout);
      this.notifyPIT(holder, cur, payout, TT_STANDARD); // fires POST_INCOMING_TRANSFER only if the holder is a contract
    }

    return 1;
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

    // POST_INCOMING_TRANSFER is a system-initiated callback: exempt from the fee gate (it runs even on a
    // dormant contract so it can receive transfers) but still metered, since a state change costs the digest.
    this.pitDepth++;
    try {
      this.fire(c, KIND.SYSPROC, SP.POST_INCOMING_TRANSFER, input, { entryPoint: SP.POST_INCOMING_TRANSFER });
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
    c.trace = this.recorder;
    c.metering = this.feeMode === "metered";
    this.contracts.set(slot, c);
    c.zeroState();

    // A metered contract is born funded (a successful IPO) unless its reserve was pre-set — so it can run out
    // of the box; tests override with setFeeReserve/ipo. Construction (INITIALIZE) is exempt from the gate.
    if (this.feeMode === "metered" && !this.feeReserve.has(slot)) {
      this.feeReserve.set(slot, this.defaultReserve);
    }

    if (c.hasSysproc(SP.INITIALIZE)) this.fire(c, KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
    return c;
  }

  // Debug tracing — wired to the node's /dev/debug + /debug-trace RPC by the transport.
  setDebug(on: boolean): void {
    this.recorder.setEnabled(on);
  }

  getTrace(): DebugTrace {
    return this.recorder.trace();
  }

  // Epoch-boundary sysprocs are exempt from the fee gate (execution_fees.md): they run even on a depleted
  // reserve to keep contract state valid.
  beginEpoch(): void {
    for (const s of this.slots(true)) {
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.BEGIN_EPOCH)) this.fire(c, KIND.SYSPROC, SP.BEGIN_EPOCH, new Uint8Array(0), { entryPoint: SP.BEGIN_EPOCH });
    }
  }

  endEpoch(): void {
    for (const s of this.slots(false)) {
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.END_EPOCH)) this.fire(c, KIND.SYSPROC, SP.END_EPOCH, new Uint8Array(0), { entryPoint: SP.END_EPOCH });
    }
  }

  // BEGIN_TICK / END_TICK are gated: a metered contract with a non-positive reserve is skipped (dormant) until
  // it is refilled.
  beginTick(): void {
    this.tickN++;
    for (const s of this.slots(true)) {
      // BEGIN_TICK: ascending 1->N
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.BEGIN_TICK) && this.reserveOk(s)) this.fire(c, KIND.SYSPROC, SP.BEGIN_TICK, new Uint8Array(0), { entryPoint: SP.BEGIN_TICK });
    }
  }

  endTick(): void {
    for (const s of this.slots(false)) {
      // END_TICK: descending N->1
      const c = this.contracts.get(s)!;
      if (c.hasSysproc(SP.END_TICK) && this.reserveOk(s)) this.fire(c, KIND.SYSPROC, SP.END_TICK, new Uint8Array(0), { entryPoint: SP.END_TICK });
    }
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
    }
    this.beginTick();
    this.drainMempool();
    this.endTick();
    this.finalizeTick();
  }

  query(slot: number, it: number, input?: Uint8Array): Uint8Array {
    return this.contracts.get(slot)!.invoke(KIND.FUNCTION, it, input);
  }

  // Run a user procedure: POST_INCOMING_TRANSFER (procedureTransaction) if reward>0, then the procedure.
  // Does NOT credit — the caller (procedure() or applyTx()) has already moved the reward into the contract.
  private runProcedure(slot: number, it: number, input: Uint8Array, invocator: Uint8Array, originator: Uint8Array, reward: bigint, transferType = TT_PROCEDURE): Uint8Array {
    const c = this.contracts.get(slot)!;
    if (reward > 0n) this.notifyPIT(this.contractId(slot), invocator, reward, transferType);

    return this.fire(c, KIND.PROCEDURE, it, input, { invocator, originator, invocationReward: reward, entryPoint: EP_USER_PROCEDURE });
  }

  // Inter-contract function call (liteCallFunction) — route to whatever Contract is at calleeIdx (a user
  // contract or a wasm-deployed system contract; no native/wasm distinction). Returns the
  // InterContractCallError + the callee's output bytes.
  doCallFunction(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, originator: Uint8Array): { error: number; output: Uint8Array } {
    const callee = this.contracts.get(calleeIdx);
    if (!callee) return { error: CALL_ERR_INACTIVE, output: EMPTY };
    if (calleeIdx >= callerSlot) return { error: CALL_ERR_INACTIVE, output: EMPTY }; // lower-index rule
    if (!this.reserveOk(calleeIdx)) return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY }; // callee must have reserve
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
    if (!this.reserveOk(calleeIdx)) return { error: CALL_ERR_INSUFFICIENT_FEES, output: EMPTY }; // callee must have reserve (reward not moved)
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
    if (!this.reserveOk(calleeIdx)) return INVALID_PROPOSAL_INDEX; // dormant callee can't be invoked

    if (reward > 0n) this.transferReward(callerSlot, calleeIdx, reward);

    this.callDepth++;
    try {
      const out = this.fire(callee, KIND.SYSPROC, SP.SET_SHAREHOLDER_PROPOSAL, proposal, { invocator: this.contractId(callerSlot), originator, entryPoint: SP.SET_SHAREHOLDER_PROPOSAL });
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
    if (!this.reserveOk(calleeIdx)) return 0; // dormant callee can't be invoked

    if (reward > 0n) this.transferReward(callerSlot, calleeIdx, reward);

    this.callDepth++;
    try {
      const out = this.fire(callee, KIND.SYSPROC, SP.SET_SHAREHOLDER_VOTES, vote, { invocator: this.contractId(callerSlot), originator, entryPoint: SP.SET_SHAREHOLDER_VOTES });
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
    if (!this.reserveOk(slot)) {
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

      if (isProcedure && !this.reserveOk(slot)) {
        // Dormant contract (no execution-fee reserve): the procedure can't run and any attached amount is
        // refunded to the sender (execution_fees.md — "amounts are refunded if a contract cannot execute").
        if (moneyFlew) {
          this.debit(dest, amount, tick);
          this.credit(source, amount, tick);
          moneyFlew = false;
        }
      } else if (isProcedure) {
        this.runProcedure(slot, inputType, payload, source, source, reward);
      } else if (reward > 0n) {
        this.notifyPIT(dest, source, reward, TT_STANDARD); // plain incoming transfer to a contract
      }
    }
    // dest is a plain user identity: the debit/credit above is the whole transfer.

    this.recordTx({ txId, tick, source: this.key(source), dest: this.key(dest), amount, inputType, moneyFlew, digest });
    return { moneyFlew };
  }

  // Submit a broadcast tx. In mempool mode a tx whose scheduled tick is still ahead is held until the chain
  // reaches that tick (drained in advance), so it is recorded under that tick; otherwise — and always when
  // mempool mode is off — it applies immediately at the current tick.
  enqueueTx(scheduledTick: number, source: Uint8Array, dest: Uint8Array, amount: bigint, inputType: number, payload: Uint8Array, txId: string, digest: Uint8Array = ZERO32): { moneyFlew: boolean; queued: boolean } {
    if (!this.mempoolMode || scheduledTick <= this.tickN) {
      const r = this.applyTx(source, dest, amount, inputType, payload, txId, digest);
      return { moneyFlew: r.moneyFlew, queued: false };
    }

    let q = this.mempool.get(scheduledTick);
    if (!q) {
      q = [];
      this.mempool.set(scheduledTick, q);
    }

    q.push({ source, dest, amount, inputType, payload, txId, digest });
    return { moneyFlew: false, queued: true };
  }

  // Apply the txs scheduled for the current tick (mempool mode), recording them under it.
  private drainMempool(): void {
    const q = this.mempool.get(this.tickN);
    if (!q) {
      return;
    }

    this.mempool.delete(this.tickN);
    for (const t of q) {
      this.applyTx(t.source, t.dest, t.amount, t.inputType, t.payload, t.txId, t.digest);
    }
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

  // ---- tick consensus (N computors, quorum votes; core-lite tick.h / computors.h / common_def.h) ----
  // The configured committee size, available without deriving keys (used for dividend payout + quorum sizing).
  private committeeSize(): number {
    return this.consensusOpts.computorSeeds?.length ?? this.consensusOpts.numberOfComputors ?? DEFAULT_NUMBER_OF_COMPUTORS;
  }

  // The committee, derived (sync FourQ) on first use — requires initK12() to have resolved the crypto module.
  getCommittee(): Committee {
    if (!this.committee) {
      this.committee = new Committee(this.consensusOpts);
    }

    return this.committee;
  }

  quorum(): number {
    return this.getCommittee().quorum;
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
    return this.txById.size;
  }

  // computerDigest — the faithful K12 merkle over MAX_NUMBER_OF_CONTRACTS contract-state leaves (leaf =
  // K12(StateData); an empty slot is zero). The one system digest the sim reproduces exactly vs core-lite.
  computerDigest(): Uint8Array {
    const leaves = new Map<number, Uint8Array>();
    for (const [slot, c] of this.contracts) {
      leaves.set(slot, k12Bytes(c.state()));
    }

    return merkleRoot(leaves, MAX_NUMBER_OF_CONTRACTS);
  }

  // The 64-byte EntityRecord whose K12 is the spectrum leaf (the layout a client reads back from getEntity).
  private entityRecord(k: string): Uint8Array {
    const rec = new Uint8Array(64);
    rec.set(hexToBytes32(k), 0);
    const e = this.spectrum.get(k);
    if (e) {
      const dv = new DataView(rec.buffer);
      dv.setBigInt64(32, e.incomingAmount, true);
      dv.setBigInt64(40, e.outgoingAmount, true);
      dv.setUint32(48, e.numberOfIncomingTransfers, true);
      dv.setUint32(52, e.numberOfOutgoingTransfers, true);
      dv.setUint32(56, e.latestIncomingTransferTick, true);
      dv.setUint32(60, e.latestOutgoingTransferTick, true);
    }
    return rec;
  }

  // The 48-byte AssetRecord ownership / possession variants — the universe leaves, byte-identical to what a
  // client hashes: publicKey(32) type(1) padding(1) managingContractIndex(2) crossRefIndex(4) numberOfShares(8).
  private ownershipRecord(owner: Uint8Array, ownMgmt: number, shares: bigint): Uint8Array {
    return assetRecord(owner, 2, ownMgmt, shares);
  }

  private possessionRecord(possessor: Uint8Array, posMgmt: number, shares: bigint): Uint8Array {
    return assetRecord(possessor, 3, posMgmt, shares);
  }

  // Assign (and remember) a stable leaf index for a tree key.
  private leafIndex(map: Map<string, number>, key: string): number {
    const existing = map.get(key);
    if (existing !== undefined) {
      return existing;
    }

    const idx = map.size;
    map.set(key, idx);
    return idx;
  }

  private markHoldingDirty(assetKey: string, holdingKey: string): void {
    this.universeDirty.add(assetKey + " " + holdingKey);
  }

  // spectrumDigest — the root of the incremental 2^24 merkle. Only entities whose balance changed since the last
  // call are rehashed (24 nodes each); empty subtrees collapse to a precomputed hash. leaf = K12(EntityRecord).
  spectrumDigest(): Uint8Array {
    if (!this.spectrumTree) {
      this.spectrumTree = new SparseMerkle(k12Bytes(new Uint8Array(64)));
    }

    for (const k of this.spectrumDirty) {
      this.spectrumTree.setLeaf(this.leafIndex(this.spectrumIdx, k), k12Bytes(this.entityRecord(k)));
    }
    this.spectrumDirty.clear();
    return this.spectrumTree.root();
  }

  // universeDigest — the root of the incremental 2^24 merkle over asset holdings. A deleted holding's leaf goes
  // back to the empty-leaf hash. leaf = K12(holdingRecord).
  universeDigest(): Uint8Array {
    if (!this.universeTree) {
      this.universeTree = new SparseMerkle(k12Bytes(new Uint8Array(ASSET_RECORD_SIZE)));
    }

    for (const gk of this.universeDirty) {
      const sep = gk.indexOf(" ");
      const asset = this.assets.get(gk.slice(0, sep));
      const h = asset?.holdings.get(gk.slice(sep + 1));
      const own = asset && h ? k12Bytes(this.ownershipRecord(h.owner, h.ownMgmt, h.shares)) : k12Bytes(new Uint8Array(ASSET_RECORD_SIZE));
      const pos = asset && h ? k12Bytes(this.possessionRecord(h.possessor, h.posMgmt, h.shares)) : k12Bytes(new Uint8Array(ASSET_RECORD_SIZE));
      this.universeTree.setLeaf(this.leafIndex(this.universeIdx, "o " + gk), own);
      this.universeTree.setLeaf(this.leafIndex(this.universeIdx, "p " + gk), pos);
    }
    this.universeDirty.clear();
    return this.universeTree.root();
  }

  // Ownership proof for each asset ownerId owns: the ownership AssetRecord + its universe index + siblings, plus
  // the issuance fields for the attached record. A client recomputes the universe root from the record.
  universeProofOwned(ownerId: Uint8Array): { record: Uint8Array; issuer: Uint8Array; name: bigint; decimals: number; managingContractIndex: number; shares: bigint; index: number; siblings: Uint8Array[] }[] {
    this.universeDigest();
    const ownerHex = this.key(ownerId);
    const out = [];
    for (const [assetKey, asset] of this.assets) {
      for (const [hk, h] of asset.holdings) {
        if (this.key(h.owner) !== ownerHex) {
          continue;
        }
        const index = this.universeIdx.get("o " + assetKey + " " + hk)!;
        out.push({ record: this.ownershipRecord(h.owner, h.ownMgmt, h.shares), issuer: asset.issuer, name: asset.name, decimals: asset.decimals, managingContractIndex: h.ownMgmt, shares: h.shares, index, siblings: this.universeTree!.siblings(index) });
      }
    }
    return out;
  }

  // Possession proof for each asset possessorId possesses (mirrors universeProofOwned).
  universeProofPossessed(possessorId: Uint8Array): { record: Uint8Array; owner: Uint8Array; issuer: Uint8Array; name: bigint; decimals: number; managingContractIndex: number; shares: bigint; index: number; siblings: Uint8Array[] }[] {
    this.universeDigest();
    const posHex = this.key(possessorId);
    const out = [];
    for (const [assetKey, asset] of this.assets) {
      for (const [hk, h] of asset.holdings) {
        if (this.key(h.possessor) !== posHex) {
          continue;
        }
        const index = this.universeIdx.get("p " + assetKey + " " + hk)!;
        out.push({ record: this.possessionRecord(h.possessor, h.posMgmt, h.shares), owner: h.owner, issuer: asset.issuer, name: asset.name, decimals: asset.decimals, managingContractIndex: h.posMgmt, shares: h.shares, index, siblings: this.universeTree!.siblings(index) });
      }
    }
    return out;
  }

  // The merkle proof for an entity: its leaf index + the 24 sibling hashes from the leaf to the spectrum root.
  // A client recomputes the root from (EntityRecord, index, siblings) and checks it against spectrumDigest.
  spectrumProof(id: Uint8Array): { record: Uint8Array; index: number; siblings: Uint8Array[] } {
    this.spectrumDigest(); // flush pending leaf updates so the tree reflects the current state
    const k = this.key(id);
    const record = this.entityRecord(k);
    const index = this.spectrumIdx.get(k);
    if (index === undefined || !this.spectrumTree) {
      return { record, index: -1, siblings: [] };
    }

    return { record, index, siblings: this.spectrumTree.siblings(index) };
  }

  // Produce + store this tick's quorum record. The leader (computor[tick % N]) packs the tick's per-tx digests
  // into a signed TickData; every computor then signs a Tick vote whose transactionDigest commits K12(TickData),
  // and the aligned count must reach QUORUM (always, for an honest committee) for the tick to be valid.
  private finalizeTick(): void {
    const committee = this.getCommittee();
    const spectrum = this.spectrumDigest();
    const universe = this.universeDigest();
    const computer = this.computerDigest();
    this.lastDigests = { spectrum, universe, computer }; // the next tick's contracts read these as prev*Digest

    const txDigests = this.tickTransactions(this.tickN).map((r) => r.digest);
    const tickData = buildTickData(committee, this.epochN, this.tickN, txDigests, { spectrum, universe, computer }, this.nowMs());

    const digests: TickStateDigests = {
      spectrum,
      universe,
      computer,
      transaction: k12Bytes(tickData),
      expectedNextTransaction: new Uint8Array(32),
    };

    const votes: Uint8Array[] = [];
    let aligned = 0;
    for (const c of committee.computors) {
      const vote = buildTickVote(c, this.epochN, this.tickN, digests, this.nowMs());
      votes.push(vote);
      if (voteIsAligned(vote, digests)) {
        aligned++;
      }
    }

    if (aligned < committee.quorum) {
      throw new Error(`tick ${this.tickN}: aligned votes ${aligned} < quorum ${committee.quorum}`);
    }

    this.ticks.set(this.tickN, { votes, aligned, total: votes.length, digests, tickData });
    this.pruneTicks();
  }

  // Bound memory: keep the TickData + votes for the most recent TICK_HISTORY ticks only (each TickData ~41 KB).
  private pruneTicks(): void {
    if (this.ticks.size <= TICK_HISTORY) {
      return;
    }

    const cutoff = this.tickN - TICK_HISTORY;
    for (const t of this.ticks.keys()) {
      if (t < cutoff) {
        this.ticks.delete(t);
      }
    }
  }

  tickRecord(tick: number): TickRecord | undefined {
    return this.ticks.get(tick);
  }

  // The stored signed TickData for a finalized tick; undefined if never finalized or already pruned.
  tickData(tick: number): Uint8Array | undefined {
    return this.ticks.get(tick)?.tickData;
  }

  // Aligned votes for a tick (0 if not yet finalized) — CurrentTickInfo.numberOfAlignedVotes.
  alignedVotes(tick = this.tickN): number {
    return this.ticks.get(tick)?.aligned ?? 0;
  }

  // The arbitrator-signed Computors wire list for the current epoch. slotCount pads for the peer-protocol bridge.
  signedComputorList(slotCount?: number): Uint8Array {
    return this.getCommittee().signedComputorList(this.epochN, slotCount);
  }
}

function hexToBytes32(hex: string): Uint8Array {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// A 48-byte AssetRecord (ownership type=2 / possession type=3 variant): publicKey(32) type(1) padding(1)
// managingContractIndex(2) crossRefIndex(4, left 0) numberOfShares(8). The universe merkle leaf.
function assetRecord(pubkey: Uint8Array, type: number, mgmt: number, shares: bigint): Uint8Array {
  const rec = new Uint8Array(ASSET_RECORD_SIZE);
  rec.set(pubkey.subarray(0, 32), 0);
  rec[32] = type;
  const dv = new DataView(rec.buffer);
  dv.setUint16(34, mgmt & 0xffff, true);
  dv.setBigInt64(40, shares, true);
  return rec;
}
