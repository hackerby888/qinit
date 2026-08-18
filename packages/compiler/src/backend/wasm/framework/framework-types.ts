import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import { type LhostAbiSpec } from "../lhost";
import type { PlatformCapability } from "../calls/platform-primitives";
import { INPUT_BUFFER_BYTES, JOURNAL_REGION_BYTES, LOCALS_BUFFER_BYTES, OUTPUT_BUFFER_BYTES } from "@qinit/core/wasm/sizing";

// WAT assembler for a complete contract module.
export const IN_SZ = INPUT_BUFFER_BYTES;

export const OUT_SZ = OUTPUT_BUFFER_BYTES;

export const LOCALS_SZ = LOCALS_BUFFER_BYTES;

export interface QpiContextLayout {
    size: number;
    contractIndex: number;
    originator: number;
    invocator: number;
    invocationReward: number;
}

export interface UserEntry {
    inputType: number; // user-assigned [1..65535]
    kind: number; // 0 = function, 1 = procedure
    inSize: number;
    outSize: number;
    localsSize: number;
    label: string; // WAT function name, e.g. "$user_0"
}

export interface SystemProcedureInfo {
    id: number; // Wasm system-procedure id (0..11)
    localsSize: number;
    inSize: number;
    outSize: number;
    label: string; // WAT function name, e.g. "$sys_0"
}

export interface ModuleSpecification {
    contractSlot: number;
    stateSize: number;
    arenaSize: number;
    contextLayout: QpiContextLayout;
    entries: UserEntry[];
    sysprocs: SystemProcedureInfo[];
    userFunctionsWat: string; // the $user_N / $sys_N function definitions
    migrate?: {
        label: string;
        oldStateSize: number;
        localsSize: number;
    }; // MIGRATE() metadata + dispatch target
    memBase?: number; // shared-memory gtest mode: import env.memory and place the whole layout at
    // this byte offset inside the provider's (corpus runner's) memory.
    gtest?: boolean; // TS-compiled test runner: include the private qtest host ABI
    capabilities?: readonly PlatformCapability[];
    lhostAbi?: LhostAbiSpec; // parsed live-core imports; browser/direct callers use the generated default
    assetEnumerationRecord?: {
        readonly size: number;
        readonly capacity: number;
    };
}

export interface Layout {
    stateBase: number;
    stateSize: number;
    ctxBase: number;
    ioBase: number;
    inBase: number;
    outBase: number;
    localsBase: number;
    arenaEnd: number;
    ioSize: number;
    pages: number;
    iterBufBase: number;
}

export function computeLayout(
    stateSize: number,
    arenaSize: number,
    contextSize: number,
    memBase = 0,
    assetRecord: {
        readonly size: number;
        readonly capacity: number;
    } = ASSET_ENUMERATION_RECORD,
    reserveJournal = true,
): Layout {
    const align = (count: number, argument: number) => Math.ceil(count / argument) * argument;
    const stateBase = memBase;
    const ctxBase = align(stateBase + Math.max(stateSize, 8), 16);
    const ioBase = align(ctxBase + contextSize, 16);
    const inBase = ioBase;
    const outBase = inBase + IN_SZ;
    const localsBase = outBase + OUT_SZ;
    const arenaBase = localsBase + LOCALS_SZ;
    const arenaEnd = arenaBase + arenaSize;
    const ioSize = IN_SZ + OUT_SZ + LOCALS_SZ + arenaSize;
    // The write journal lives immediately past what io_size() reports, so a host finds it at
    // io_base() + io_size() without the contract losing any arena. Shared-memory builds carry no
    // journal and are packed by a stride the caller computes, so they must not reserve it.
    const journalBytes = reserveJournal ? JOURNAL_REGION_BYTES : 0;
    // Reserve an aligned buffer for asset-iterator enumeration results.
    const iterBufBase = align(arenaEnd + journalBytes, 16);
    const iterBufSize = assetRecord.size * assetRecord.capacity;
    const pages = Math.ceil((iterBufBase + iterBufSize) / 65536) + 1;
    return {
        stateBase,
        stateSize,
        ctxBase,
        ioBase,
        inBase,
        outBase,
        localsBase,
        arenaEnd,
        ioSize,
        pages,
        iterBufBase,
    };
}
