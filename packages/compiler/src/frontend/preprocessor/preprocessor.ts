import type { MacroDef, PreprocessOptions } from "./preprocessor-context";
import * as preprocessorPart0 from "./preprocessor-core";
import * as preprocessorPart1 from "./directive-handler";
import * as preprocessorPart2 from "./condition-evaluator";
import * as preprocessorPart3 from "./macro-expander";
import * as preprocessorPart4 from "./source-scanner";

export class Preprocessor {
    defines: Map<string, MacroDef> = new Map();
    expanding: Set<string> = new Set();
    line: number = 1;
    result: string = "";
    input: string = "";
    pos: number = 0;
    srcLine: number[]; // line → byte offset map
    expandMacros = true;
    preserveSourceOffsets = false;
    // Track whether each conditional branch is active or already taken.
    condStack: {
        active: boolean;
        taken: boolean;
        parentActive: boolean;
    }[] = [];
    constructor() {
        this.srcLine = [];
    }
    condActive(): boolean {
        return preprocessorPart0.condActive(this);
    }
    // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
    getDefines(): Map<string, MacroDef> {
        return preprocessorPart0.getDefines(this);
    }
    preprocess(options: PreprocessOptions): string {
        return preprocessorPart0.preprocess(this, options);
    }
    define(name: string, body: string): void {
        return preprocessorPart0.define(this, name, body);
    }
    buildLineMap(src: string): void {
        return preprocessorPart0.buildLineMap(this, src);
    }
    process(src: string): string {
        return preprocessorPart0.process(this, src);
    }
    handleDirective(): void {
        return preprocessorPart1.handleDirective(this);
    }
    // ---- conditional stack ----
    pushCond(condition: boolean): void {
        return preprocessorPart1.pushCond(this, condition);
    }
    applyElif(condition: boolean): void {
        return preprocessorPart1.applyElif(this, condition);
    }
    applyElse(): void {
        return preprocessorPart1.applyElse(this);
    }
    readDirectiveWord(): string {
        return preprocessorPart1.readDirectiveWord(this);
    }
    // Read the rest of the line (the #if/#elif condition), expand defined()/macros, evaluate to bool.
    evalIfCondition(): boolean {
        return preprocessorPart2.evalIfCondition(this);
    }
    // Evaluate a preprocessor constant expression: defined(X), !, &&, ||, comparisons, integer literals.
    evalConstCondition(expression: string): bigint {
        return preprocessorPart2.evalConstCondition(this, expression);
    }
    // Tiny arithmetic/logic evaluator over a string of integers and operators.
    evalArith(text: string): bigint {
        return preprocessorPart2.evalArith(this, text);
    }
    handleInclude(): void {
        return preprocessorPart1.handleInclude(this);
    }
    handleDefine(): void {
        return preprocessorPart1.handleDefine(this);
    }
    handleUndef(): void {
        return preprocessorPart1.handleUndef(this);
    }
    handlePragma(): void {
        return preprocessorPart1.handlePragma(this);
    }
    // ---- Macro expansion ----
    tryExpandMacro(name: string): string | null {
        return preprocessorPart3.tryExpandMacro(this, name);
    }
    expandBody(def: MacroDef, callArguments: string[]): string {
        return preprocessorPart3.expandBody(this, def, callArguments);
    }
    // Like replaceParam but handles the case where param appears before/after ##
    replaceParamInBody(body: string, param: string, value: string): string {
        return preprocessorPart3.replaceParamInBody(this, body, param, value);
    }
    processTokenPaste(body: string): string {
        return preprocessorPart3.processTokenPaste(this, body);
    }
    processStringify(body: string, callArguments: string[], def: MacroDef): string {
        return preprocessorPart3.processStringify(this, body, callArguments, def);
    }
    replaceParam(body: string, param: string, value: string): string {
        return preprocessorPart3.replaceParam(this, body, param, value);
    }
    // Read macro arguments from a string starting at the opening parenthesis.
    readArgsFromString(
        text: string,
        openIdx: number,
    ): {
        callArguments: string[];
        end: number;
    } | null {
        return preprocessorPart3.readArgsFromString(this, text, openIdx);
    }
    expandRecursive(text: string): string {
        return preprocessorPart3.expandRecursive(this, text);
    }
    readIdentAt(text: string, start: number): string {
        return preprocessorPart4.readIdentAt(this, text, start);
    }
    // ---- Helpers ----
    isIdStart(ch: string): boolean {
        return preprocessorPart4.isIdStart(this, ch);
    }
    readIdentifier(): string {
        return preprocessorPart4.readIdentifier(this);
    }
    isIdContinue(ch: string): boolean {
        return preprocessorPart4.isIdContinue(this, ch);
    }
    peek(offset: number): string {
        return preprocessorPart4.peek(this, offset);
    }
    skipWhitespace(): void {
        return preprocessorPart4.skipWhitespace(this);
    }
    skipWhitespaceAndNewlines(): void {
        return preprocessorPart4.skipWhitespaceAndNewlines(this);
    }
    readToNewline(): string {
        return preprocessorPart4.readToNewline(this);
    }
    skipToNewline(): void {
        return preprocessorPart4.skipToNewline(this);
    }
    readUntil(stop: string): string {
        return preprocessorPart4.readUntil(this, stop);
    }
    skipLineComment(): void {
        return preprocessorPart4.skipLineComment(this);
    }
    skipBlockComment(): void {
        return preprocessorPart4.skipBlockComment(this);
    }
    escapeRegex(text: string): string {
        return preprocessorPart4.escapeRegex(this, text);
    }
}
