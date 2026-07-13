import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import { type LhostAbiSpec } from "../../../lhost";
import type { PlatformCapability } from "../calls/platform-primitives";

// WAT assembler for a complete contract module.
export const IN_SZ = 64 * 1024;

export const OUT_SZ = 64 * 1024;

export const LOCALS_SZ = 32 * 1024;

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
    id: number; // LITE_SP_* id (0..11)
    localsSize: number;
    inSize: number;
    outSize: number;
    label: string; // WAT function name, e.g. "$sys_0"
}

export interface ModuleSpecification {
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
    // this byte offset inside the provider's (corpus runner's) memory. Every
    gtest?: boolean; // TS-compiled test runner: include the private qtest host ABI
    capabilities?: readonly PlatformCapability[];
    lhostAbi?: LhostAbiSpec; // parsed live-core imports; browser/direct callers use the generated default
    assetEnumerationRecord?: {
        readonly size: number;
        readonly capacity: number;
    };
}

// Back-compat shape used by older callers / tests.
export interface FrameworkOptions {
    stateSize: number;
    arenaSize: number;
    userEntryCount: number;
    sysprocMask: number;
    contextLayout: QpiContextLayout;
}

export interface Layout {
    stateBase: number;
    stateSize: number;
    ctxBase: number;
    ioBase: number;
    inBase: number;
    outBase: number;
    localsBase: number;
    arenaBase: number;
    arenaEnd: number;
    ioSize: number;
    pages: number;
    iterBufBase: number;
}

export function computeLayout(stateSize: number, arenaSize: number, contextSize: number, memBase = 0, assetRecord: {
    readonly size: number;
    readonly capacity: number;
} = ASSET_ENUMERATION_RECORD): Layout {
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
    // Asset-iterator result buffer (AssetOwnership/PossessionIterator): 1024 records × 80 bytes, written by the assetEnumerate host import at begin() and
    const iterBufBase = align(arenaEnd, 16);
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
        arenaBase,
        arenaEnd,
        ioSize,
        pages,
        iterBufBase,
    };
}
