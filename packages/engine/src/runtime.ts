import {
  ASSET_ENUMERATION_RECORD,
  LHOST_ABI,
  SYSTEM_PROCEDURES,
} from "@qinit/core";
import { k12Bytes, toHex } from "./k12";
import { bytesEqual } from "./bytes";
import { TRACE_STATE_CAP, type TraceRecorder } from "./trace";
import { QpiContext } from "./abi";
import { EntityRecord, M256i } from "./wire";
import { validateContractIndexSignature } from "./wasm-contract-index";

const EMPTY = new Uint8Array(0);

const ENV_NOOP = new Set(["addDebugMessageAssert"]);

export function envImportStub(name: string): Function {
  if (typeof name !== "string" || ENV_NOOP.has(name)) {
    return () => 0;
  }
  return () => {
    throw new Error(
      `missing host import 'env.${name}' was called — the contract uses a symbol the wasm build did not compile in and the engine host does not provide`,
    );
  };
}

export const KIND = { FUNCTION: 0, PROCEDURE: 1, SYSPROC: 2, MIGRATE: 3 } as const;

export const SP = SYSTEM_PROCEDURES;

// Must match the I/O layout in contract_slots.h.
const IN_SZ = 64 * 1024;
const OUT_SZ = 64 * 1024;
const LOCALS_SZ = 32 * 1024;

const BASE_CALL_COST = 10n;
const DIGEST_BYTE_COST = 1n;
const HOST_WEIGHT: Record<string, bigint> = {
  k12: 5n,
  getEntity: 1n,
  nextId: 2n,
  prevId: 2n,
  logBytes: 1n,
  transfer: 10n,
  transferTyped: 10n,
  burn: 10n,
  isAssetIssued: 2n,
  issueAsset: 50n,
  numberOfShares: 5n,
  numberOfPossessedShares: 3n,
  transferShareOwnershipAndPossession: 20n,
  distributeDividends: 20n,
  acquireShares: 30n,
  releaseShares: 30n,
  dayOfWeek: 1n,
  signatureValidity: 5n,
  bidInIPO: 10n,
  ipoBidId: 2n,
  ipoBidPrice: 2n,
  computeMiningFunction: 5n,
  initMiningSeed: 2n,
  getOracleQueryStatus: 1n,
  unsubscribeOracle: 5n,
  queryOracle: 20n,
  subscribeOracle: 20n,
  getOracleQuery: 3n,
  getOracleReply: 3n,
  liteCallFunction: 20n,
  liteInvokeProcedure: 20n,
  liteSetShareholderProposal: 20n,
  liteSetShareholderVotes: 20n,
};

export function dateFields(ms: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  milli: number;
} {
  const date = new Date(ms);

  return {
    year: (date.getUTCFullYear() - 2000) & 0xff,
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    milli: date.getUTCMilliseconds(),
  };
}

export function packDateAndTime(ms: number): bigint {
  const fields = dateFields(ms);

  return (
    (BigInt(fields.year + 2000) << 46n) |
    (BigInt(fields.month) << 42n) |
    (BigInt(fields.day) << 37n) |
    (BigInt(fields.hour) << 32n) |
    (BigInt(fields.minute) << 26n) |
    (BigInt(fields.second) << 20n) |
    (BigInt(fields.milli) << 10n)
  );
}

export interface Entity {
  incomingAmount: bigint;
  outgoingAmount: bigint;
  numberOfIncomingTransfers: number;
  numberOfOutgoingTransfers: number;
  latestIncomingTransferTick: number;
  latestOutgoingTransferTick: number;
}

export interface HostServices {
  tick(): number;
  epoch(): number;
  nowMs(): number;
  numberOfTickTransactions(): number;
  markDirty(slot: number): void;
  log(slot: number, level: number, msg: Uint8Array): void;
  pauseLog(): void;
  resumeLog(): void;
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
  issueAsset(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    decimals: number,
    shares: bigint,
    unit: bigint,
    invocator: Uint8Array,
  ): bigint;
  isAssetIssued(issuer: Uint8Array, name: bigint): number;
  numberOfShares(asset: Uint8Array, ownSel: Uint8Array, posSel: Uint8Array): bigint;
  numberOfPossessedShares(
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    ownMgmt: number,
    posMgmt: number,
  ): bigint;
  assetEnumerate(
    asset: Uint8Array,
    ownSel: Uint8Array,
    posSel: Uint8Array,
    kind: number,
  ): {
    owner: Uint8Array;
    possessor: Uint8Array;
    shares: bigint;
    ownMgmt: number;
    posMgmt: number;
  }[];
  transferShares(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    newOwner: Uint8Array,
  ): bigint;
  acquireShares(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    srcOwnMgmt: number,
    srcPosMgmt: number,
    offeredFee: bigint,
  ): bigint;
  releaseShares(
    slot: number,
    name: bigint,
    issuer: Uint8Array,
    owner: Uint8Array,
    possessor: Uint8Array,
    shares: bigint,
    dstOwnMgmt: number,
    dstPosMgmt: number,
    offeredFee: bigint,
  ): bigint;
  dayOfWeek(year: number, month: number, day: number): number;
  signatureValidity(entity: Uint8Array, digest: Uint8Array, signature: Uint8Array): number;
  bidInIPO(slot: number, ipoContractIndex: number, price: bigint, quantity: number): bigint;
  ipoBidId(ipoContractIndex: number, ipoBidIndex: number): Uint8Array;
  ipoBidPrice(ipoContractIndex: number, ipoBidIndex: number): bigint;
  computeMiningFunction(
    miningSeed: Uint8Array,
    publicKey: Uint8Array,
    nonce: Uint8Array,
  ): Uint8Array;
  initMiningSeed(miningSeed: Uint8Array): void;
  getOracleQueryStatus(queryId: bigint): number;
  unsubscribeOracle(slot: number, oracleSubscriptionId: number): number;
  queryOracle(
    slot: number,
    interfaceIndex: number,
    query: Uint8Array,
    replySize: number,
    notificationProcId: number,
    timeoutMillisec: number,
    fee: bigint,
  ): bigint;
  subscribeOracle(
    slot: number,
    interfaceIndex: number,
    query: Uint8Array,
    replySize: number,
    timestampOffset: number,
    notificationProcId: number,
    periodMillisec: number,
    notifyPrev: boolean,
    fee: bigint,
  ): number;
  getOracleQuery(queryId: bigint): Uint8Array | null;
  getOracleReply(queryId: bigint): Uint8Array | null;
  distributeDividends(slot: number, amountPerShare: bigint): number;
  callFunction(
    callerSlot: number,
    calleeIdx: number,
    inputType: number,
    input: Uint8Array,
    originator: Uint8Array,
  ): { error: number; output: Uint8Array };
  invokeProcedure(
    callerSlot: number,
    calleeIdx: number,
    inputType: number,
    input: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): { error: number; output: Uint8Array };
  nextId(id: Uint8Array): Uint8Array;
  prevId(id: Uint8Array): Uint8Array;
  setShareholderProposal(
    callerSlot: number,
    calleeIdx: number,
    proposal: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): number;
  setShareholderVotes(
    callerSlot: number,
    calleeIdx: number,
    vote: Uint8Array,
    reward: bigint,
    originator: Uint8Array,
  ): number;
}

export interface CallCtx {
  invocator?: Uint8Array;
  originator?: Uint8Array;
  invocationReward?: bigint;
  entryPoint?: number;
}

export class ContractAbort extends Error {
  constructor(public code: number) {
    super("contract abort " + code);
  }
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
  ioBase = 0;
  stateAddr = 0;
  stateSize = 0;
  ctxAddr = 0;
  arenaBase = 0;
  arenaStart = 0;
  arenaTop = 0;
  arenaEnd = 0;
  sysMask = 0;
  metering = false;
  private dispatchDepth = 0;
  cost = 0n;
  lastCost = 0n;
  private inSizes = new Map<string, number>();
  private outSizes = new Map<string, number>();
  private sysInSizes = new Map<number, number>();
  private sysOutSizes = new Map<number, number>();
  entries: {
    it: number;
    kind: number;
    inSize: number;
    outSize: number;
  }[] = [];
  trace?: TraceRecorder;
  hasMigrate = false;
  migrateOldStateSize = 0;
  migrateLocalsSize = 0;
  everInitialized = false;

  private extMem?: WebAssembly.Memory;
  private extraImports?: WebAssembly.Imports;

  get sharedMem(): boolean {
    return !!this.extMem;
  }

  private constructor(
    public slot: number,
    public host: HostServices,
    wasmModule: WebAssembly.Module,
    externalMemory?: WebAssembly.Memory,
    extraImports?: WebAssembly.Imports,
  ) {
    this.extMem = externalMemory;
    this.extraImports = extraImports;

    if (externalMemory) {
      for (const imported of WebAssembly.Module.imports(wasmModule)) {
        if (imported.module === "env" && imported.kind === "memory") {
          const minimumPages =
            (((imported as any).type?.minimum ?? 0) as number) >>> 0;
          const currentPages = Math.ceil(
            externalMemory.buffer.byteLength / 65536,
          );

          if (currentPages < minimumPages) {
            externalMemory.grow(minimumPages - currentPages);
          }
        }
      }
    }

    this.inst = new WebAssembly.Instance(
      wasmModule,
      this.imports(wasmModule),
    );
    this.ex = this.inst.exports;

    let compiledSlot: number;

    try {
      compiledSlot = this.ex.contract_index() >>> 0;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`contract_index() failed for target ${slot}: ${detail}`);
    }

    if (compiledSlot !== slot) {
      throw new Error(
        `artifact slot mismatch: compiled ${compiledSlot}, target ${slot}`,
      );
    }

    this.mem =
      (this.ex.memory as WebAssembly.Memory) ?? externalMemory;
    this.ioBase = this.ex.io_base() >>> 0;
    this.stateAddr = this.ex.state_addr() >>> 0;
    this.stateSize = this.ex.state_size() >>> 0;
    this.ctxAddr = this.ex.ctx_addr() >>> 0;
    this.arenaBase = this.ioBase + IN_SZ + OUT_SZ + LOCALS_SZ;
    this.arenaStart = this.arenaBase;
    this.arenaTop = this.arenaBase;
    this.arenaEnd = this.ioBase + (this.ex.io_size() >>> 0);

    if (externalMemory && this.stateSize > 0) {
      new Uint8Array(this.mem.buffer).fill(
        0,
        this.stateAddr,
        this.stateAddr + this.stateSize,
      );
    }
    if (typeof this.ex._initialize === "function") {
      this.ex._initialize();
    }

    this.readRegistry();
  }

  static load(
    bytes: Uint8Array,
    slot: number,
    host: HostServices,
    externalMemory?: WebAssembly.Memory,
    extraImports?: WebAssembly.Imports,
  ): Contract {
    validateContractIndexSignature(bytes);
    const wasmModule = new WebAssembly.Module(bytes as BufferSource);
    const hasLegacyArena = WebAssembly.Module.exports(wasmModule).some(
      (entry) => entry.name === "arena_top",
    );

    if (hasLegacyArena) {
      throw new Error("legacy arena_top export is not supported");
    }

    return new Contract(
      slot,
      host,
      wasmModule,
      externalMemory,
      extraImports,
    );
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
    // reg_count() also initializes the contract's lazy registry.
    const entryCount = this.ex.reg_count() >>> 0;
    const infoOffset = this.ioBase;

    for (let index = 0; index < entryCount; index++) {
      this.ex.reg_info(index >>> 0, infoOffset >>> 0);
      const view = this.dv();
      const inputType = view.getUint32(infoOffset, true);
      const kind = view.getUint32(infoOffset + 4, true);
      const inSize = view.getUint32(infoOffset + 8, true);
      const outSize = view.getUint32(infoOffset + 12, true);

      this.entries.push({ it: inputType, kind, inSize, outSize });
      this.inSizes.set(kind + ":" + inputType, inSize);
      this.outSizes.set(kind + ":" + inputType, outSize);
    }

    for (let systemProcedure = 0; systemProcedure < 12; systemProcedure++) {
      if ((this.sysMask >>> systemProcedure) & 1) {
        this.sysInSizes.set(
          systemProcedure,
          this.ex.sysproc_in_size(systemProcedure >>> 0) >>> 0,
        );
        this.sysOutSizes.set(
          systemProcedure,
          this.ex.sysproc_out_size(systemProcedure >>> 0) >>> 0,
        );
      }
    }

    if (typeof this.ex.has_migrate === "function") {
      this.hasMigrate = this.ex.has_migrate() >>> 0 === 1;
      this.migrateOldStateSize = (this.ex.migrate_old_state_size?.() ?? 0) >>> 0;
      this.migrateLocalsSize = (this.ex.migrate_locals_size?.() ?? 0) >>> 0;
    }
  }

  hasSysproc(systemProcedure: number): boolean {
    return ((this.sysMask >>> systemProcedure) & 1) === 1;
  }

  private inSizeFor(kind: number, inputType: number, fallback: number): number {
    if (kind === KIND.SYSPROC) {
      return this.sysInSizes.get(inputType) ?? fallback;
    }
    return this.inSizes.get(kind + ":" + inputType) ?? fallback;
  }

  private outSizeFor(kind: number, inputType: number): number {
    if (kind === KIND.SYSPROC) {
      return this.sysOutSizes.get(inputType) ?? 0;
    }
    return this.outSizes.get(kind + ":" + inputType) ?? 0;
  }

  zeroState() {
    this.u8().fill(0, this.stateAddr, this.stateAddr + this.stateSize);
  }

  writeState(bytes: Uint8Array): void {
    const length = Math.min(bytes.length, this.stateSize);
    if (length > 0) {
      this.u8().set(bytes.subarray(0, length), this.stateAddr);
    }
  }

  private writeCtx(context: CallCtx) {
    const view = QpiContext.wrap(this.u8(), this.ctxAddr);
    view.bytes.fill(0);
    view.currentContractIndex = this.slot;
    view.stackIndex = -1;
    view.currentContractId = BigInt(this.slot);

    if (context.originator && context.originator.length >= 32) {
      view.originator = context.originator;
    }
    if (context.invocator && context.invocator.length >= 32) {
      view.invocator = context.invocator;
    }

    view.invocationReward = context.invocationReward ?? 0n;
    view.entryPoint = context.entryPoint ?? 0;
  }

  invoke(
    kind: number,
    inputType: number,
    input: Uint8Array = new Uint8Array(0),
    context: CallCtx = {},
  ): Uint8Array {
    const nested = this.dispatchDepth > 0;
    let inputOffset: number;
    let outputOffset: number;
    let localsOffset: number;
    let savedArenaStart = 0;
    let savedArenaTop = 0;
    let savedContext: Uint8Array | null = null;
    const memory = this.u8();

    if (nested) {
      // Avoid signed 32-bit alignment arithmetic for shared-memory arenas above 2 GiB.
      const base = this.arenaTop;
      inputOffset = base + 7 - ((base + 7) % 8);
      outputOffset = inputOffset + IN_SZ;
      localsOffset = outputOffset + OUT_SZ;
      const frameArenaStart = localsOffset + LOCALS_SZ;

      if (frameArenaStart > this.arenaEnd) {
        throw new Error("nested dispatch frame exceeds arena");
      }

      savedArenaStart = this.arenaStart;
      savedArenaTop = this.arenaTop;
      this.arenaStart = frameArenaStart;
      this.arenaTop = frameArenaStart;
      savedContext = memory.slice(this.ctxAddr, this.ctxAddr + 256);
    } else {
      inputOffset = this.ioBase;
      outputOffset = this.ioBase + IN_SZ;
      localsOffset = this.ioBase + IN_SZ + OUT_SZ;
      this.arenaStart = this.arenaBase;
      this.arenaTop = this.arenaBase;
    }

    const inputSize = this.inSizeFor(kind, inputType, input.length);
    const outputSize = this.outSizeFor(kind, inputType);
    memory.fill(0, inputOffset, inputOffset + inputSize);
    memory.fill(0, outputOffset, outputOffset + OUT_SZ);
    memory.fill(0, localsOffset, localsOffset + LOCALS_SZ);

    if (input.length > 0 && inputSize > 0) {
      memory.set(
        input.subarray(0, Math.min(input.length, inputSize)),
        inputOffset,
      );
    }
    this.writeCtx(context);

    const metering = this.metering;
    const savedCost = this.cost;
    this.cost = 0n;

    const recorder = this.trace?.enabled ? this.trace : null;
    const wantState = metering || recorder != null;
    const snapshotLimit = metering ? this.stateSize : TRACE_STATE_CAP;
    const stateBefore = wantState ? this.stateSnapshot(snapshotLimit) : EMPTY;
    const traceEntry = recorder
      ? recorder.begin({
          tick: this.host.tick(),
          index: this.slot,
          entry: inputType,
          kind,
          invocator: context.invocator,
          invocationReward: context.invocationReward ?? 0n,
          input,
          stateSize: this.stateSize,
          stateBefore,
        })
      : null;
    const startedAt = recorder ? performance.now() : 0;

    this.dispatchDepth++;
    try {
      this.ex.dispatch(
        kind >>> 0,
        inputType >>> 0,
        inputOffset >>> 0,
        outputOffset >>> 0,
        localsOffset >>> 0,
      );
    } catch (error) {
      const stateAfter = wantState ? this.stateSnapshot(snapshotLimit) : EMPTY;
      this.finishMeter(metering, savedCost, stateBefore, stateAfter);

      if (recorder) {
        recorder.end(traceEntry, {
          output: EMPTY,
          ok: false,
          trap: trapMessage(error),
          stateBefore,
          stateAfter,
          execNs: (performance.now() - startedAt) * 1e6,
        });
      }
      throw error;
    } finally {
      this.dispatchDepth--;

      if (nested) {
        const currentMemory = this.u8();
        if (savedContext) {
          currentMemory.set(savedContext, this.ctxAddr);
        }
        this.arenaStart = savedArenaStart;
        this.arenaTop = savedArenaTop;
      }
    }

    const stateAfter = wantState ? this.stateSnapshot(snapshotLimit) : EMPTY;
    const output = this.u8().slice(
      outputOffset,
      outputOffset + outputSize,
    );
    this.finishMeter(metering, savedCost, stateBefore, stateAfter);

    if (recorder) {
      recorder.end(traceEntry, {
        output,
        ok: true,
        stateBefore,
        stateAfter,
        execNs: (performance.now() - startedAt) * 1e6,
      });
    }

    return output;
  }

  migrate(oldState: Uint8Array): void {
    const localsOffset = this.ioBase + IN_SZ + OUT_SZ;
    const oldStateOffset = this.arenaBase;
    const memory = this.u8();

    memory.fill(0, this.stateAddr, this.stateAddr + this.stateSize);
    memory.fill(0, localsOffset, localsOffset + LOCALS_SZ);
    memory.set(oldState, oldStateOffset);
    this.writeCtx({});
    this.arenaStart = this.arenaBase + ((oldState.length + 15) & ~15);
    this.arenaTop = this.arenaStart;
    this.ex.dispatch(
      KIND.MIGRATE >>> 0,
      0,
      oldStateOffset >>> 0,
      0,
      localsOffset >>> 0,
    );
    this.host.markDirty(this.slot);
  }

  private finishMeter(
    metering: boolean,
    savedCost: bigint,
    before: Uint8Array,
    after: Uint8Array,
  ): void {
    if (metering) {
      let cost = BASE_CALL_COST + this.cost;
      if (!bytesEqual(before, after)) {
        cost += DIGEST_BYTE_COST * BigInt(this.stateSize);
      }
      this.lastCost = cost;
    } else {
      this.lastCost = 0n;
    }

    this.cost = savedCost;
  }

  state(): Uint8Array {
    return this.stateSnapshot(this.stateSize);
  }

  private stateSnapshot(limit: number): Uint8Array {
    const length = Math.min(limit >>> 0, this.stateSize);
    return this.u8().slice(this.stateAddr, this.stateAddr + length);
  }

  // The view is invalid after a dispatch grows memory.
  stateView(length: number = this.stateSize): Uint8Array {
    const clampedLength = Math.min(length >>> 0, this.stateSize);
    return this.u8().subarray(
      this.stateAddr,
      this.stateAddr + clampedLength,
    );
  }

  digest(): string {
    return toHex(k12Bytes(this.state()));
  }

  private recHost(name: string, detail: () => string): void {
    const recorder = this.trace;
    if (recorder?.enabled) {
      recorder.hostCall(name, detail());
    }
  }

  private meterLhost(lhost: Record<string, Function>): void {
    for (const name of Object.keys(lhost)) {
      const weight = HOST_WEIGHT[name];
      if (weight === undefined) {
        continue;
      }

      const hostFunction = lhost[name] as (...args: unknown[]) => unknown;
      lhost[name] = (...args: unknown[]) => {
        if (this.metering) {
          this.cost += weight;
        }
        return hostFunction(...args);
      };
    }
  }

  private imports(wasmModule?: WebAssembly.Module): WebAssembly.Imports {
    const u8 = () => this.u8();
    const contextView = () => QpiContext.wrap(u8(), this.ctxAddr);
    const lhost: Record<string, Function> = {
      beginFn: (_id: number) => {},
      endFn: (_id: number) => {},
      markDirty: (_ci: number) => this.host.markDirty(this.slot),
      pauseLog: () => this.host.pauseLog(),
      resumeLog: () => this.host.resumeLog(),
      acquireScratch: (size: bigint, initZero: number) => {
        if (size < 0n || size > 0xfffffff8n) {
          throw new Error("lhost: scratch arena exhausted");
        }

        const alignedSize = Number((size + 7n) & ~7n);
        if (
          this.arenaTop > this.arenaEnd ||
          alignedSize > this.arenaEnd - this.arenaTop
        ) {
          throw new Error("lhost: scratch arena exhausted");
        }

        const offset = this.arenaTop;
        this.arenaTop += alignedSize;
        if (initZero) {
          u8().fill(0, offset, offset + alignedSize);
        }
        return offset >>> 0;
      },
      releaseScratch: (offset: number) => {
        const pointer = offset >>> 0;
        if (pointer >= this.arenaStart && pointer <= this.arenaTop) {
          this.arenaTop = pointer;
        }
      },
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
      // Date accessors use Qubic's two-digit year; now() packs the full year.
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
      prevSpectrumDigest: (out: number) =>
        u8().set(this.host.prevSpectrumDigest().subarray(0, 32), out),
      prevUniverseDigest: (out: number) =>
        u8().set(this.host.prevUniverseDigest().subarray(0, 32), out),
      prevComputerDigest: (out: number) =>
        u8().set(this.host.prevComputerDigest().subarray(0, 32), out),
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
      computor: (i: number, out: number) =>
        u8().set(this.host.computor(i >>> 0).subarray(0, 32), out),
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
        this.recHost(
          "transfer",
          () => `→ ${shortId(dest)} ${amount} (type ${type & 0xff})${r < 0n ? " ✗" : ""}`,
        );
        return r;
      },
      burn: (amount: bigint, burnedFor: number) => {
        const r = this.host.burn(this.slot, amount, burnedFor >>> 0);
        this.recHost("burn", () => `${amount}${r < 0n ? " ✗" : ""}`);
        return r;
      },
      // assets / shares
      isAssetIssued: (issOff: number, name: bigint) =>
        this.host.isAssetIssued(u8().slice(issOff, issOff + 32), name),
      issueAsset: (name: bigint, issOff: number, dec: number, shares: bigint, unit: bigint) => {
        const r = this.host.issueAsset(
          this.slot,
          name,
          u8().slice(issOff, issOff + 32),
          (dec << 24) >> 24,
          shares,
          unit,
          contextView().invocator,
        );
        this.recHost("issueAsset", () => `${assetName(name)} shares=${shares}`);
        return r;
      },
      numberOfShares: (aOff: number, oOff: number, pOff: number) =>
        this.host.numberOfShares(
          u8().slice(aOff, aOff + 40),
          u8().slice(oOff, oOff + 40),
          u8().slice(pOff, pOff + 40),
        ),
      numberOfPossessedShares: (
        name: bigint,
        issOff: number,
        ownOff: number,
        posOff: number,
        ownMgmt: number,
        posMgmt: number,
      ) =>
        this.host.numberOfPossessedShares(
          name,
          u8().slice(issOff, issOff + 32),
          u8().slice(ownOff, ownOff + 32),
          u8().slice(posOff, posOff + 32),
          ownMgmt & 0xffff,
          posMgmt & 0xffff,
        ),
      // Write selected ownership or possession records to the contract's output buffer.
      assetEnumerate: (
        kind: number,
        issOff: number,
        ownOff: number,
        posOff: number,
        outOff: number,
        maxN: number,
      ) => {
        const entries = this.host.assetEnumerate(
          u8().slice(issOff, issOff + 40),
          u8().slice(ownOff, ownOff + 36),
          u8().slice(posOff, posOff + 36),
          kind >>> 0,
        );
        const n = Math.min(entries.length, maxN >>> 0);
        const mem = u8();
        const dv = new DataView(this.mem.buffer);
        const record = ASSET_ENUMERATION_RECORD;
        let p = outOff >>> 0;
        for (let i = 0; i < n; i++) {
          const e = entries[i];
          mem.set(e.owner.subarray(0, record.fields.owner.size), p + record.fields.owner.offset);
          mem.set(
            e.possessor.subarray(0, record.fields.possessor.size),
            p + record.fields.possessor.offset,
          );
          dv.setBigInt64(p + record.fields.shares.offset, e.shares, true);
          dv.setUint16(
            p + record.fields.ownershipManagingContract.offset,
            e.ownMgmt & 0xffff,
            true,
          );
          dv.setUint16(
            p + record.fields.possessionManagingContract.offset,
            e.posMgmt & 0xffff,
            true,
          );
          p += record.size;
        }
        return n;
      },
      transferShareOwnershipAndPossession: (
        name: bigint,
        issOff: number,
        ownOff: number,
        posOff: number,
        shares: bigint,
        newOwnerOff: number,
      ) => {
        const newOwner = u8().slice(newOwnerOff, newOwnerOff + 32);
        const r = this.host.transferShares(
          this.slot,
          name,
          u8().slice(issOff, issOff + 32),
          u8().slice(ownOff, ownOff + 32),
          u8().slice(posOff, posOff + 32),
          shares,
          newOwner,
        );
        this.recHost("transferShares", () => `${assetName(name)} ${shares} → ${shortId(newOwner)}`);
        if ((globalThis as any).process?.env?.QINIT_GTEST_DUMP_ASSETS) {
          (globalThis as any).process.stderr.write(
            `[lh transferShares] slot=${this.slot} name=${name} owner=${Array.from(u8().slice(ownOff, ownOff + 8)).join(",")} newOwner=${Array.from(newOwner.slice(0, 8)).join(",")} shares=${shares} -> ${r}\n`,
          );
        }
        return r;
      },
      // share management rights — qpi acquireShares / releaseShares (qpi_asset_impl.h). The lhost imports are
      // provided here; a wasm contract reaches them once the qpi wasm binding declares the imports.
      acquireShares: (
        name: bigint,
        issOff: number,
        ownOff: number,
        posOff: number,
        shares: bigint,
        srcOwnMgmt: number,
        srcPosMgmt: number,
        fee: bigint,
      ) => {
        const r = this.host.acquireShares(
          this.slot,
          name,
          u8().slice(issOff, issOff + 32),
          u8().slice(ownOff, ownOff + 32),
          u8().slice(posOff, posOff + 32),
          shares,
          srcOwnMgmt & 0xffff,
          srcPosMgmt & 0xffff,
          fee,
        );
        this.recHost(
          "acquireShares",
          () => `${assetName(name)} ${shares} ← mgmt ${srcPosMgmt & 0xffff}`,
        );
        return r;
      },
      releaseShares: (
        name: bigint,
        issOff: number,
        ownOff: number,
        posOff: number,
        shares: bigint,
        dstOwnMgmt: number,
        dstPosMgmt: number,
        fee: bigint,
      ) => {
        const r = this.host.releaseShares(
          this.slot,
          name,
          u8().slice(issOff, issOff + 32),
          u8().slice(ownOff, ownOff + 32),
          u8().slice(posOff, posOff + 32),
          shares,
          dstOwnMgmt & 0xffff,
          dstPosMgmt & 0xffff,
          fee,
        );
        this.recHost(
          "releaseShares",
          () => `${assetName(name)} ${shares} → mgmt ${dstPosMgmt & 0xffff}`,
        );
        return r;
      },
      // date / signature / IPO / mining / oracle-status — see HostServices (the dev engine stubs IPO/mining/oracle)
      dayOfWeek: (year: number, month: number, day: number) =>
        this.host.dayOfWeek(year & 0xff, month & 0xff, day & 0xff),
      signatureValidity: (entOff: number, digOff: number, sigOff: number) =>
        this.host.signatureValidity(
          u8().slice(entOff, entOff + 32),
          u8().slice(digOff, digOff + 32),
          u8().slice(sigOff, sigOff + 64),
        ),
      bidInIPO: (idx: number, price: bigint, qty: number) =>
        this.host.bidInIPO(this.slot, idx >>> 0, price, qty >>> 0),
      ipoBidId: (idx: number, bid: number, outOff: number) => {
        u8().set(this.host.ipoBidId(idx >>> 0, bid >>> 0).subarray(0, 32), outOff);
      },
      ipoBidPrice: (idx: number, bid: number) => this.host.ipoBidPrice(idx >>> 0, bid >>> 0),
      computeMiningFunction: (sOff: number, pkOff: number, nOff: number, outOff: number) => {
        u8().set(
          this.host
            .computeMiningFunction(
              u8().slice(sOff, sOff + 32),
              u8().slice(pkOff, pkOff + 32),
              u8().slice(nOff, nOff + 32),
            )
            .subarray(0, 32),
          outOff,
        );
      },
      initMiningSeed: (sOff: number) => this.host.initMiningSeed(u8().slice(sOff, sOff + 32)),
      getOracleQueryStatus: (queryId: bigint) => this.host.getOracleQueryStatus(queryId),
      unsubscribeOracle: (sub: number) => this.host.unsubscribeOracle(this.slot, sub | 0),
      // oracle query/subscribe/read — the query/reply are opaque sized buffers (the contract owns the typing)
      queryOracle: (
        ifaceIdx: number,
        queryOff: number,
        querySize: number,
        replySize: number,
        procId: number,
        timeout: number,
        fee: bigint,
      ) =>
        this.host.queryOracle(
          this.slot,
          ifaceIdx >>> 0,
          u8().slice(queryOff, queryOff + querySize),
          replySize >>> 0,
          procId >>> 0,
          timeout >>> 0,
          fee,
        ),
      subscribeOracle: (
        ifaceIdx: number,
        queryOff: number,
        querySize: number,
        replySize: number,
        timestampOffset: number,
        procId: number,
        period: number,
        notifyPrev: number,
        fee: bigint,
      ) =>
        this.host.subscribeOracle(
          this.slot,
          ifaceIdx >>> 0,
          u8().slice(queryOff, queryOff + querySize),
          replySize >>> 0,
          timestampOffset >>> 0,
          procId >>> 0,
          period >>> 0,
          notifyPrev !== 0,
          fee,
        ),
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
      // Nested calls keep the original originator.
      liteCallFunction: (
        calleeIdx: number,
        inputType: number,
        inOff: number,
        inSize: number,
        outOff: number,
        outSize: number,
      ) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = contextView().originator;
        const result = this.host.callFunction(
          this.slot,
          calleeIdx >>> 0,
          inputType & 0xffff,
          input,
          originator,
        );
        this.recHost(
          "callFunction",
          () =>
            `→ @${calleeIdx >>> 0} fn #${inputType & 0xffff}${result.error ? ` ✗ err ${result.error}` : ""}`,
        );
        if (result.error === 0 && result.output.length > 0) {
          u8().set(
            result.output.subarray(
              0,
              Math.min(outSize, result.output.length),
            ),
            outOff,
          );
        }
        return result.error;
      },
      liteInvokeProcedure: (
        calleeIdx: number,
        inputType: number,
        inOff: number,
        inSize: number,
        outOff: number,
        outSize: number,
        reward: bigint,
      ) => {
        const input = u8().slice(inOff, inOff + inSize);
        const originator = contextView().originator;
        const result = this.host.invokeProcedure(
          this.slot,
          calleeIdx >>> 0,
          inputType & 0xffff,
          input,
          reward,
          originator,
        );
        this.recHost(
          "invokeProcedure",
          () =>
            `→ @${calleeIdx >>> 0} proc #${inputType & 0xffff} reward=${reward}${result.error ? ` ✗ err ${result.error}` : ""}`,
        );
        if (result.error === 0 && result.output.length > 0) {
          u8().set(
            result.output.subarray(
              0,
              Math.min(outSize, result.output.length),
            ),
            outOff,
          );
        }
        return result.error;
      },
      liteSetShareholderProposal: (calleeIdx: number, propOff: number, reward: bigint) => {
        const proposal = u8().slice(propOff, propOff + 1024);
        const originator = contextView().originator;
        return this.host.setShareholderProposal(
          this.slot,
          calleeIdx >>> 0,
          proposal,
          reward,
          originator,
        );
      },
      liteSetShareholderVotes: (
        calleeIdx: number,
        voteOff: number,
        voteSize: number,
        reward: bigint,
      ) => {
        const vote = u8().slice(voteOff, voteOff + voteSize);
        const originator = contextView().originator;
        return this.host.setShareholderVotes(
          this.slot,
          calleeIdx >>> 0,
          vote,
          reward,
          originator,
        );
      },
    };
    const missingLhost = Object.keys(LHOST_ABI).filter((name) => !(name in lhost));
    const extraLhost = Object.keys(lhost).filter((name) => !(name in LHOST_ABI));
    if (missingLhost.length || extraLhost.length) {
      throw new Error(
        `virtual-engine lhost table drift (missing: ${missingLhost.join(", ") || "none"}; extra: ${extraLhost.join(", ") || "none"})`,
      );
    }
    this.meterLhost(lhost);
    // Wasm i32 parameters arrive signed in JS; coerce offsets to unsigned above 2 GiB.
    const toU32Args =
      (hostFunction: Function) =>
      (...args: unknown[]) =>
        hostFunction(
          ...args.map((argument) =>
            typeof argument === "number" ? argument >>> 0 : argument,
          ),
        );

    for (const name of Object.keys(lhost)) {
      lhost[name] = toU32Args(lhost[name]);
    }

    // Use explicit WASI and env stubs to avoid Bun's Proxy handling bug for i64 imports.
    const wasiImports: Record<string, Function> = {
      proc_exit: (code: number) => {
        throw new Error("wasm proc_exit(" + code + ")");
      },
    };
    const envImports: Record<string, unknown> = {};

    if (wasmModule) {
      for (const imported of WebAssembly.Module.imports(wasmModule)) {
        if (imported.kind !== "function") {
          continue;
        }

        const results = ((imported as any).type?.results ?? []) as string[];
        const noopFunction = results.includes("i64")
          ? (..._args: unknown[]) => 0n
          : (..._args: unknown[]) => 0;

        if (
          imported.module === "wasi_snapshot_preview1" &&
          !(imported.name in wasiImports)
        ) {
          wasiImports[imported.name] = noopFunction;
        } else if (
          imported.module === "env" &&
          !(imported.name in envImports)
        ) {
          envImports[imported.name] = envImportStub(imported.name);
        }
      }
    }

    if (this.extMem) {
      envImports.memory = this.extMem;
    }

    return {
      lhost,
      env: envImports,
      wasi_snapshot_preview1: wasiImports,
      ...(this.extraImports ?? {}),
    } as unknown as WebAssembly.Imports;
  }
}

function shortId(id: Uint8Array): string {
  const hasHighBytes = id.subarray(8, 32).some((byte) => byte !== 0);
  if (!hasHighBytes) {
    const contractIndex = new DataView(
      id.buffer,
      id.byteOffset,
      id.byteLength,
    ).getBigUint64(0, true);
    return "@" + contractIndex;
  }

  return idPrefix(id, 8) + "…" + idSuffix(id);
}

// Encode the first identity-body chunk without computing the checksum.
function idPrefix(id: Uint8Array, length: number): string {
  let value = new DataView(
    id.buffer,
    id.byteOffset,
    id.byteLength,
  ).getBigUint64(0, true);
  let prefix = "";

  for (let index = 0; index < length; index++) {
    prefix += String.fromCharCode(65 + Number(value % 26n));
    value /= 26n;
  }

  return prefix;
}

function idSuffix(id: Uint8Array): string {
  let fragment = new DataView(
    id.buffer,
    id.byteOffset,
    id.byteLength,
  ).getBigUint64(24, true);
  let suffix = "";

  for (let index = 0; index < 10; index++) {
    fragment /= 26n;
  }

  for (let index = 0; index < 4; index++) {
    suffix += String.fromCharCode(65 + Number(fragment % 26n));
    fragment /= 26n;
  }

  const digest = k12Bytes(id);
  let checksum = (digest[0] | (digest[1] << 8) | (digest[2] << 16)) & 0x3ffff;

  for (let index = 0; index < 4; index++) {
    suffix += String.fromCharCode(65 + (checksum % 26));
    checksum = Math.floor(checksum / 26);
  }

  return suffix;
}

// Asset names are seven little-endian ASCII bytes.
function assetName(name: bigint): string {
  let text = "";
  let packedName = name;

  for (let index = 0; index < 7 && packedName > 0n; index++) {
    const byte = Number(packedName & 0xffn);
    if (byte >= 0x20 && byte < 0x7f) {
      text += String.fromCharCode(byte);
    }
    packedName >>= 8n;
  }

  return text || name.toString();
}
