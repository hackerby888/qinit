import type { ParserDiagnostic } from "../frontend/parser";
import type { CheatMode } from "./qpi/cheats";
import type { ContractIdl } from "@qinit/proto/contract-idl";

export type { ContractIdl } from "@qinit/proto/contract-idl";

export interface CompileOptions {
    source: string;
    contractName: string;
    slot: number;
    arenaSizeBytes?: number;
    journalCapBytes?: number;
    callees?: ContractIdl[];
    calleeSources?: Array<{
        name: string;
        source: string;
        slot?: number;
    }>;
    testSource?: string;
    testPath?: string;
    qpiHeader?: string;
    sharedMemoryBaseOffsetBytes?: number;
    onPhase?: (phase: string) => void | Promise<void>;
    strict?: boolean;
    constructionEpoch?: number;
    // Cheatcodes are on for ordinary builds. "noop" is the reference build the strip is proved
    // against; "off" injects nothing at all, which is what Core sees.
    cheats?: CheatMode;
}

export interface CompileResult {
    wasm: Uint8Array;
    diagnostics: ParserDiagnostic[];
    idl?: ContractIdl;
    timings?: Record<string, number>;
}

export interface GtestProgram {
    version: 2;
    contract: string;
    mainSlot: number;
    runnerSlot: number;
    mainConstructionEpoch: number;
    tests: Array<{ name: string; inputType: number }>;
}

// The element type of CompileResult.diagnostics — the single name both entry points publish.
export type CompileDiagnostic = ParserDiagnostic;
export type GtestDiagnostic = ParserDiagnostic;

export interface GtestCompileResult {
    wasm?: Uint8Array;
    program?: GtestProgram;
    diagnostics: GtestDiagnostic[];
    idl?: ContractIdl;
}
