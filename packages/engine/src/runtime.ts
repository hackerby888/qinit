// Layer 1 — wasm-host-runtime. The TypeScript port of the node's WASM host shim
// (core-lite: src/extensions/lite_wasm_contracts.h + lite_wasm_imports.h), driving the browser/Bun
// `WebAssembly` API instead of WAMR. One Contract == one WebAssembly.Instance of a built contract .wasm.
// The contract bytes run unchanged; this supplies the "lhost" import table, the per-call marshalling, and
// the resident-state digest.
import { k12Bytes, toHex } from "./k12";
import { bytesEqual } from "./bytes";
import type { TraceRecorder } from "./trace";
import { QpiContext } from "./abi";
import { EntityRecord, M256i } from "./wire";

const EMPTY = new Uint8Array(0);

// `env.*` imports a contract declares via `--allow-undefined`. The known assert/diagnostic helper (qpi.h
// ASSERT's addDebugMessageAssert) only fires on a failed assert, so it's a no-op. Any OTHER env import means the
// contract needs a symbol the wasm build didn't compile in and the host doesn't provide (e.g. a QPI helper such
// as copyMemory / smul / __qpiAllocLocals from an impl header that isn't part of the wasm TU). Silently returning
// 0 there turns a real gap into a cryptic i64/ToBigInt trap deep in execution — so this fails loud WHEN CALLED,
// naming the symbol. Instantiation still succeeds: an undefined-but-unused import is never invoked.
const ENV_NOOP = new Set(["addDebugMessageAssert"]);
export function envImportStub(name: string): Function {
  if (typeof name !== "string" || ENV_NOOP.has(name)) {
    return () => 0;
  }
  return () => {
    throw new Error(`missing host import 'env.${name}' was called — the contract uses a symbol the wasm build did not compile in and the engine host does not provide`);
  };
}

export const KIND = { FUNCTION: 0, PROCEDURE: 1, SYSPROC: 2, MIGRATE: 3 } as const;

// System-procedure ids — LiteSysProcId order (core-lite: src/extensions/lite_dyn_abi.h).
export const SP = {
  INITIALIZE: 0, BEGIN_EPOCH: 1, END_EPOCH: 2, BEGIN_TICK: 3, END_TICK: 4,
  PRE_RELEASE_SHARES: 5, PRE_ACQUIRE_SHARES: 6, POST_RELEASE_SHARES: 7, POST_ACQUIRE_SHARES: 8,
  POST_INCOMING_TRANSFER: 9, SET_SHAREHOLDER_PROPOSAL: 10, SET_SHAREHOLDER_VOTES: 11,
} as const;

// IO carve inside the contract's io_base region: [in 64K | out 64K | locals 32K | arena].
// MUST match LITE_WASM_*_SZ in core-lite src/extensions/lite_wasm_contracts.h.
const IN_SZ = 64 * 1024, OUT_SZ = 64 * 1024, LOCALS_SZ = 32 * 1024;

// Deterministic execution-cost meter. The chain-sim (Layer 2) reads Contract.lastCost to debit the contract's
// execution-fee reserve (core-lite doc/execution_fees.md). Real qubic prices a procedure by its wall-clock
// microseconds — non-deterministic, and would break the sim's K12 digest reproducibility — so this instead
// counts weighted host-ABI calls plus a digest-recompute term proportional to StateData size (the dominant
// cost for large state, per the doc). Units are relative; Layer 2 may scale them by a fee multiplier. The
// meter is inert unless Contract.metering is set, so a non-metered sim pays nothing for it.
const BASE_CALL_COST = 10n;  // fixed cost charged on every metered contract entry
const DIGEST_BYTE_COST = 1n; // per StateData byte, charged once when a call mutates state (digest recompute)
const HOST_WEIGHT: Record<string, bigint> = {
  k12: 5n,
  getEntity: 1n, nextId: 2n, prevId: 2n,
  logBytes: 1n,
  transfer: 10n, transferTyped: 10n, burn: 10n,
  isAssetIssued: 2n, issueAsset: 50n,
  numberOfShares: 5n, numberOfPossessedShares: 3n,
  transferShareOwnershipAndPossession: 20n, distributeDividends: 20n,
  acquireShares: 30n, releaseShares: 30n,
  dayOfWeek: 1n, signatureValidity: 5n, bidInIPO: 10n, ipoBidId: 2n, ipoBidPrice: 2n,
  computeMiningFunction: 5n, initMiningSeed: 2n, getOracleQueryStatus: 1n, unsubscribeOracle: 5n,
  queryOracle: 20n, subscribeOracle: 20n, getOracleQuery: 3n, getOracleReply: 3n,
  liteCallFunction: 20n, liteInvokeProcedure: 20n,
  liteSetShareholderProposal: 20n, liteSetShareholderVotes: 20n,
};


// Decompose a unix-ms timestamp into the qpi date/time fields (UTC). `year` is the qubic 2-digit form
// (year - 2000), matching the node's year() accessor + the Tick struct's uint8 year.
export function dateFields(ms: number): { year: number; month: number; day: number; hour: number; minute: number; second: number; milli: number } {
  const d = new Date(ms);
  return {
    year: (d.getUTCFullYear() - 2000) & 0xff,
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    milli: d.getUTCMilliseconds(),
  };
}

// Pack the chain clock into the qubic 8-byte DateAndTime (qpi.h DateAndTime::set): the full year at bit 46, then
// month/day/hour/minute/second/millisecond; the microsecond field (bits 0-9) is not modeled. now() writes this as
// a little-endian uint64. The year is the full form (etalonTick.year + 2000), matching DateAndTime::now().
export function packDateAndTime(ms: number): bigint {
  const t = dateFields(ms);
  return (BigInt(t.year + 2000) << 46n)
    | (BigInt(t.month) << 42n)
    | (BigInt(t.day) << 37n)
    | (BigInt(t.hour) << 32n)
    | (BigInt(t.minute) << 26n)
    | (BigInt(t.second) << 20n)
    | (BigInt(t.milli) << 10n);
}

// Spectrum entity record — mirrors QPI::Entity (qpi.h:1615): publicKey + incoming/outgoing amounts, transfer
// counts, latest transfer ticks. balance = incomingAmount - outgoingAmount.
export interface Entity {
  incomingAmount: bigint;
  outgoingAmount: bigint;
  numberOfIncomingTransfers: number;
  numberOfOutgoingTransfers: number;
  latestIncomingTransferTick: number;
  latestOutgoingTransferTick: number;
}

// The chain-sim (Layer 2) injects these; Layer 1 stays pure mechanics.
export interface HostServices {
  tick(): number;
  epoch(): number;
  nowMs(): number;
  numberOfTickTransactions(): number;
  markDirty(slot: number): void;
  log(slot: number, level: number, msg: Uint8Array): void;
  transfer(slot: number, dest: Uint8Array, amount: bigint, transferType: number): bigint;
  burn(slot: number, amount: bigint, burnedFor: number): bigint;
  getEntity(id: Uint8Array): Entity | null;
  isContractId(id: Uint8Array): number;
  arbitrator(): Uint8Array;
  computor(index: number): Uint8Array;
  prevSpectrumDigest(): Uint8Array;
  prevUniverseDigest(): Uint8Array;
  prevComputerDigest(): Uint8Array;
  queryFeeReserve(callerSlot: number, contractIndex: number): bigint;
  issueAsset(slot: number, name: bigint, issuer: Uint8Array, decimals: number, shares: bigint, unit: bigint, invocator: Uint8Array): bigint;
  isAssetIssued(issuer: Uint8Array, name: bigint): number;
  numberOfShares(asset: Uint8Array, ownSel: Uint8Array, posSel: Uint8Array): bigint;
  numberOfPossessedShares(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, ownMgmt: number, posMgmt: number): bigint;
  assetEnumerate(asset: Uint8Array, ownSel: Uint8Array, posSel: Uint8Array, kind: number): { owner: Uint8Array; possessor: Uint8Array; shares: bigint; ownMgmt: number; posMgmt: number }[];
  transferShares(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, newOwner: Uint8Array): bigint;
  acquireShares(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, srcOwnMgmt: number, srcPosMgmt: number, offeredFee: bigint): bigint;
  releaseShares(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, dstOwnMgmt: number, dstPosMgmt: number, offeredFee: bigint): bigint;
  dayOfWeek(year: number, month: number, day: number): number;
  signatureValidity(entity: Uint8Array, digest: Uint8Array, signature: Uint8Array): number;
  bidInIPO(slot: number, ipoContractIndex: number, price: bigint, quantity: number): bigint;
  ipoBidId(ipoContractIndex: number, ipoBidIndex: number): Uint8Array;
  ipoBidPrice(ipoContractIndex: number, ipoBidIndex: number): bigint;
  computeMiningFunction(miningSeed: Uint8Array, publicKey: Uint8Array, nonce: Uint8Array): Uint8Array;
  initMiningSeed(miningSeed: Uint8Array): void;
  getOracleQueryStatus(queryId: bigint): number;
  unsubscribeOracle(oracleSubscriptionId: number): number;
  queryOracle(slot: number, interfaceIndex: number, query: Uint8Array, notificationProcId: number, timeoutMillisec: number, fee: bigint): bigint;
  subscribeOracle(slot: number, interfaceIndex: number, query: Uint8Array, notificationProcId: number, periodMillisec: number, notifyPrev: boolean, fee: bigint): number;
  getOracleQuery(queryId: bigint): Uint8Array | null;
  getOracleReply(queryId: bigint): Uint8Array | null;
  distributeDividends(slot: number, amountPerShare: bigint): number;
  callFunction(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, originator: Uint8Array): { error: number; output: Uint8Array };
  invokeProcedure(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, reward: bigint, originator: Uint8Array): { error: number; output: Uint8Array };
  nextId(id: Uint8Array): Uint8Array;
  prevId(id: Uint8Array): Uint8Array;
  setShareholderProposal(callerSlot: number, calleeIdx: number, proposal: Uint8Array, reward: bigint, originator: Uint8Array): number;
  setShareholderVotes(callerSlot: number, calleeIdx: number, vote: Uint8Array, reward: bigint, originator: Uint8Array): number;
}

// Per-call context written into the contract's 256-byte QpiContext header (qpi.h QpiContext layout). The
// contract reads these as struct fields (qpi.invocator()/originator()/invocationReward()/...), NOT host imports.
export interface CallCtx {
  invocator?: Uint8Array;  // 32-byte id
  originator?: Uint8Array; // 32-byte id
  invocationReward?: bigint;
  entryPoint?: number;
}

export class ContractAbort extends Error {
  constructor(public code: number) { super("contract abort " + code); }
}

function trapMessage(err: unknown): string {
  if (err instanceof ContractAbort) {
    return `abort(${err.code})`;
  }
  return String((err as Error)?.message ?? err);
}

export class Contract {
  inst: WebAssembly.Instance;
  mem: WebAssembly.Memory;
  ex: any;
  ioBase = 0; stateAddr = 0; stateSize = 0; ctxAddr = 0;
  arenaBase = 0; arenaBump = 0; arenaEnd = 0;
  sysMask = 0;
  metering = false;  // Layer 2 sets this when fee accounting is on; gates the cost meter (off => zero overhead)
  cost = 0n;         // host-weight accumulator for the in-flight dispatch frame (reset/restored per invoke)
  lastCost = 0n;     // total cost of the most recently completed invoke frame — Layer 2 debits this
  private outSizes = new Map<string, number>();   // user entries: "kind:it" -> outSize
  private sysOutSizes = new Map<number, number>(); // sysproc id -> outSize
  entries: { it: number; kind: number; inSize: number; outSize: number }[] = []; // registered fns/procs
  trace?: TraceRecorder; // set by the Sim when debug tracing is on
  hasMigrate = false;          // contract exports __migrate (a redeploy with matching old-state size runs it)
  migrateOldStateSize = 0;
  migrateLocalsSize = 0;
  everInitialized = false;     // INITIALIZE has run once -> redeploy preserves/migrates state, never re-inits

  private constructor(public slot: number, public host: HostServices, mod: WebAssembly.Module) {
    this.inst = new WebAssembly.Instance(mod, this.imports());
    this.ex = this.inst.exports;
    this.mem = this.ex.memory;
    // Exported layout getters return addresses of statics — safe to read before _initialize.
    this.ioBase = this.ex.io_base() >>> 0;
    this.stateAddr = this.ex.state_addr() >>> 0;
    this.stateSize = this.ex.state_size() >>> 0;
    this.ctxAddr = this.ex.ctx_addr() >>> 0;
    this.arenaBase = this.ioBase + IN_SZ + OUT_SZ + LOCALS_SZ;
    this.arenaBump = this.arenaBase;
    this.arenaEnd = this.ioBase + (this.ex.io_size() >>> 0);
    if (typeof this.ex._initialize === "function") this.ex._initialize(); // reactor: run C++ ctors
    this.readRegistry();
  }

  static load(bytes: Uint8Array, slot: number, host: HostServices): Contract {
    return new Contract(slot, host, new WebAssembly.Module(bytes as BufferSource));
  }

  // Fresh views each use — memory.grow detaches the underlying ArrayBuffer, so never hold a view
  // across a dispatch.
  private u8() {
    return new Uint8Array(this.mem.buffer);
  }
  private dv() {
    return new DataView(this.mem.buffer);
  }

  private readRegistry() {
    this.sysMask = this.ex.reg_sysproc_mask() >>> 0;
    const n = this.ex.reg_count() >>> 0;                 // also triggers the contract's lazy registration
    const scratch = this.ioBase;                          // reuse the input region as a scratch out-param
    for (let i = 0; i < n; i++) {
      this.ex.reg_info(i >>> 0, scratch >>> 0);
      const dv = this.dv();                               // LiteWasmTuInfo { u32 inputType, kind, inSize, outSize }
      const it = dv.getUint32(scratch, true);
      const kind = dv.getUint32(scratch + 4, true);
      const inSize = dv.getUint32(scratch + 8, true);
      const outSize = dv.getUint32(scratch + 12, true);
      this.entries.push({ it, kind, inSize, outSize });
      this.outSizes.set(kind + ":" + it, outSize);
    }
    for (let sp = 0; sp < 12; sp++) {
      if ((this.sysMask >>> sp) & 1) this.sysOutSizes.set(sp, this.ex.sysproc_out_size(sp >>> 0) >>> 0);
    }
    // migrate metadata — optional exports (contracts built before migration support lack them).
    if (typeof this.ex.has_migrate === "function") {
      this.hasMigrate = (this.ex.has_migrate() >>> 0) === 1;
      this.migrateOldStateSize = (this.ex.migrate_old_state_size?.() ?? 0) >>> 0;
      this.migrateLocalsSize = (this.ex.migrate_locals_size?.() ?? 0) >>> 0;
    }
  }

  hasSysproc(sp: number): boolean {
    return ((this.sysMask >>> sp) & 1) === 1;
  }

  private outSizeFor(kind: number, it: number): number {
    if (kind === KIND.SYSPROC) return this.sysOutSizes.get(it) ?? 0;
    return this.outSizes.get(kind + ":" + it) ?? 0;
  }

  zeroState() {
    this.u8().fill(0, this.stateAddr, this.stateAddr + this.stateSize);
  }

  // Copy bytes into the resident state region (truncated to stateSize). Preserves overlapping state across a
  // non-migrating redeploy — parity with core's raw-restore (lite_wasm_contracts.h).
  writeState(bytes: Uint8Array): void {
    const n = Math.min(bytes.length, this.stateSize);
    if (n) this.u8().set(bytes.subarray(0, n), this.stateAddr);
  }

  // Build the 256-byte QpiContext header the contract reads (currentContract*, originator, invocator,
  // invocationReward, entryPoint) — qpi.h QpiContext field layout (offsets 0/4/8/40/72/104/112).
  private writeCtx(ctx: CallCtx) {
    const view = QpiContext.wrap(this.u8(), this.ctxAddr);
    view.bytes.fill(0);
    view.currentContractIndex = this.slot;
    view.stackIndex = -1;
    view.currentContractId = BigInt(this.slot); // id(slot,0,0,0)
    if (ctx.originator && ctx.originator.length >= 32) view.originator = ctx.originator;
    if (ctx.invocator && ctx.invocator.length >= 32) view.invocator = ctx.invocator;
    view.invocationReward = ctx.invocationReward ?? 0n;
    view.entryPoint = ctx.entryPoint ?? 0;
  }

  // Marshal one call through the instance (mirrors liteWasmDispatch): write ctx header + input, zero output,
  // call dispatch(kind,it,inOff,outOff,localsOff), copy the output back out.
  invoke(kind: number, it: number, input: Uint8Array = new Uint8Array(0), ctx: CallCtx = {}): Uint8Array {
    const inOff = this.ioBase;
    const outOff = this.ioBase + IN_SZ;
    const localsOff = this.ioBase + IN_SZ + OUT_SZ;
    const outSize = this.outSizeFor(kind, it);
    const pre = this.u8();
    pre.fill(0, outOff, outOff + OUT_SZ);
    if (input.length) pre.set(input, inOff);
    this.writeCtx(ctx);
    this.arenaBump = this.arenaBase;

    // Cost meter (opt-in): isolate this frame's host-weight accumulator so a nested re-entrant call on the
    // same Contract (e.g. a self-transfer firing POST_INCOMING_TRANSFER) doesn't clobber the parent's tally.
    const metering = this.metering;
    const savedCost = this.cost;
    this.cost = 0n;

    // Debug trace (opt-in): snapshot state, open an entry, time the dispatch, capture a trap. Nesting
    // (inter-contract calls / sysprocs) is handled by the recorder's stack — each invoke is one entry. State
    // is snapshotted once and shared with the meter (it needs before/after to price the digest recompute).
    const rec = this.trace?.enabled ? this.trace : null;
    const wantState = metering || rec != null;
    const stateBefore = wantState ? this.state() : EMPTY;
    const e = rec ? rec.begin({ tick: this.host.tick(), index: this.slot, entry: it, kind, invocator: ctx.invocator, invocationReward: ctx.invocationReward ?? 0n, input, stateBefore }) : null;
    const t0 = rec ? performance.now() : 0;

    try {
      this.ex.dispatch(kind >>> 0, it >>> 0, inOff >>> 0, outOff >>> 0, localsOff >>> 0);
    } catch (err) {
      const stateAfter = wantState ? this.state() : EMPTY;
      this.finishMeter(metering, savedCost, stateBefore, stateAfter);
      if (rec) {
        rec.end(e, { output: EMPTY, ok: false, trap: trapMessage(err), stateBefore, stateAfter, execNs: (performance.now() - t0) * 1e6 });
      }
      throw err;
    }

    const stateAfter = wantState ? this.state() : EMPTY;
    const output = this.u8().slice(outOff, outOff + outSize); // fresh view after dispatch
    this.finishMeter(metering, savedCost, stateBefore, stateAfter);
    if (rec) {
      rec.end(e, { output, ok: true, stateBefore, stateAfter, execNs: (performance.now() - t0) * 1e6 });
    }
    return output;
  }

  // Run the contract's __migrate(newState, oldState, locals) to convert the old state into the new layout.
  // Mirrors the core host path (lite_wasm_contracts.h kind=3): copy old bytes into the arena, zero the new
  // state, shift the scratch base past the blob, dispatch. Used on redeploy when the new module declares MIGRATE().
  migrate(oldState: Uint8Array): void {
    const localsOff = this.ioBase + IN_SZ + OUT_SZ;
    const oldOff = this.arenaBase;
    const u8 = this.u8();
    u8.fill(0, this.stateAddr, this.stateAddr + this.stateSize);   // zero new state (match native)
    u8.fill(0, localsOff, localsOff + LOCALS_SZ);
    u8.set(oldState, oldOff);
    this.writeCtx({});                                            // NULL_ID / zero ctx (QpiContextMigrateProcedureCall)
    this.arenaBump = this.arenaBase + ((oldState.length + 15) & ~15);   // scratch past the old blob
    this.ex.dispatch(KIND.MIGRATE >>> 0, 0, oldOff >>> 0, 0, localsOff >>> 0);
    this.host.markDirty(this.slot);
  }

  // Close out the frame's cost meter: total = base + accumulated host weight + (state changed ? digest
  // recompute over the whole StateData : 0). Records it in lastCost for Layer 2 to debit, then restores the
  // parent frame's accumulator. A no-op (lastCost = 0) when this contract isn't metered.
  private finishMeter(metering: boolean, savedCost: bigint, before: Uint8Array, after: Uint8Array): void {
    if (metering) {
      let c = BASE_CALL_COST + this.cost;
      if (!bytesEqual(before, after)) {
        c += DIGEST_BYTE_COST * BigInt(this.stateSize);
      }
      this.lastCost = c;
    } else {
      this.lastCost = 0n;
    }
    this.cost = savedCost;
  }

  state(): Uint8Array {
    return this.u8().slice(this.stateAddr, this.stateAddr + this.stateSize);
  }
  digest(): string {
    return toHex(k12Bytes(this.state()));
  }

  // Record an effectful host-ABI call (transfer/burn/asset/inter-contract) onto the active debug entry —
  // the host-event timeline the debugger/IDE shows next to the state diff. The detail thunk runs only when
  // tracing is enabled, so the hot path pays nothing when it's off.
  private recHost(name: string, detail: () => string): void {
    const rec = this.trace;
    if (rec?.enabled) {
      rec.hostCall(name, detail());
    }
  }

  // Wrap the priced lhost imports so each call adds its weight to the in-flight frame's cost (only the entries
  // in HOST_WEIGHT — free ops keep their original closure, so an unmetered run is untouched). The wrapper
  // forwards args positionally; wasm matches imports by declared signature, so the rest-spread is transparent
  // and i64 (bigint) returns pass straight through.
  private meterLhost(lhost: Record<string, Function>): void {
    for (const name of Object.keys(lhost)) {
      const w = HOST_WEIGHT[name];
      if (w === undefined) {
        continue;
      }
      const fn = lhost[name] as (...a: unknown[]) => unknown;
      lhost[name] = (...args: unknown[]) => {
        if (this.metering) {
          this.cost += w;
        }
        return fn(...args);
      };
    }
  }

  // The "lhost" import table (core-lite src/extensions/lite_wasm_imports.h LHOST_TABLE) + WASI stubs.
  // The contract wires only the subset it declares; extras are ignored. Effectful ledger/asset/inter-contract
  // ops throw loudly (not silently wrong) until Layer 2 models them.
  private imports(): WebAssembly.Imports {
    const u8 = () => this.u8();
    const ctxView = () => QpiContext.wrap(u8(), this.ctxAddr); // the live QpiContext header (originator / invocator)
    const lhost: Record<string, Function> = {
      // infra / logging
      beginFn: (_id: number) => {},
      endFn: (_id: number) => {},
      markDirty: (_ci: number) => this.host.markDirty(this.slot),
      pauseLog: () => {},
      resumeLog: () => {},
      acquireScratch: (size: bigint, initZero: number) => {
        const n = Number((size + 7n) & ~7n);
        if (this.arenaBump + n > this.arenaEnd) throw new Error("lhost: scratch arena exhausted");
        const off = this.arenaBump; this.arenaBump += n;
        if (initZero) u8().fill(0, off, off + n);
        return off >>> 0;                                  // offset == ptr in wasm32
      },
      releaseScratch: (_off: number) => {},
      logBytes: (_ci: number, level: number, msgOff: number, size: number) =>
        this.host.log(this.slot, level, u8().slice(msgOff, msgOff + size)),
      k12: (inOff: number, len: number, outOff: number) =>
        u8().set(k12Bytes(u8().slice(inOff, inOff + len)), outOff),
      abort: (code: number) => {
        throw new ContractAbort(code);
      },
      // time / tick (read-only)
      epoch: () => this.host.epoch() & 0xffff,
      tick: () => this.host.tick() >>> 0,
      numberOfTickTransactions: () => this.host.numberOfTickTransactions(),
      // qpi date/time: derived from the chain clock. The individual accessors return the qubic 2-digit year
      // (year - 2000, like QpiContextFunctionCall::year); now() packs the 8-byte DateAndTime with the full year
      // (DateAndTime::now() = etalonTick.year + 2000).
      day: () => dateFields(this.host.nowMs()).day,
      year: () => dateFields(this.host.nowMs()).year,
      hour: () => dateFields(this.host.nowMs()).hour,
      minute: () => dateFields(this.host.nowMs()).minute,
      month: () => dateFields(this.host.nowMs()).month,
      second: () => dateFields(this.host.nowMs()).second,
      millisecond: () => dateFields(this.host.nowMs()).milli,
      now: (out: number) => {
        new DataView(this.mem.buffer).setBigUint64(out, packDateAndTime(this.host.nowMs()), true);
      },
      // etalon-tick digests — the previous tick's committed state roots
      prevSpectrumDigest: (out: number) => u8().set(this.host.prevSpectrumDigest().subarray(0, 32), out),
      prevUniverseDigest: (out: number) => u8().set(this.host.prevUniverseDigest().subarray(0, 32), out),
      prevComputerDigest: (out: number) => u8().set(this.host.prevComputerDigest().subarray(0, 32), out),
      // identity / spectrum
      getEntity: (idOff: number, entityOff: number) => {
        const id = u8().slice(idOff, idOff + 32);
        const e = this.host.getEntity(id);
        const rec = EntityRecord.wrap(u8(), entityOff);
        rec.publicKey = M256i.wrap(id); // QPI::Entity.publicKey
        rec.incomingAmount = e ? e.incomingAmount : 0n;
        rec.outgoingAmount = e ? e.outgoingAmount : 0n;
        rec.numberOfIncomingTransfers = e ? e.numberOfIncomingTransfers : 0;
        rec.numberOfOutgoingTransfers = e ? e.numberOfOutgoingTransfers : 0;
        rec.latestIncomingTransferTick = e ? e.latestIncomingTransferTick : 0;
        rec.latestOutgoingTransferTick = e ? e.latestOutgoingTransferTick : 0;
        return e ? 1 : 0;
      },
      queryFeeReserve: (ci: number) => this.host.queryFeeReserve(this.slot, ci >>> 0),
      nextId: (idOff: number, outOff: number) => {
        u8().set(this.host.nextId(u8().slice(idOff, idOff + 32)), outOff);
      },
      prevId: (idOff: number, outOff: number) => {
        u8().set(this.host.prevId(u8().slice(idOff, idOff + 32)), outOff);
      },
      isContractId: (idOff: number) => this.host.isContractId(u8().slice(idOff, idOff + 32)),
      arbitrator: (out: number) => u8().set(this.host.arbitrator().subarray(0, 32), out),
      computor: (i: number, out: number) => u8().set(this.host.computor(i >>> 0).subarray(0, 32), out),
      // value / ledger (delegated to Layer 2; return the contract's new balance per qpi_spectrum_impl.h)
      transfer: (destOff: number, amount: bigint) => {
        const dest = u8().slice(destOff, destOff + 32);
        const r = this.host.transfer(this.slot, dest, amount, 2 /*qpiTransfer*/);
        this.recHost("transfer", () => `→ ${shortId(dest)} ${amount}${r < 0n ? " ✗" : ""}`);
        return r;
      },
      transferTyped: (destOff: number, amount: bigint, type: number) => {
        const dest = u8().slice(destOff, destOff + 32);
        const r = this.host.transfer(this.slot, dest, amount, type & 0xff);
        this.recHost("transfer", () => `→ ${shortId(dest)} ${amount} (type ${type & 0xff})${r < 0n ? " ✗" : ""}`);
        return r;
      },
      burn: (amount: bigint, burnedFor: number) => {
        const r = this.host.burn(this.slot, amount, burnedFor >>> 0);
        this.recHost("burn", () => `${amount}${r < 0n ? " ✗" : ""}`);
        return r;
      },
      // assets / shares
      isAssetIssued: (issOff: number, name: bigint) => this.host.isAssetIssued(u8().slice(issOff, issOff + 32), name),
      issueAsset: (name: bigint, issOff: number, dec: number, shares: bigint, unit: bigint) => {
        const r = this.host.issueAsset(this.slot, name, u8().slice(issOff, issOff + 32), (dec << 24) >> 24, shares, unit, ctxView().invocator);
        this.recHost("issueAsset", () => `${assetName(name)} shares=${shares}`);
        return r;
      },
      numberOfShares: (aOff: number, oOff: number, pOff: number) =>
        this.host.numberOfShares(u8().slice(aOff, aOff + 40), u8().slice(oOff, oOff + 40), u8().slice(pOff, pOff + 40)),
      numberOfPossessedShares: (name: bigint, issOff: number, ownOff: number, posOff: number, ownMgmt: number, posMgmt: number) =>
        this.host.numberOfPossessedShares(name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), ownMgmt & 0xffff, posMgmt & 0xffff),
      // Asset enumeration for the contract-side AssetOwnership/PossessionIterator (via the wasm shim): write each
      // matching record (owner@0, possessor@32, shares@64, ownMgmt@72, posMgmt@74 — 80 bytes) to the contract's
      // outBuf and return the count. issuance=40B (Asset), ownSel/posSel=36B (AssetOwnership/PossessionSelect).
      assetEnumerate: (kind: number, issOff: number, ownOff: number, posOff: number, outOff: number, maxN: number) => {
        const entries = this.host.assetEnumerate(u8().slice(issOff, issOff + 40), u8().slice(ownOff, ownOff + 36), u8().slice(posOff, posOff + 36), kind >>> 0);
        const n = Math.min(entries.length, maxN >>> 0);
        const mem = u8();
        const dv = new DataView(this.mem.buffer);
        let p = outOff >>> 0;
        for (let i = 0; i < n; i++) {
          const e = entries[i];
          mem.set(e.owner.subarray(0, 32), p);
          mem.set(e.possessor.subarray(0, 32), p + 32);
          dv.setBigInt64(p + 64, e.shares, true);
          dv.setUint16(p + 72, e.ownMgmt & 0xffff, true);
          dv.setUint16(p + 74, e.posMgmt & 0xffff, true);
          p += 80;
        }
        return n;
      },
      transferShareOwnershipAndPossession: (name: bigint, issOff: number, ownOff: number, posOff: number, shares: bigint, newOwnerOff: number) => {
        const newOwner = u8().slice(newOwnerOff, newOwnerOff + 32);
        const r = this.host.transferShares(this.slot, name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), shares, newOwner);
        this.recHost("transferShares", () => `${assetName(name)} ${shares} → ${shortId(newOwner)}`);
        return r;
      },
      // share management rights — qpi acquireShares / releaseShares (qpi_asset_impl.h). The lhost imports are
      // provided here; a wasm contract reaches them once the qpi wasm binding declares the imports.
      acquireShares: (name: bigint, issOff: number, ownOff: number, posOff: number, shares: bigint, srcOwnMgmt: number, srcPosMgmt: number, fee: bigint) => {
        const r = this.host.acquireShares(this.slot, name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), shares, srcOwnMgmt & 0xffff, srcPosMgmt & 0xffff, fee);
        this.recHost("acquireShares", () => `${assetName(name)} ${shares} ← mgmt ${srcPosMgmt & 0xffff}`);
        return r;
      },
      releaseShares: (name: bigint, issOff: number, ownOff: number, posOff: number, shares: bigint, dstOwnMgmt: number, dstPosMgmt: number, fee: bigint) => {
        const r = this.host.releaseShares(this.slot, name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), shares, dstOwnMgmt & 0xffff, dstPosMgmt & 0xffff, fee);
        this.recHost("releaseShares", () => `${assetName(name)} ${shares} → mgmt ${dstPosMgmt & 0xffff}`);
        return r;
      },
      // date / signature / IPO / mining / oracle-status — see HostServices (the dev engine stubs IPO/mining/oracle)
      dayOfWeek: (year: number, month: number, day: number) => this.host.dayOfWeek(year & 0xff, month & 0xff, day & 0xff),
      signatureValidity: (entOff: number, digOff: number, sigOff: number) =>
        this.host.signatureValidity(u8().slice(entOff, entOff + 32), u8().slice(digOff, digOff + 32), u8().slice(sigOff, sigOff + 64)),
      bidInIPO: (idx: number, price: bigint, qty: number) => this.host.bidInIPO(this.slot, idx >>> 0, price, qty >>> 0),
      ipoBidId: (idx: number, bid: number, outOff: number) => {
        u8().set(this.host.ipoBidId(idx >>> 0, bid >>> 0).subarray(0, 32), outOff);
      },
      ipoBidPrice: (idx: number, bid: number) => this.host.ipoBidPrice(idx >>> 0, bid >>> 0),
      computeMiningFunction: (sOff: number, pkOff: number, nOff: number, outOff: number) => {
        u8().set(this.host.computeMiningFunction(u8().slice(sOff, sOff + 32), u8().slice(pkOff, pkOff + 32), u8().slice(nOff, nOff + 32)).subarray(0, 32), outOff);
      },
      initMiningSeed: (sOff: number) => this.host.initMiningSeed(u8().slice(sOff, sOff + 32)),
      getOracleQueryStatus: (queryId: bigint) => this.host.getOracleQueryStatus(queryId),
      unsubscribeOracle: (sub: number) => this.host.unsubscribeOracle(sub | 0),
      // oracle query/subscribe/read — the query/reply are opaque sized buffers (the contract owns the typing)
      queryOracle: (ifaceIdx: number, queryOff: number, querySize: number, procId: number, timeout: number, fee: bigint) =>
        this.host.queryOracle(this.slot, ifaceIdx >>> 0, u8().slice(queryOff, queryOff + querySize), procId >>> 0, timeout >>> 0, fee),
      subscribeOracle: (ifaceIdx: number, queryOff: number, querySize: number, procId: number, period: number, notifyPrev: number, fee: bigint) =>
        this.host.subscribeOracle(this.slot, ifaceIdx >>> 0, u8().slice(queryOff, queryOff + querySize), procId >>> 0, period >>> 0, notifyPrev !== 0, fee),
      getOracleQuery: (queryId: bigint, outOff: number, size: number) => {
        const q = this.host.getOracleQuery(queryId);
        if (!q) {
          return 0;
        }
        u8().set(q.subarray(0, size), outOff);
        return 1;
      },
      getOracleReply: (queryId: bigint, outOff: number, size: number) => {
        const r = this.host.getOracleReply(queryId);
        if (!r) {
          return 0;
        }
        u8().set(r.subarray(0, size), outOff);
        return 1;
      },
      distributeDividends: (amountPerShare: bigint) => {
        const r = this.host.distributeDividends(this.slot, amountPerShare);
        this.recHost("distributeDividends", () => `${amountPerShare}/share`);
        return r;
      },
      // inter-contract: in/out are offsets in the CALLER's memory; route to the callee Contract, write the
      // result back, return the InterContractCallError code. The callee's originator propagates from the
      // caller's QpiContext header.
      liteCallFunction: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = ctxView().originator;
        const r = this.host.callFunction(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, originator);
        this.recHost("callFunction", () => `→ @${calleeIdx >>> 0} fn #${inputType & 0xffff}${r.error ? ` ✗ err ${r.error}` : ""}`);
        if (r.error === 0 && r.output.length) u8().set(r.output.subarray(0, Math.min(outSize, r.output.length)), outOff);
        return r.error;
      },
      liteInvokeProcedure: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number, reward: bigint) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = ctxView().originator;
        const r = this.host.invokeProcedure(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, reward, originator);
        this.recHost("invokeProcedure", () => `→ @${calleeIdx >>> 0} proc #${inputType & 0xffff} reward=${reward}${r.error ? ` ✗ err ${r.error}` : ""}`);
        if (r.error === 0 && r.output.length) u8().set(r.output.subarray(0, Math.min(outSize, r.output.length)), outOff);
        return r.error;
      },
      liteSetShareholderProposal: (calleeIdx: number, propOff: number, reward: bigint) => {
        const proposal = u8().slice(propOff, propOff + 1024);
        const originator = ctxView().originator;
        return this.host.setShareholderProposal(this.slot, calleeIdx >>> 0, proposal, reward, originator);
      },
      liteSetShareholderVotes: (calleeIdx: number, voteOff: number, voteSize: number, reward: bigint) => {
        const vote = u8().slice(voteOff, voteOff + voteSize);
        const originator = ctxView().originator;
        return this.host.setShareholderVotes(this.slot, calleeIdx >>> 0, vote, reward, originator);
      },
    };
    this.meterLhost(lhost);
    // WASI: contracts link a few wasi-libc stdio stubs (fd_write/fd_seek/fd_close) via malloc/abort paths;
    // a correct run never calls them. Any unlisted import returns 0 (ESUCCESS); proc_exit throws.
    const wasi = new Proxy(
      { proc_exit: (c: number) => { throw new Error("wasm proc_exit(" + c + ")"); } } as Record<string, Function>,
      { get: (t, p: string) => (p in t ? t[p] : () => 0) },
    );
    // `env.*` imports come from `--allow-undefined`; stub each per envImportStub (see its doc).
    const env = new Proxy({} as Record<string, Function>, { get: (_t, p: string) => envImportStub(p) });
    return { lhost, env, wasi_snapshot_preview1: wasi } as unknown as WebAssembly.Imports;
  }
}

// A compact label for a 32-byte id in a host-call detail line: a contract id (id(slot,0,0,0)) shows as
// `@slot`, any other identity as a short hex prefix.
function shortId(id: Uint8Array): string {
  let high = false;
  for (let i = 8; i < 32; i++) {
    if (id[i] !== 0) {
      high = true;
      break;
    }
  }
  if (!high) {
    return "@" + new DataView(id.buffer, id.byteOffset, id.byteLength).getBigUint64(0, true).toString();
  }
  return toHex(id.subarray(0, 6)) + "…";
}

// qpi packs an asset name as up to 7 ASCII bytes little-endian in a uint64 — decode it back to text for the
// host-call detail (falls back to the numeric value if it isn't printable).
function assetName(name: bigint): string {
  let s = "";
  let n = name;
  for (let i = 0; i < 7 && n > 0n; i++) {
    const b = Number(n & 0xffn);
    if (b >= 0x20 && b < 0x7f) {
      s += String.fromCharCode(b);
    }
    n >>= 8n;
  }
  return s || name.toString();
}
