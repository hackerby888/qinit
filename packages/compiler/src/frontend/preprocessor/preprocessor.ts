import type { MacroDef, PreprocessOptions } from "./preprocessor-context";
import * as preprocessorCore from "./preprocessor-core";
import * as directiveHandler from "./directive-handler";
import * as conditionEvaluator from "./condition-evaluator";
import * as macroExpander from "./macro-expander";
import * as sourceScanner from "./source-scanner";

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
        return preprocessorCore.condActive(this);
    }
    // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
    getDefines(): Map<string, MacroDef> {
        return preprocessorCore.getDefines(this);
    }
    preprocess(options: PreprocessOptions): string {
        return preprocessorCore.preprocess(this, options);
    }
    define(name: string, body: string): void {
        return preprocessorCore.define(this, name, body);
    }
    buildLineMap(src: string): void {
        return preprocessorCore.buildLineMap(this, src);
    }
    process(src: string): string {
        return preprocessorCore.process(this, src);
    }
    handleDirective(): void {
        return directiveHandler.handleDirective(this);
    }
    // ---- conditional stack ----
    pushCond(condition: boolean): void {
        return directiveHandler.pushCond(this, condition);
    }
    applyElif(condition: boolean): void {
        return directiveHandler.applyElif(this, condition);
    }
    applyElse(): void {
        return directiveHandler.applyElse(this);
    }
    readDirectiveWord(): string {
        return directiveHandler.readDirectiveWord(this);
    }
    // Read the rest of the line (the #if/#elif condition), expand defined()/macros, evaluate to bool.
    evalIfCondition(): boolean {
        return conditionEvaluator.evalIfCondition(this);
    }
    // Evaluate a preprocessor constant expression: defined(X), !, &&, ||, comparisons, integer literals.
    evalConstCondition(expression: string): bigint {
        return conditionEvaluator.evalConstCondition(this, expression);
    }
    // Tiny arithmetic/logic evaluator over a string of integers and operators.
    evalArith(text: string): bigint {
        return conditionEvaluator.evalArith(text);
    }
    handleInclude(): void {
        return directiveHandler.handleInclude(this);
    }
    handleDefine(): void {
        return directiveHandler.handleDefine(this);
    }
    handleUndef(): void {
        return directiveHandler.handleUndef(this);
    }
    handlePragma(): void {
        return directiveHandler.handlePragma(this);
    }
    // ---- Macro expansion ----
    tryExpandMacro(name: string): string | null {
        return macroExpander.tryExpandMacro(this, name);
    }
    expandBody(def: MacroDef, callArguments: string[]): string {
        return macroExpander.expandBody(this, def, callArguments);
    }
    // Like replaceParam but handles the case where param appears before/after ##
    replaceParamInBody(body: string, param: string, value: string): string {
        return macroExpander.replaceParamInBody(this, body, param, value);
    }
    processTokenPaste(body: string): string {
        return macroExpander.processTokenPaste(body);
    }
    processStringify(body: string, callArguments: string[], def: MacroDef): string {
        return macroExpander.processStringify(this, body, callArguments, def);
    }
    replaceParam(body: string, param: string, value: string): string {
        return macroExpander.replaceParam(this, body, param, value);
    }
    // Read macro arguments from a string starting at the opening parenthesis.
    readArgsFromString(
        text: string,
        openIdx: number,
    ): {
        callArguments: string[];
        end: number;
    } | null {
        return macroExpander.readArgsFromString(text, openIdx);
    }
    expandRecursive(text: string): string {
        return macroExpander.expandRecursive(this, text);
    }
    readIdentAt(text: string, start: number): string {
        return sourceScanner.readIdentAt(this, text, start);
    }
    // ---- Helpers ----
    isIdStart(ch: string): boolean {
        return sourceScanner.isIdStart(ch);
    }
    readIdentifier(): string {
        return sourceScanner.readIdentifier(this);
    }
    isIdContinue(ch: string): boolean {
        return sourceScanner.isIdContinue(this, ch);
    }
    peek(offset: number): string {
        return sourceScanner.peek(this, offset);
    }
    skipWhitespace(): void {
        return sourceScanner.skipWhitespace(this);
    }
    skipWhitespaceAndNewlines(): void {
        return sourceScanner.skipWhitespaceAndNewlines(this);
    }
    readToNewline(): string {
        return sourceScanner.readToNewline(this);
    }
    skipToNewline(): void {
        return sourceScanner.skipToNewline(this);
    }
    readUntil(stop: string): string {
        return sourceScanner.readUntil(this, stop);
    }
    skipLineComment(): void {
        return sourceScanner.skipLineComment(this);
    }
    skipBlockComment(): void {
        return sourceScanner.skipBlockComment(this);
    }
    escapeRegex(text: string): string {
        return sourceScanner.escapeRegex(text);
    }
}
