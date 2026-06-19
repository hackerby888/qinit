// Layer 1 — wasm-host-runtime. The TypeScript port of the node's WASM host shim
// (core-lite: src/extensions/lite_wasm_contracts.h + lite_wasm_imports.h), driving the browser/Bun
// `WebAssembly` API instead of WAMR. One Contract == one WebAssembly.Instance of a built contract .wasm.
// The contract bytes run unchanged; this supplies the "lhost" import table, the per-call marshalling, and
// the resident-state digest. See plan: /home/kali/.claude/plans/resilient-exploring-stonebraker.md
import { k12Bytes, toHex } from "./k12";

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

// The chain-sim (Layer 2) injects these; Layer 1 stays pure mechanics.
export interface HostServices {
  tick(): number;
  epoch(): number;
  markDirty(slot: number): void;
  log(slot: number, level: number, msg: Uint8Array): void;
}

export class ContractAbort extends Error {
  constructor(public code: number) { super("contract abort " + code); }
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

  // Marshal one call through the instance (mirrors liteWasmDispatch): write ctx header + input, zero output,
  // call dispatch(kind,it,inOff,outOff,localsOff), copy the output back out.
  invoke(kind: number, it: number, input: Uint8Array = new Uint8Array(0)): Uint8Array {
    const inOff = this.ioBase;
    const outOff = this.ioBase + IN_SZ;
    const localsOff = this.ioBase + IN_SZ + OUT_SZ;
    const outSize = this.outSizeFor(kind, it);
    const pre = this.u8();
    pre.fill(0, this.ctxAddr, this.ctxAddr + 256);        // zeroed QpiContext header (MVP: no ctx-field reads yet)
    pre.fill(0, outOff, outOff + OUT_SZ);
    if (input.length) pre.set(input, inOff);
    this.arenaBump = this.arenaBase;
    this.ex.dispatch(kind >>> 0, it >>> 0, inOff >>> 0, outOff >>> 0, localsOff >>> 0);
    return this.u8().slice(outOff, outOff + outSize);     // fresh view after dispatch
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
    const nyi = (name: string) => () => {
      throw new Error("host import unimplemented in MVP: " + name);
    };
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
      // identity / spectrum (MVP: not modeled)
      getEntity: nyi("getEntity"),
      queryFeeReserve: (_ci: number) => 1000000n,          // positive so any BEGIN/END_TICK gating passes
      nextId: nyi("nextId"),
      prevId: nyi("prevId"),
      isContractId: (_id: number) => 0,
      arbitrator: (out: number) => u8().fill(0, out, out + 32),
      computor: (_i: number, out: number) => u8().fill(0, out, out + 32),
      // value / ledger
      transfer: nyi("transfer"),
      transferTyped: nyi("transferTyped"),
      burn: nyi("burn"),
      // assets / shares
      isAssetIssued: () => 0,
      issueAsset: nyi("issueAsset"),
      numberOfShares: () => 0n,
      numberOfPossessedShares: () => 0n,
      transferShareOwnershipAndPossession: nyi("transferShareOwnershipAndPossession"),
      distributeDividends: nyi("distributeDividends"),
      // inter-contract
      liteCallFunction: nyi("liteCallFunction"),
      liteInvokeProcedure: nyi("liteInvokeProcedure"),
      liteSetShareholderProposal: nyi("liteSetShareholderProposal"),
      liteSetShareholderVotes: nyi("liteSetShareholderVotes"),
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
