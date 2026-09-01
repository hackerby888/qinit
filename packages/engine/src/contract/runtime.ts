import { ASSET_ENUMERATION_RECORD, CHEAT_ERR, CHEAT_OP, LHOST_ABI, type DebugStateRegion, type LhostImportName } from "@qinit/core";
import { k12Bytes, toHex } from "../support/k12";
import { bytesEqual, rangesEqual, type Id } from "../support/bytes";
import { noteHostWrite, readJournalHeader, resetJournal, type JournalHeader } from "@qinit/core/wasm/journal";
// Layout shared with core-lite's module_storage.h; sizing.ts is the one definition both backends use.
import { INPUT_BUFFER_BYTES, LOCALS_BUFFER_BYTES, OUTPUT_BUFFER_BYTES } from "@qinit/core/wasm/sizing";
import { diffRegions, journalRegions, type TraceRecorder } from "../logging/trace";
import { QpiContext } from "./abi";
import { EntityRecord, M256i } from "../protocol/wire";
import { validateContractIndexSignature } from "./wasm-contract-index";

const EMPTY = new Uint8Array(0);

// The leading word of a log payload, in the little-endian form core's host writes there.
function contractIndexWord(slot: number): Uint8Array {
    const word = new Uint8Array(4);
    new DataView(word.buffer).setUint32(0, slot >>> 0, true);
    return word;
}

// Core leaves the word cleared after a log, so a contract never reads the stamp back.
const CLEARED_LOG_HEADER_WORD = new Uint8Array(4);

function stateDiffMode(): string | undefined {
    return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.QINIT_STATE_DIFF;
}

/** `QINIT_STATE_DIFF=snapshot` ignores a baked journal and diffs by copying, as the engine used to. */
function snapshotDiffForced(): boolean {
    return stateDiffMode() === "snapshot";
}

/**
 * `QINIT_STATE_DIFF=verify` runs both mechanisms on every dispatch and throws when they disagree. It
 * turns any suite into a journal validator: a write path the rewriter missed shows up as a mismatch on
 * the contract and call that made it, rather than as a diff nobody notices is short.
 */
function journalVerifyEnabled(): boolean {
    return stateDiffMode() === "verify";
}

/** Where two region lists first differ, short enough to read in a test failure. */
function firstRegionMismatch(journal: readonly DebugStateRegion[], snapshot: readonly DebugStateRegion[]): string | undefined {
    for (let index = 0; index < Math.max(journal.length, snapshot.length); index++) {
        const left = journal[index];
        const right = snapshot[index];
        if (!left) {
            return `journal missed the write at +${right!.off}`;
        }
        if (!right) {
            return `journal reported a write at +${left.off} the snapshot did not see`;
        }
        if (left.off !== right.off) {
            return `region ${index} is at +${left.off} but the snapshot has +${right.off}`;
        }
        if (left.before !== right.before || left.after !== right.after) {
            return `region ${index} at +${left.off} holds different bytes`;
        }
    }
    return undefined;
}

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

export const CONTRACT_ENTRY_KIND = {
    FUNCTION: 0,
    PROCEDURE: 1,
    SYSPROC: 2,
    MIGRATE: 3,
} as const;

// Block size for catching the shadow up to a changed state: one memcmp per block, copy only what moved.
const SHADOW_BLOCK = 64 * 1024;

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
    getOcInvocationStatus: 1n,
    invokeOc: 20n,
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
    initialTick(): number;
    epoch(): number;
    nowMs(): number;
    numberOfTickTransactions(): number;
    markDirty(slot: number): void;
    log(slot: number, level: number, msg: Uint8Array): void;
    // Development channel, deliberately separate from log(): it consumes no log id and never reaches qLogger.
    cheatPrint(slot: number, id: number, part: number, value: bigint, bytes: Uint8Array): void;
    cheatDeal(id: Id, amount: bigint): bigint;
    cheatWarp(ticks: number, epochs: number): bigint;
    pauseLog(): void;
    resumeLog(): void;
    transfer(slot: number, dest: Id, amount: bigint, transferType: number): bigint;
    burn(slot: number, amount: bigint, burnedFor: number): bigint;
    getEntity(id: Id): Entity | null;
    isContractId(id: Id): number;
    arbitrator(): Uint8Array;
    computor(index: number): Uint8Array;
    getPrevSpectrumDigest(): Uint8Array;
    getPrevUniverseDigest(): Uint8Array;
    getPrevComputerDigest(): Uint8Array;
    queryFeeReserve(callerSlot: number, contractIndex: number): bigint;
    issueAsset(slot: number, name: bigint, issuer: Id, decimals: number, shares: bigint, unit: bigint, invocator: Id): bigint;
    isAssetIssued(issuer: Id, name: bigint): number;
    numberOfShares(asset: Uint8Array, ownSel: Uint8Array, posSel: Uint8Array): bigint;
    numberOfPossessedShares(name: bigint, issuer: Id, owner: Id, possessor: Id, ownMgmt: number, posMgmt: number): bigint;
    assetEnumerate(
        asset: Uint8Array,
        ownSel: Uint8Array,
        posSel: Uint8Array,
        kind: number,
    ): {
        owner: Id;
        possessor: Id;
        shares: bigint;
        ownMgmt: number;
        posMgmt: number;
    }[];
    transferShareOwnershipAndPossession(slot: number, name: bigint, issuer: Id, owner: Id, possessor: Id, shares: bigint, newOwner: Id): bigint;
    acquireShares(
        slot: number,
        name: bigint,
        issuer: Id,
        owner: Id,
        possessor: Id,
        shares: bigint,
        srcOwnMgmt: number,
        srcPosMgmt: number,
        offeredFee: bigint,
    ): bigint;
    releaseShares(
        slot: number,
        name: bigint,
        issuer: Id,
        owner: Id,
        possessor: Id,
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
    computeMiningFunction(miningSeed: Uint8Array, publicKey: Id, nonce: Uint8Array): Uint8Array;
    initMiningSeed(miningSeed: Uint8Array): void;
    getOracleQueryStatus(queryId: bigint): number;
    getOcInvocationStatus(invocationId: bigint): number;
    invokeOc(slot: number, interfaceIndex: number, request: Uint8Array): bigint;
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
    callFunction(callerSlot: number, calleeIdx: number, inputType: number, input: Uint8Array, originator: Id): { error: number; output: Uint8Array };
    invokeProcedure(
        callerSlot: number,
        calleeIdx: number,
        inputType: number,
        input: Uint8Array,
        reward: bigint,
        originator: Id,
    ): { error: number; output: Uint8Array };
    nextId(id: Id): Uint8Array;
    prevId(id: Id): Uint8Array;
    setShareholderProposal(callerSlot: number, calleeIdx: number, proposal: Uint8Array, reward: bigint, originator: Id): number;
    setShareholderVotes(callerSlot: number, calleeIdx: number, vote: Uint8Array, reward: bigint, originator: Id): number;
}

export interface ContractCallContext {
    invocator?: Id;
    originator?: Id;
    invocationReward?: bigint;
    entryPoint?: number;
}

// Host imports that mutate chain state, so a contract *function* must not reach them. Typed against the
// generated ABI: a renamed or dropped import fails to compile rather than silently losing its guard.
export const MUTATING_LHOST_IMPORTS: readonly LhostImportName[] = [
    "markDirty",
    "pauseLog",
    "resumeLog",
    "logBytes",
    "transfer",
    "transferTyped",
    "burn",
    "issueAsset",
    "transferShareOwnershipAndPossession",
    "acquireShares",
    "releaseShares",
    "bidInIPO",
    "invokeOc",
    "unsubscribeOracle",
    "queryOracle",
    "subscribeOracle",
    "distributeDividends",
    "liteInvokeProcedure",
    "liteSetShareholderProposal",
    "liteSetShareholderVotes",
];

export class ContractAbort extends Error {
    constructor(public code: number) {
        super("contract abort " + code);
    }
}

export class ContractExecutionError extends Error {
    readonly cause: unknown;

    constructor(
        public readonly slot: number,
        public readonly kind: number,
        public readonly entry: number,
        cause: unknown,
    ) {
        super(trapMessage(cause));
        this.name = "ContractExecutionError";
        this.cause = cause;
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
    // The previous state, kept across invocations so the before-image costs no copy. Contract states run to
    // hundreds of megabytes, and both metering and trace diffs need one every call.
    private shadow: Uint8Array | null = null;
    private shadowStale = true;
    // The contract's own write journal, when the artifact carries one. It reports what changed without a
    // copy of the state, so the shadow above is never allocated for a contract that has it.
    private journalBase = 0;
    private journal: JournalHeader | null = null;
    // Set once the journal overflows: from the next call this contract falls back to the shadow, which is
    // slower but cannot run out of room. The overflowing call itself can only report truncation.
    private journalOverflowed = false;
    private dispatchDepth = 0;
    private executionKinds: number[] = [];
    // What CC_PRANK displaced, so CC_UNPRANK restores the real caller rather than guessing.
    private prankSaved: { originator: Id; invocator: Id; invocationReward: bigint } | null = null;
    cost = 0n;
    lastCost = 0n;
    private inSizes = new Map<string, number>();
    private outSizes = new Map<string, number>();
    private sysInSizes = new Map<number, number>();
    private sysOutSizes = new Map<number, number>();
    entries: {
        inputType: number;
        kind: number;
        inputSizeBytes: number;
        outputSizeBytes: number;
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
                    const minimumPages = (((imported as any).type?.minimum ?? 0) as number) >>> 0;
                    const currentPages = Math.ceil(externalMemory.buffer.byteLength / 65536);

                    if (currentPages < minimumPages) {
                        externalMemory.grow(minimumPages - currentPages);
                    }
                }
            }
        }

        this.inst = new WebAssembly.Instance(wasmModule, this.imports(wasmModule));
        this.ex = this.inst.exports;

        let compiledSlot: number;

        try {
            compiledSlot = this.ex.contract_index() >>> 0;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`contract_index() failed for target ${slot}: ${detail}`);
        }

        if (compiledSlot !== slot) {
            throw new Error(`artifact slot mismatch: compiled ${compiledSlot}, target ${slot}`);
        }

        this.mem = (this.ex.memory as WebAssembly.Memory) ?? externalMemory;
        this.ioBase = this.ex.io_base() >>> 0;
        this.stateAddr = this.ex.state_addr() >>> 0;
        this.stateSize = this.ex.state_size() >>> 0;
        this.ctxAddr = this.ex.ctx_addr() >>> 0;
        this.arenaBase = this.ioBase + INPUT_BUFFER_BYTES + OUTPUT_BUFFER_BYTES + LOCALS_BUFFER_BYTES;
        this.arenaStart = this.arenaBase;
        this.arenaTop = this.arenaBase;
        this.arenaEnd = this.ioBase + (this.ex.io_size() >>> 0);

        if (externalMemory && this.stateSize > 0) {
            new Uint8Array(this.mem.buffer).fill(0, this.stateAddr, this.stateAddr + this.stateSize);
        }
        if (typeof this.ex._initialize === "function") {
            this.ex._initialize();
        }

        this.attachJournal();
        this.readRegistry();
    }

    static load(bytes: Uint8Array, slot: number, host: HostServices, externalMemory?: WebAssembly.Memory, extraImports?: WebAssembly.Imports): Contract {
        validateContractIndexSignature(bytes);
        const wasmModule = new WebAssembly.Module(bytes as BufferSource);
        const hasLegacyArena = WebAssembly.Module.exports(wasmModule).some((entry) => entry.name === "arena_top");

        if (hasLegacyArena) {
            throw new Error("legacy arena_top export is not supported");
        }

        return new Contract(slot, host, wasmModule, externalMemory, extraImports);
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
            const inputSizeBytes = view.getUint32(infoOffset + 8, true);
            const outputSizeBytes = view.getUint32(infoOffset + 12, true);

            this.entries.push({
                inputType,
                kind,
                inputSizeBytes,
                outputSizeBytes,
            });
            this.inSizes.set(kind + ":" + inputType, inputSizeBytes);
            this.outSizes.set(kind + ":" + inputType, outputSizeBytes);
        }

        for (let systemProcedure = 0; systemProcedure < 12; systemProcedure++) {
            if ((this.sysMask >>> systemProcedure) & 1) {
                this.sysInSizes.set(systemProcedure, this.ex.sysproc_in_size(systemProcedure >>> 0) >>> 0);
                this.sysOutSizes.set(systemProcedure, this.ex.sysproc_out_size(systemProcedure >>> 0) >>> 0);
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
        if (kind === CONTRACT_ENTRY_KIND.SYSPROC) {
            return this.sysInSizes.get(inputType) ?? fallback;
        }
        return this.inSizes.get(kind + ":" + inputType) ?? fallback;
    }

    private outSizeFor(kind: number, inputType: number): number {
        if (kind === CONTRACT_ENTRY_KIND.SYSPROC) {
            return this.sysOutSizes.get(inputType) ?? 0;
        }
        return this.outSizes.get(kind + ":" + inputType) ?? 0;
    }

    zeroState() {
        this.u8().fill(0, this.stateAddr, this.stateAddr + this.stateSize);
        this.shadowStale = true;
    }

    writeState(bytes: Uint8Array): void {
        const length = Math.min(bytes.length, this.stateSize);
        if (length > 0) {
            this.u8().set(bytes.subarray(0, length), this.stateAddr);
        }
        this.shadowStale = true;
    }

    /**
     * Finds the write journal an instrumented artifact carries. The module reports the region as
     * unavailable through `io_size()`, so it sits exactly at the arena end and no host hands it out.
     * The reset export initialises it; a module without one simply has no journal.
     */
    private attachJournal(): void {
        if (typeof this.ex.__q_journal_reset !== "function" || snapshotDiffForced()) {
            return;
        }

        this.ex.__q_journal_reset();
        const header = readJournalHeader(this.u8(), this.arenaEnd);
        if (!header || header.stateSize !== this.stateSize) {
            return;
        }

        this.journalBase = this.arenaEnd;
        this.journal = header;
    }

    /**
     * What the journal recorded during the dispatch that just ran. Counters move during the call, so the
     * header is re-read rather than reused. An overflow arms the shadow fallback for the next call — the
     * before-image of the blocks it missed is already gone, so this call can only report truncation.
     */
    private journalOutcome(): { stateDiff: DebugStateRegion[]; stateChanged: boolean; stateTruncated: boolean } {
        const memory = this.u8();
        const header = readJournalHeader(memory, this.journalBase);
        if (!header) {
            return { stateDiff: [], stateChanged: false, stateTruncated: false };
        }

        const stateDiff = journalRegions(memory, this.journalBase, this.stateAddr, header);
        if (header.overflowed) {
            this.journalOverflowed = true;
        }

        return { stateDiff, stateChanged: stateDiff.length > 0 || header.overflowed, stateTruncated: header.overflowed };
    }

    /**
     * Compares what the journal reported against a real before/after diff of the same dispatch, and
     * throws on any disagreement. A truncated diff is skipped: overflow reports an incomplete diff by
     * design, and the fallback covers it from the next call.
     */
    private verifyJournal(before: Uint8Array, outcome: { stateDiff: DebugStateRegion[]; stateTruncated: boolean }, kind: number, inputType: number): void {
        if (outcome.stateTruncated) {
            return;
        }

        const expected = diffRegions(before, this.stateView(this.stateSize));
        const mismatch = firstRegionMismatch(outcome.stateDiff, expected);
        if (!mismatch) {
            return;
        }

        throw new Error(
            `state journal disagrees with the snapshot on slot ${this.slot} kind ${kind} entry ${inputType}: ` +
                `${mismatch} (journal ${outcome.stateDiff.length} regions, snapshot ${expected.length})`,
        );
    }

    /**
     * Records a host write into contract state. Store instrumentation only sees the contract's own
     * stores, and several lhost imports write through an out-pointer a contract may aim at its state.
     */
    private noteGuestWrite(destination: number, length: number): void {
        if (this.journal) {
            noteHostWrite(this.u8(), this.journalBase, this.journal, this.stateAddr, destination, length);
        }
    }

    private writeGuest(destination: number, bytes: Uint8Array): void {
        this.noteGuestWrite(destination, bytes.length);
        this.u8().set(bytes, destination);
    }

    // The before-image for this call. Refilled only after something outside a dispatch touched the state.
    private shadowBefore(): Uint8Array {
        if (!this.shadow || this.shadow.length !== this.stateSize) {
            this.shadow = new Uint8Array(this.stateSize);
            this.shadowStale = true;
        }
        if (this.shadowStale) {
            this.shadow.set(this.stateView());
            this.shadowStale = false;
        }
        return this.shadow;
    }

    // Catches the shadow up to the state a dispatch left behind, copying only the blocks that moved.
    private syncShadow(live: Uint8Array): void {
        const shadow = this.shadow;
        if (!shadow) {
            return;
        }

        for (let block = 0; block < live.length; block += SHADOW_BLOCK) {
            const end = Math.min(block + SHADOW_BLOCK, live.length);
            if (!rangesEqual(shadow, block, live, block, end - block)) {
                shadow.set(live.subarray(block, end), block);
            }
        }
    }

    private writeCtx(context: ContractCallContext) {
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

    invoke(kind: number, inputType: number, input: Uint8Array = new Uint8Array(0), context: ContractCallContext = {}): Uint8Array {
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
            outputOffset = inputOffset + INPUT_BUFFER_BYTES;
            localsOffset = outputOffset + OUTPUT_BUFFER_BYTES;
            const frameArenaStart = localsOffset + LOCALS_BUFFER_BYTES;

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
            outputOffset = this.ioBase + INPUT_BUFFER_BYTES;
            localsOffset = this.ioBase + INPUT_BUFFER_BYTES + OUTPUT_BUFFER_BYTES;
            this.arenaStart = this.arenaBase;
            this.arenaTop = this.arenaBase;
        }

        const inputSize = this.inSizeFor(kind, inputType, input.length);
        const outputSize = this.outSizeFor(kind, inputType);
        memory.fill(0, inputOffset, inputOffset + inputSize);
        memory.fill(0, outputOffset, outputOffset + OUTPUT_BUFFER_BYTES);
        memory.fill(0, localsOffset, localsOffset + LOCALS_BUFFER_BYTES);

        if (input.length > 0 && inputSize > 0) {
            memory.set(input.subarray(0, Math.min(input.length, inputSize)), inputOffset);
        }
        this.writeCtx(context);

        const metering = this.metering;
        const savedCost = this.cost;
        this.cost = 0n;

        const recorder = this.trace?.enabled ? this.trace : null;
        // Verify mode wants the state on every dispatch, so an untraced, unmetered call is checked too.
        const verifying = journalVerifyEnabled();
        const wantState = metering || recorder != null || verifying;
        const snapshotLimit = this.stateSize;
        // A nested frame keeps explicit copies: it would otherwise advance the shadow mid-call and destroy the
        // outer frame's before-image.
        // A nested frame re-enters this same contract, so it would clear the outer frame's journal too.
        const useJournal = wantState && !nested && this.journal !== null && !this.journalOverflowed;
        const useShadow = wantState && !nested && !useJournal;
        if (useJournal) {
            // Safe to clear per dispatch because a contract can only call lower slots, so this instance is
            // never re-entered mid-call. Deploy-time writeState/zeroState notes are cleared here too.
            resetJournal(this.u8(), this.journalBase, this.journal!);
        }
        const stateBefore = wantState && !useJournal ? (useShadow ? this.shadowBefore() : this.stateSnapshot(snapshotLimit)) : EMPTY;
        const verifyBefore = useJournal && verifying ? this.stateSnapshot(snapshotLimit) : EMPTY;
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
                  ...(useJournal ? { stateTruncated: false } : {}),
              })
            : null;
        const startedAt = recorder ? performance.now() : 0;

        this.dispatchDepth++;
        this.executionKinds.push(kind);
        try {
            this.ex.dispatch(kind >>> 0, inputType >>> 0, inputOffset >>> 0, outputOffset >>> 0, localsOffset >>> 0);
        } catch (error) {
            const trapOutcome = useJournal ? this.journalOutcome() : null;
            const stateAfter = wantState && !trapOutcome ? (useShadow ? this.stateView(snapshotLimit) : this.stateSnapshot(snapshotLimit)) : EMPTY;
            const trapStateChanged = trapOutcome ? trapOutcome.stateChanged : wantState && !bytesEqual(stateBefore, stateAfter);
            this.finishMeter(metering, savedCost, trapStateChanged);
            // This path throws before the resync below, and a caller may roll the state back, so refill next time.
            this.shadowStale = true;

            if (recorder) {
                recorder.end(traceEntry, {
                    output: EMPTY,
                    ok: false,
                    trap: trapMessage(error),
                    stateBefore,
                    stateAfter,
                    stateChanged: trapStateChanged,
                    ...(trapOutcome ? { stateDiff: trapOutcome.stateDiff, stateTruncated: trapOutcome.stateTruncated } : {}),
                    execNs: (performance.now() - startedAt) * 1e6,
                });
            }
            // Checked after the trace entry closes: a trap leaves partial writes behind, which is exactly
            // where a missed write path would hide.
            if (trapOutcome && verifying) {
                this.verifyJournal(verifyBefore, trapOutcome, kind, inputType);
            }
            throw error instanceof ContractExecutionError ? error : new ContractExecutionError(this.slot, kind, inputType, error);
        } finally {
            this.executionKinds.pop();
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

        const outcome = useJournal ? this.journalOutcome() : null;
        const stateAfter = wantState && !outcome ? (useShadow ? this.stateView(snapshotLimit) : this.stateSnapshot(snapshotLimit)) : EMPTY;
        const output = this.u8().slice(outputOffset, outputOffset + outputSize);
        const stateChanged = outcome ? outcome.stateChanged : wantState && !bytesEqual(stateBefore, stateAfter);
        this.finishMeter(metering, savedCost, stateChanged);

        if (recorder) {
            recorder.end(traceEntry, {
                output,
                ok: true,
                stateBefore,
                stateAfter,
                stateChanged,
                ...(outcome ? { stateDiff: outcome.stateDiff, stateTruncated: outcome.stateTruncated } : {}),
                execNs: (performance.now() - startedAt) * 1e6,
            });
        }
        if (outcome && verifying) {
            this.verifyJournal(verifyBefore, outcome, kind, inputType);
        }
        // After the recorder has read the before-image, not before.
        if (useShadow && stateChanged) {
            this.syncShadow(stateAfter);
        }
        // Journal mode leaves the shadow untouched, so anything it still holds is older than this call.
        // Marking it stale keeps the fallback correct if the journal later overflows and hands back over.
        if (useJournal && stateChanged) {
            this.shadowStale = true;
        }

        return output;
    }

    migrate(oldState: Uint8Array): void {
        const localsOffset = this.ioBase + INPUT_BUFFER_BYTES + OUTPUT_BUFFER_BYTES;
        const oldStateOffset = this.arenaBase;
        const memory = this.u8();

        memory.fill(0, this.stateAddr, this.stateAddr + this.stateSize);
        memory.fill(0, localsOffset, localsOffset + LOCALS_BUFFER_BYTES);
        memory.set(oldState, oldStateOffset);
        this.shadowStale = true;
        this.writeCtx({});
        this.arenaStart = this.arenaBase + ((oldState.length + 15) & ~15);
        this.arenaTop = this.arenaStart;
        const recorder = this.trace?.enabled ? this.trace : null;
        const stateBefore = recorder ? this.stateSnapshot(this.stateSize) : EMPTY;
        const traceEntry = recorder
            ? recorder.begin({
                  tick: this.host.tick(),
                  index: this.slot,
                  entry: 0,
                  kind: CONTRACT_ENTRY_KIND.MIGRATE,
                  invocator: undefined,
                  invocationReward: 0n,
                  input: oldState,
                  stateSize: this.stateSize,
                  stateBefore,
              })
            : null;
        const startedAt = recorder ? performance.now() : 0;

        this.executionKinds.push(CONTRACT_ENTRY_KIND.MIGRATE);
        try {
            this.ex.dispatch(CONTRACT_ENTRY_KIND.MIGRATE >>> 0, 0, oldStateOffset >>> 0, 0, localsOffset >>> 0);
        } catch (error) {
            const stateAfter = recorder ? this.stateSnapshot(this.stateSize) : EMPTY;
            recorder?.end(traceEntry, {
                output: EMPTY,
                ok: false,
                trap: trapMessage(error),
                stateBefore,
                stateAfter,
                execNs: (performance.now() - startedAt) * 1e6,
            });

            throw error instanceof ContractExecutionError ? error : new ContractExecutionError(this.slot, CONTRACT_ENTRY_KIND.MIGRATE, 0, error);
        } finally {
            this.executionKinds.pop();
        }

        if (recorder) {
            recorder.end(traceEntry, {
                output: EMPTY,
                ok: true,
                stateBefore,
                stateAfter: this.stateSnapshot(this.stateSize),
                execNs: (performance.now() - startedAt) * 1e6,
            });
        }
        this.host.markDirty(this.slot);
    }

    private finishMeter(metering: boolean, savedCost: bigint, stateChanged: boolean): void {
        if (metering) {
            let cost = BASE_CALL_COST + this.cost;
            if (stateChanged) {
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
        return this.u8().subarray(this.stateAddr, this.stateAddr + clampedLength);
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

    // lhost: frame markers, dirty tracking, logging control, and the scratch arena.
    private coreImports(u8: () => Uint8Array): Record<string, Function> {
        return {
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
                if (this.arenaTop > this.arenaEnd || alignedSize > this.arenaEnd - this.arenaTop) {
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
            logBytes: (_ci: number, level: number, msgOff: number, size: number) => {
                // Core stamps the contract index over the payload's leading word, logs, then clears it
                // (logging.h `__logContract*Message`). Its `logMessage` copies from the pointer it is given,
                // so the bytes that reach the record — and the log digest taken over them — are the stamped
                // ones. Reading the payload after the stamp is what keeps every reader agreeing with core.
                this.writeGuest(msgOff, contractIndexWord(this.slot));
                const payload = u8().slice(msgOff, msgOff + size);
                this.host.log(this.slot, level, payload);
                this.writeGuest(msgOff, CLEARED_LOG_HEADER_WORD);
            },
            cheat: (op: number, a: bigint, b: bigint, ptrOff: number, len: number): bigint => this.cheatCall(u8, op, a, b, ptrOff >>> 0, len),
            k12: (inOff: number, len: number, outOff: number) => this.writeGuest(outOff, k12Bytes(u8().slice(inOff, inOff + len))),
            abort: (code: number) => {
                throw new ContractAbort(code);
            },
        };
    }

    // `cheat` is deliberately absent from MUTATING_LHOST_IMPORTS: that list is a per-import ban, and it
    // would block CC_PRINT from every function. The mutating opcodes check the entry kind themselves.
    private cheatCall(u8: () => Uint8Array, op: number, a: bigint, b: bigint, pointer: number, len: number): bigint {
        if (op === CHEAT_OP.print) {
            this.host.cheatPrint(this.slot, Number(a >> 8n), Number(a & 0xffn), b, len ? u8().slice(pointer, pointer + len) : new Uint8Array(0));
            return 0n;
        }

        if (this.executionKinds.at(-1) === CONTRACT_ENTRY_KIND.FUNCTION) {
            return CHEAT_ERR.wrongContext;
        }

        switch (op) {
            case CHEAT_OP.deal:
                return len === 32 ? this.host.cheatDeal(u8().slice(pointer, pointer + 32) as Id, a) : CHEAT_ERR.unknownOp;
            case CHEAT_OP.warpTick:
                return this.host.cheatWarp(Number(a), 0);
            case CHEAT_OP.warpEpoch:
                return this.host.cheatWarp(0, Number(a));
            case CHEAT_OP.prank:
            case CHEAT_OP.unprank:
                return this.cheatPrank(op === CHEAT_OP.prank ? (u8().slice(pointer, pointer + 32) as Id) : null, a, len);
            default:
                return CHEAT_ERR.unknownOp;
        }
    }

    // Rewrites the guest's context view only. The engine's own caller attribution is untouched, so a
    // prank changes what the contract reads and nothing about how the call is accounted.
    private cheatPrank(caller: Id | null, invocationReward: bigint, len: number): bigint {
        if (caller && len !== 32) {
            return CHEAT_ERR.unknownOp;
        }

        const view = QpiContext.wrap(this.u8(), this.ctxAddr);

        if (!caller) {
            view.originator = this.prankSaved?.originator ?? view.originator;
            view.invocator = this.prankSaved?.invocator ?? view.invocator;
            view.invocationReward = this.prankSaved?.invocationReward ?? view.invocationReward;
            this.prankSaved = null;
            return view.invocationReward;
        }

        this.prankSaved ??= { originator: view.originator, invocator: view.invocator, invocationReward: view.invocationReward };
        view.originator = caller;
        view.invocator = caller;
        view.invocationReward = invocationReward;
        return invocationReward;
    }

    // lhost: tick, epoch, and calendar reads, plus the previous tick's committed digests.
    private timeImports(): Record<string, Function> {
        return {
            // time / tick (read-only)
            epoch: () => this.host.epoch() & 0xffff,
            tick: () => this.host.tick() >>> 0,
            initialTick: () => this.host.initialTick() >>> 0,
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
                this.noteGuestWrite(out, 8);
                new DataView(this.mem.buffer).setBigUint64(out, packDateAndTime(this.host.nowMs()), true);
            },
            // etalon-tick digests — the previous tick's committed state roots
            prevSpectrumDigest: (out: number) => this.writeGuest(out, this.host.getPrevSpectrumDigest().subarray(0, 32)),
            prevUniverseDigest: (out: number) => this.writeGuest(out, this.host.getPrevUniverseDigest().subarray(0, 32)),
            prevComputerDigest: (out: number) => this.writeGuest(out, this.host.getPrevComputerDigest().subarray(0, 32)),
        };
    }

    // lhost: identity derivation and spectrum lookups.
    private identityImports(u8: () => Uint8Array): Record<string, Function> {
        return {
            // identity / spectrum
            getEntity: (idOff: number, entityOff: number) => {
                const id = u8().slice(idOff, idOff + 32);
                const e = this.host.getEntity(id);
                this.noteGuestWrite(entityOff, EntityRecord.SIZE);
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
                this.writeGuest(outOff, this.host.nextId(u8().slice(idOff, idOff + 32)));
            },
            prevId: (idOff: number, outOff: number) => {
                this.writeGuest(outOff, this.host.prevId(u8().slice(idOff, idOff + 32)));
            },
            isContractId: (idOff: number) => this.host.isContractId(u8().slice(idOff, idOff + 32)),
            arbitrator: (out: number) => this.writeGuest(out, this.host.arbitrator().subarray(0, 32)),
            computor: (i: number, out: number) => this.writeGuest(out, this.host.computor(i >>> 0).subarray(0, 32)),
        };
    }

    // lhost: value transfer and balance reads, delegated to Layer 2.
    private ledgerImports(u8: () => Uint8Array): Record<string, Function> {
        return {
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
        };
    }

    // lhost: asset issuance, ownership, possession, and record enumeration.
    private assetImports(u8: () => Uint8Array, contextView: () => QpiContext): Record<string, Function> {
        return {
            // assets / shares
            isAssetIssued: (issOff: number, name: bigint) => this.host.isAssetIssued(u8().slice(issOff, issOff + 32), name),
            issueAsset: (name: bigint, issOff: number, dec: number, shares: bigint, unit: bigint) => {
                const r = this.host.issueAsset(this.slot, name, u8().slice(issOff, issOff + 32), (dec << 24) >> 24, shares, unit, contextView().invocator);
                this.recHost("issueAsset", () => `${assetName(name)} shares=${shares}`);
                return r;
            },
            numberOfShares: (aOff: number, oOff: number, pOff: number) =>
                this.host.numberOfShares(u8().slice(aOff, aOff + 40), u8().slice(oOff, oOff + 40), u8().slice(pOff, pOff + 40)),
            numberOfPossessedShares: (name: bigint, issOff: number, ownOff: number, posOff: number, ownMgmt: number, posMgmt: number) =>
                this.host.numberOfPossessedShares(
                    name,
                    u8().slice(issOff, issOff + 32),
                    u8().slice(ownOff, ownOff + 32),
                    u8().slice(posOff, posOff + 32),
                    ownMgmt & 0xffff,
                    posMgmt & 0xffff,
                ),
            // Write selected ownership or possession records to the contract's output buffer.
            assetEnumerate: (kind: number, issOff: number, ownOff: number, posOff: number, outOff: number, maxN: number) => {
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
                    this.noteGuestWrite(p, record.size);
                    mem.set(e.owner.subarray(0, record.fields.owner.size), p + record.fields.owner.offset);
                    mem.set(e.possessor.subarray(0, record.fields.possessor.size), p + record.fields.possessor.offset);
                    dv.setBigInt64(p + record.fields.shares.offset, e.shares, true);
                    dv.setUint16(p + record.fields.ownershipManagingContract.offset, e.ownMgmt & 0xffff, true);
                    dv.setUint16(p + record.fields.possessionManagingContract.offset, e.posMgmt & 0xffff, true);
                    p += record.size;
                }
                return n;
            },
            transferShareOwnershipAndPossession: (name: bigint, issOff: number, ownOff: number, posOff: number, shares: bigint, newOwnerOff: number) => {
                const newOwner = u8().slice(newOwnerOff, newOwnerOff + 32);
                const r = this.host.transferShareOwnershipAndPossession(
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
        };
    }

    // lhost: share management rights — qpi acquireShares / releaseShares.
    private shareRightsImports(u8: () => Uint8Array): Record<string, Function> {
        return {
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
                this.recHost("acquireShares", () => `${assetName(name)} ${shares} ← mgmt ${srcPosMgmt & 0xffff}`);
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
                this.recHost("releaseShares", () => `${assetName(name)} ${shares} → mgmt ${dstPosMgmt & 0xffff}`);
                return r;
            },
        };
    }

    // lhost: date, signature, IPO, mining, and oracle status.
    private platformImports(u8: () => Uint8Array): Record<string, Function> {
        return {
            // date / signature / IPO / mining / oracle-status — see HostServices (the dev engine stubs IPO/mining/oracle)
            dayOfWeek: (year: number, month: number, day: number) => this.host.dayOfWeek(year & 0xff, month & 0xff, day & 0xff),
            signatureValidity: (entOff: number, digOff: number, sigOff: number) =>
                this.host.signatureValidity(u8().slice(entOff, entOff + 32), u8().slice(digOff, digOff + 32), u8().slice(sigOff, sigOff + 64)),
            bidInIPO: (idx: number, price: bigint, qty: number) => this.host.bidInIPO(this.slot, idx >>> 0, price, qty >>> 0),
            ipoBidId: (idx: number, bid: number, outOff: number) => {
                this.writeGuest(outOff, this.host.ipoBidId(idx >>> 0, bid >>> 0).subarray(0, 32));
            },
            ipoBidPrice: (idx: number, bid: number) => this.host.ipoBidPrice(idx >>> 0, bid >>> 0),
            computeMiningFunction: (sOff: number, pkOff: number, nOff: number, outOff: number) => {
                const digest = this.host.computeMiningFunction(u8().slice(sOff, sOff + 32), u8().slice(pkOff, pkOff + 32), u8().slice(nOff, nOff + 32));
                this.writeGuest(outOff, digest.subarray(0, 32));
            },
            initMiningSeed: (sOff: number) => this.host.initMiningSeed(u8().slice(sOff, sOff + 32)),
            getOracleQueryStatus: (queryId: bigint) => this.host.getOracleQueryStatus(queryId),
            getOcInvocationStatus: (invocationId: bigint) => this.host.getOcInvocationStatus(invocationId),
            invokeOc: (interfaceIndex: number, requestOffset: number, requestSize: number) =>
                this.host.invokeOc(this.slot, interfaceIndex >>> 0, u8().slice(requestOffset, requestOffset + requestSize)),
            unsubscribeOracle: (sub: number) => this.host.unsubscribeOracle(this.slot, sub | 0),
        };
    }

    // lhost: oracle query, subscribe, and reply reads over opaque sized buffers.
    private oracleImports(u8: () => Uint8Array): Record<string, Function> {
        return {
            // oracle query/subscribe/read — the query/reply are opaque sized buffers (the contract owns the typing)
            queryOracle: (ifaceIdx: number, queryOff: number, querySize: number, replySize: number, procId: number, timeout: number, fee: bigint) =>
                this.host.queryOracle(this.slot, ifaceIdx >>> 0, u8().slice(queryOff, queryOff + querySize), replySize >>> 0, procId >>> 0, timeout >>> 0, fee),
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
                if (!q || q.length !== size) {
                    return 0;
                }
                this.writeGuest(outOff, q);
                return 1;
            },
            getOracleReply: (queryId: bigint, outOff: number, size: number) => {
                const r = this.host.getOracleReply(queryId);
                if (!r || r.length !== size) {
                    return 0;
                }
                this.writeGuest(outOff, r);
                return 1;
            },
            distributeDividends: (amountPerShare: bigint) => {
                const r = this.host.distributeDividends(this.slot, amountPerShare);
                this.recHost("distributeDividends", () => `${amountPerShare}/share`);
                return r;
            },
        };
    }

    // lhost: nested contract calls, which keep the original originator.
    private nestedCallImports(u8: () => Uint8Array, contextView: () => QpiContext): Record<string, Function> {
        return {
            // Nested calls keep the original originator.
            liteCallFunction: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number) => {
                const input = u8().slice(inOff, inOff + inSize);
                const originator = contextView().originator;
                const result = this.host.callFunction(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, originator);
                this.recHost("callFunction", () => `→ @${calleeIdx >>> 0} fn #${inputType & 0xffff}${result.error ? ` ✗ err ${result.error}` : ""}`);
                if (result.error === 0 && result.output.length > 0) {
                    this.writeGuest(outOff, result.output.subarray(0, Math.min(outSize, result.output.length)));
                }
                return result.error;
            },
            liteInvokeProcedure: (calleeIdx: number, inputType: number, inOff: number, inSize: number, outOff: number, outSize: number, reward: bigint) => {
                const input = u8().slice(inOff, inOff + inSize);
                const originator = contextView().originator;
                const result = this.host.invokeProcedure(this.slot, calleeIdx >>> 0, inputType & 0xffff, input, reward, originator);
                this.recHost(
                    "invokeProcedure",
                    () => `→ @${calleeIdx >>> 0} proc #${inputType & 0xffff} reward=${reward}${result.error ? ` ✗ err ${result.error}` : ""}`,
                );
                if (result.error === 0 && result.output.length > 0) {
                    this.writeGuest(outOff, result.output.subarray(0, Math.min(outSize, result.output.length)));
                }
                return result.error;
            },
            liteSetShareholderProposal: (calleeIdx: number, propOff: number, reward: bigint) => {
                const proposal = u8().slice(propOff, propOff + 1024);
                const originator = contextView().originator;
                return this.host.setShareholderProposal(this.slot, calleeIdx >>> 0, proposal, reward, originator);
            },
            liteSetShareholderVotes: (calleeIdx: number, voteOff: number, voteSize: number, reward: bigint) => {
                const vote = u8().slice(voteOff, voteOff + voteSize);
                const originator = contextView().originator;
                return this.host.setShareholderVotes(this.slot, calleeIdx >>> 0, vote, reward, originator);
            },
        };
    }

    private imports(wasmModule?: WebAssembly.Module): WebAssembly.Imports {
        const u8 = () => this.u8();
        const contextView = () => QpiContext.wrap(u8(), this.ctxAddr);
        const lhost: Record<string, Function> = {
            ...this.coreImports(u8),
            ...this.timeImports(),
            ...this.identityImports(u8),
            ...this.ledgerImports(u8),
            ...this.assetImports(u8, contextView),
            ...this.shareRightsImports(u8),
            ...this.platformImports(u8),
            ...this.oracleImports(u8),
            ...this.nestedCallImports(u8, contextView),
        };

        for (const name of MUTATING_LHOST_IMPORTS) {
            const hostFunction = lhost[name];
            lhost[name] = (...args: unknown[]) => {
                if (this.executionKinds.at(-1) === CONTRACT_ENTRY_KIND.FUNCTION) {
                    throw new Error(`contract function cannot call mutating host import ${name}`);
                }

                return hostFunction(...args);
            };
        }
        const missingLhost = Object.keys(LHOST_ABI).filter((name) => !(name in lhost));
        const extraLhost = Object.keys(lhost).filter((name) => !(name in LHOST_ABI));
        if (missingLhost.length || extraLhost.length) {
            throw new Error(`simulator lhost table drift (missing: ${missingLhost.join(", ") || "none"}; extra: ${extraLhost.join(", ") || "none"})`);
        }
        this.meterLhost(lhost);
        // Wasm i32 parameters arrive signed in JS; coerce offsets to unsigned above 2 GiB.
        const toU32Args =
            (hostFunction: Function) =>
            (...args: unknown[]) =>
                hostFunction(...args.map((argument) => (typeof argument === "number" ? argument >>> 0 : argument)));

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
                const noopFunction = results.includes("i64") ? (..._args: unknown[]) => 0n : (..._args: unknown[]) => 0;

                if (imported.module === "wasi_snapshot_preview1" && !(imported.name in wasiImports)) {
                    wasiImports[imported.name] = noopFunction;
                } else if (imported.module === "env" && !(imported.name in envImports)) {
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

function shortId(id: Id): string {
    const hasHighBytes = id.subarray(8, 32).some((byte) => byte !== 0);
    if (!hasHighBytes) {
        const contractIndex = new DataView(id.buffer, id.byteOffset, id.byteLength).getBigUint64(0, true);
        return "@" + contractIndex;
    }

    return idPrefix(id, 8) + "…" + idSuffix(id);
}

// Encode the first identity-body chunk without computing the checksum.
function idPrefix(id: Id, length: number): string {
    let value = new DataView(id.buffer, id.byteOffset, id.byteLength).getBigUint64(0, true);
    let prefix = "";

    for (let index = 0; index < length; index++) {
        prefix += String.fromCharCode(65 + Number(value % 26n));
        value /= 26n;
    }

    return prefix;
}

function idSuffix(id: Id): string {
    let fragment = new DataView(id.buffer, id.byteOffset, id.byteLength).getBigUint64(24, true);
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
