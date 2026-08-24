import { UnsupportedFeature } from "../shared/enums";
import type { Span } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

interface FeatureText {
    // The noun phrase naming the gap in a diagnostic.
    noun: string;
    // What to do instead, for features that lower correctly but are non-canonical.
    advice?: string;
}

const FEATURE_TEXT: Record<UnsupportedFeature, FeatureText> = {
    [UnsupportedFeature.NATIVE_C_SCALAR]: {
        noun: "native C type",
        advice: "it lowers at its wasm32 width, but the QPI spellings (uint64, sint32, ...) are fixed-width on every target",
    },
    [UnsupportedFeature.DESTRUCTOR]: {
        noun: "destructor",
    },
};

const CLANG_REMEDY = "the TypeScript compiler does not implement this yet; build this contract with clang";

function describe(feature: UnsupportedFeature, detail: string | undefined): string {
    return detail ? `${FEATURE_TEXT[feature].noun} '${detail}'` : FEATURE_TEXT[feature].noun;
}

/**
 * Refuse the contract outright, with no strict-mode opt-out.
 *
 * For gaps that corrupt memory or the host ABI, where even a lax build must not produce wasm.
 */
export function raiseUnsupported(programAnalysis: ProgramAnalysis, feature: UnsupportedFeature, at: number | Span, detail?: string): void {
    programAnalysis.error(`unsupported ${describe(feature, detail)} — ${CLANG_REMEDY}`, at);
}

/**
 * Refuse the contract unless strict mode is off.
 *
 * For gaps that cannot be lowered faithfully, so allowing them through yields wrong answers.
 */
export function reportUnsupported(programAnalysis: ProgramAnalysis, feature: UnsupportedFeature, at: number | Span, detail?: string): void {
    programAnalysis.warn(`unsupported ${describe(feature, detail)} — ${CLANG_REMEDY}`, at);
}

/**
 * Warn but keep building, even under strict mode.
 *
 * For constructs that lower correctly and are merely non-canonical. Refusing these would break
 * working contracts to fix a problem they do not have.
 */
export function adviseUnsupported(programAnalysis: ProgramAnalysis, feature: UnsupportedFeature, at: number | Span, detail?: string): void {
    programAnalysis.advise(`non-canonical ${describe(feature, detail)} — ${FEATURE_TEXT[feature].advice}`, at);
}
