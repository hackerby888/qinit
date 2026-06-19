// Layer 1 — wasm-host-runtime. The TypeScript port of the node's WASM host shim
// (core-lite: src/extensions/lite_wasm_contracts.h + lite_wasm_imports.h), driving the browser/Bun
// `WebAssembly` API instead of WAMR. One Contract == one WebAssembly.Instance of a built contract .wasm.
// The contract bytes run unchanged; this supplies the "lhost" import table, the per-call marshalling, and
// the resident-state digest. See plan: /home/kali/.claude/plans/resilient-exploring-stonebraker.md
import { k12Bytes, toHex } from "./k12";
import type { TraceRecorder } from "./trace";

const EMPTY = new Uint8Array(0);

export const KIND = { FUNCTION: 0, PROCEDURE: 1, SYSPROC: 2 } as const;

// System-procedure ids — LiteSysProcId order (core-lite: src/extensions/lite_dyn_abi.h).
export const SP = {
  INITIALIZE: 0, BEGIN_EPOCH: 1, END_EPOCH: 2, BEGIN_TICK: 3, END_TICK: 4,
  PRE_RELEASE_SHARES: 5, PRE_ACQUIRE_SHARES: 6, POST_RELEASE_SHARES: 7, POST_ACQUIRE_SHARES: 8,
  POST_INCOMING_TRANSFER: 9, SET_SHAREHOLDER_PROPOSAL: 10, SET_SHAREHOLDER_VOTES: 11,
} as const;

// IO carve inside the contract's io_base region: [in 64K | out 64K | locals 32K | arena].
// MUST match LITE_WASM_*_SZ in core-lite src/extensions/lite_wasm_contracts.h.
const IN_SZ = 64 * 1024, OUT_SZ = 64 * 1024, LOCALS_SZ = 32 * 1024;

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
  markDirty(slot: number): void;
  log(slot: number, level: number, msg: Uint8Array): void;
  transfer(slot: number, dest: Uint8Array, amount: bigint, transferType: number): bigint;
  burn(slot: number, amount: bigint, burnedFor: number): bigint;
  getEntity(id: Uint8Array): Entity | null;
  issueAsset(slot: number, name: bigint, issuer: Uint8Array, decimals: number, shares: bigint, unit: bigint, invocator: Uint8Array): bigint;
  isAssetIssued(issuer: Uint8Array, name: bigint): number;
  numberOfShares(asset: Uint8Array, ownSel: Uint8Array, posSel: Uint8Array): bigint;
  numberOfPossessedShares(name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, ownMgmt: number, posMgmt: number): bigint;
  transferShares(slot: number, name: bigint, issuer: Uint8Array, owner: Uint8Array, possessor: Uint8Array, shares: bigint, newOwner: Uint8Array): bigint;
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
  private outSizes = new Map<string, number>();   // user entries: "kind:it" -> outSize
  private sysOutSizes = new Map<number, number>(); // sysproc id -> outSize
  entries: { it: number; kind: number; inSize: number; outSize: number }[] = []; // registered fns/procs
  trace?: TraceRecorder; // set by the Sim when debug tracing is on

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

  // Build the 256-byte QpiContext header the contract reads (currentContract*, originator, invocator,
  // invocationReward, entryPoint) — qpi.h QpiContext field layout (offsets 0/4/8/40/72/104/112).
  private writeCtx(ctx: CallCtx) {
    const u8 = this.u8();
    const base = this.ctxAddr;
    u8.fill(0, base, base + 256);
    const dv = new DataView(this.mem.buffer);
    dv.setUint32(base + 0, this.slot >>> 0, true); // _currentContractIndex
    dv.setInt32(base + 4, -1, true); // _stackIndex
    dv.setBigUint64(base + 8, BigInt(this.slot), true); // _currentContractId = id(slot,0,0,0)
    if (ctx.originator && ctx.originator.length >= 32) u8.set(ctx.originator.subarray(0, 32), base + 40);
    if (ctx.invocator && ctx.invocator.length >= 32) u8.set(ctx.invocator.subarray(0, 32), base + 72);
    dv.setBigInt64(base + 104, ctx.invocationReward ?? 0n, true); // _invocationReward
    dv.setUint8(base + 112, (ctx.entryPoint ?? 0) & 0xff); // _entryPoint
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

    // Debug trace (opt-in): snapshot state, open an entry, time the dispatch, capture a trap. Nesting
    // (inter-contract calls / sysprocs) is handled by the recorder's stack — each invoke is one entry.
    const rec = this.trace?.enabled ? this.trace : null;
    const stateBefore = rec ? this.state() : EMPTY;
    const e = rec ? rec.begin({ tick: this.host.tick(), index: this.slot, entry: it, kind, invocator: ctx.invocator, invocationReward: ctx.invocationReward ?? 0n, input, stateBefore }) : null;
    const t0 = rec ? performance.now() : 0;

    try {
      this.ex.dispatch(kind >>> 0, it >>> 0, inOff >>> 0, outOff >>> 0, localsOff >>> 0);
    } catch (err) {
      if (rec) {
        rec.end(e, { output: EMPTY, ok: false, trap: trapMessage(err), stateBefore, stateAfter: this.state(), execNs: (performance.now() - t0) * 1e6 });
      }
      throw err;
    }

    const output = this.u8().slice(outOff, outOff + outSize); // fresh view after dispatch
    if (rec) {
      rec.end(e, { output, ok: true, stateBefore, stateAfter: this.state(), execNs: (performance.now() - t0) * 1e6 });
    }
    return output;
  }

  state(): Uint8Array {
    return this.u8().slice(this.stateAddr, this.stateAddr + this.stateSize);
  }
  digest(): string {
    return toHex(k12Bytes(this.state()));
  }

  // The "lhost" import table (core-lite src/extensions/lite_wasm_imports.h LHOST_TABLE) + WASI stubs.
  // The contract wires only the subset it declares; extras are ignored. Effectful ledger/asset/inter-contract
  // ops throw loudly (not silently wrong) until Layer 2 models them.
  private imports(): WebAssembly.Imports {
    const u8 = () => this.u8();
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
      numberOfTickTransactions: () => 0,
      day: () => 0, year: () => 0, hour: () => 0, minute: () => 0, month: () => 0, second: () => 0,
      millisecond: () => 0,
      now: (out: number) => u8().fill(0, out, out + 8),
      // etalon-tick digests (zeroed in the sim)
      prevSpectrumDigest: (out: number) => u8().fill(0, out, out + 32),
      prevUniverseDigest: (out: number) => u8().fill(0, out, out + 32),
      prevComputerDigest: (out: number) => u8().fill(0, out, out + 32),
      // identity / spectrum
      getEntity: (idOff: number, entityOff: number) => {
        const id = u8().slice(idOff, idOff + 32);
        const e = this.host.getEntity(id);
        const dv = new DataView(this.mem.buffer);
        u8().set(id, entityOff); // QPI::Entity.publicKey
        dv.setBigInt64(entityOff + 32, e ? e.incomingAmount : 0n, true);
        dv.setBigInt64(entityOff + 40, e ? e.outgoingAmount : 0n, true);
        dv.setUint32(entityOff + 48, e ? e.numberOfIncomingTransfers : 0, true);
        dv.setUint32(entityOff + 52, e ? e.numberOfOutgoingTransfers : 0, true);
        dv.setUint32(entityOff + 56, e ? e.latestIncomingTransferTick : 0, true);
        dv.setUint32(entityOff + 60, e ? e.latestOutgoingTransferTick : 0, true);
        return e ? 1 : 0;
      },
      queryFeeReserve: (_ci: number) => 1000000n,          // positive so any BEGIN/END_TICK gating passes
      nextId: (idOff: number, outOff: number) => {
        u8().set(this.host.nextId(u8().slice(idOff, idOff + 32)), outOff);
      },
      prevId: (idOff: number, outOff: number) => {
        u8().set(this.host.prevId(u8().slice(idOff, idOff + 32)), outOff);
      },
      isContractId: (_id: number) => 0,
      arbitrator: (out: number) => u8().fill(0, out, out + 32),
      computor: (_i: number, out: number) => u8().fill(0, out, out + 32),
      // value / ledger (delegated to Layer 2; return the contract's new balance per qpi_spectrum_impl.h)
      transfer: (destOff: number, amount: bigint) =>
        this.host.transfer(this.slot, u8().slice(destOff, destOff + 32), amount, 2 /*qpiTransfer*/),
      transferTyped: (destOff: number, amount: bigint, type: number) =>
        this.host.transfer(this.slot, u8().slice(destOff, destOff + 32), amount, type & 0xff),
      burn: (amount: bigint, burnedFor: number) =>
        this.host.burn(this.slot, amount, burnedFor >>> 0),
      // assets / shares
      isAssetIssued: (issOff: number, name: bigint) => this.host.isAssetIssued(u8().slice(issOff, issOff + 32), name),
      issueAsset: (name: bigint, issOff: number, dec: number, shares: bigint, unit: bigint) =>
        this.host.issueAsset(this.slot, name, u8().slice(issOff, issOff + 32), (dec << 24) >> 24, shares, unit, u8().slice(this.ctxAddr + 72, this.ctxAddr + 104)),
      numberOfShares: (aOff: number, oOff: number, pOff: number) =>
        this.host.numberOfShares(u8().slice(aOff, aOff + 40), u8().slice(oOff, oOff + 40), u8().slice(pOff, pOff + 40)),
      numberOfPossessedShares: (name: bigint, issOff: number, ownOff: number, posOff: number, ownMgmt: number, posMgmt: number) =>
        this.host.numberOfPossessedShares(name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), ownMgmt & 0xffff, posMgmt & 0xffff),
      transferShareOwnershipAndPossession: (name: bigint, issOff: number, ownOff: number, posOff: number, shares: bigint, newOwnerOff: number) =>
        this.host.transferShares(this.slot, name, u8().slice(issOff, issOff + 32), u8().slice(ownOff, ownOff + 32), u8().slice(posOff, posOff + 32), shares, u8().slice(newOwnerOff, newOwnerOff + 32)),
      distributeDividends: (amountPerShare: bigint) => this.host.distributeDividends(this.slot, amountPerShare),
      // inter-contract: in/out are offsets in the CALLER's memory; route to the callee Contract, write the
      // result back, return the InterContractCallError code. The callee's originator propagates from the
      // caller's ctx header (offset 40).
      liteCallFunction: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = u8().slice(this.ctxAddr + 40, this.ctxAddr + 72);
        const r = this.host.callFunction(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, originator);
        if (r.error === 0 && r.output.length) u8().set(r.output.subarray(0, Math.min(outSize, r.output.length)), outOff);
        return r.error;
      },
      liteInvokeProcedure: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number, reward: bigint) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = u8().slice(this.ctxAddr + 40, this.ctxAddr + 72);
        const r = this.host.invokeProcedure(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, reward, originator);
        if (r.error === 0 && r.output.length) u8().set(r.output.subarray(0, Math.min(outSize, r.output.length)), outOff);
        return r.error;
      },
      liteSetShareholderProposal: (calleeIdx: number, propOff: number, reward: bigint) => {
        const proposal = u8().slice(propOff, propOff + 1024);
        const originator = u8().slice(this.ctxAddr + 40, this.ctxAddr + 72);
        return this.host.setShareholderProposal(this.slot, calleeIdx >>> 0, proposal, reward, originator);
      },
      liteSetShareholderVotes: (calleeIdx: number, voteOff: number, voteSize: number, reward: bigint) => {
        const vote = u8().slice(voteOff, voteOff + voteSize);
        const originator = u8().slice(this.ctxAddr + 40, this.ctxAddr + 72);
        return this.host.setShareholderVotes(this.slot, calleeIdx >>> 0, vote, reward, originator);
      },
    };
    // WASI: contracts link a few wasi-libc stdio stubs (fd_write/fd_seek/fd_close) via malloc/abort paths;
    // a correct run never calls them. Any unlisted import returns 0 (ESUCCESS); proc_exit throws.
    const wasi = new Proxy(
      { proc_exit: (c: number) => { throw new Error("wasm proc_exit(" + c + ")"); } } as Record<string, Function>,
      { get: (t, p: string) => (p in t ? t[p] : () => 0) },
    );
    // `env.*` imports come from `--allow-undefined` (e.g. qpi.h ASSERT's addDebugMessageAssert). They are
    // assert/diagnostic helpers that never fire on a correct run — no-op them.
    const env = new Proxy({} as Record<string, Function>, { get: () => () => 0 });
    return { lhost, env, wasi_snapshot_preview1: wasi } as unknown as WebAssembly.Imports;
  }
}
