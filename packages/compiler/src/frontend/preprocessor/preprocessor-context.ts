// C preprocessor for QPI subset. Operates on text, not tokens.
export interface PreprocessOptions {
    source: string; // contract source
    qpiHeader: string; // preprocessed qpi.h content (all #includes resolved)
    contractName: string;
    contractIndex: number;
    calleePrelude?: string; // inter-contract callee type headers
    seedMacros?: Map<string, MacroDef>; // pre-built macro table (from qpi.h) to start from
    expandMacros?: boolean;
    preserveSourceOffsets?: boolean;
}

export interface MacroDef {
    name: string;
    params: string[] | null; // null = object-like, [] = function-like with no params
    body: string;
    isVarArgs: boolean;
}

export type { Preprocessor as PreprocessorInternals } from "./preprocessor";
