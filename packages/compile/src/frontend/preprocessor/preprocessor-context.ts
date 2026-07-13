

// C preprocessor for QPI subset. Operates on text, not tokens.
export interface PreprocessOptions {
    source: string; // contract source
    qpiHeader: string; // preprocessed qpi.h content (all #includes resolved)
    contractName: string;
    contractIndex: number;
    calleePrelude?: string; // inter-contract callee type headers
    seedMacros?: Map<string, MacroDef>; // pre-built macro table (from qpi.h) to start from
}

export interface MacroDef {
    name: string;
    params: string[] | null; // null = object-like, [] = function-like with no params
    body: string;
    isVarArgs: boolean;
}

export interface PreprocessorInternals {
  defines: Map<string, MacroDef>;
  expanding: Set<string>;
  line: number;
  result: string;
  input: string;
  pos: number;
  srcLine: number[];
  condStack: {
    active: boolean;
    taken: boolean;
    parentActive: boolean;
}[];
  condActive(): boolean;
  // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
getDefines(): Map<string, MacroDef>;
  preprocess(options: PreprocessOptions): string;
  define(name: string, body: string): void;
  buildLineMap(src: string): void;
  process(src: string): string;
  handleDirective(): void;
  pushCond(condition: boolean): void;
  applyElif(condition: boolean): void;
  applyElse(): void;
  readDirectiveWord(): string;
  evalIfCondition(): boolean;
  evalConstCondition(expression: string): bigint;
  evalArith(text: string): bigint;
  handleInclude(): void;
  handleDefine(): void;
  handleUndef(): void;
  handlePragma(): void;
  tryExpandMacro(name: string): string | null;
  expandBody(def: MacroDef, callArguments: string[]): string;
  replaceParamInBody(body: string, param: string, value: string): string;
  processTokenPaste(body: string): string;
  processStringify(body: string, callArguments: string[], def: MacroDef): string;
  replaceParam(body: string, param: string, value: string): string;
  readArgsFromString(text: string, openIdx: number): {
    callArguments: string[];
    end: number;
} | null;
  expandRecursive(text: string): string;
  readIdentAt(text: string, start: number): string;
  isIdStart(ch: string): boolean;
  readIdentifier(): string;
  isIdContinue(ch: string): boolean;
  peek(offset: number): string;
  skipWhitespace(): void;
  skipWhitespaceAndNewlines(): void;
  readToNewline(): string;
  skipToNewline(): void;
  readUntil(stop: string): string;
  skipLineComment(): void;
  skipBlockComment(): void;
  escapeRegex(text: string): string;
}
