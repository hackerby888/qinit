
import type { MacroDef, PreprocessOptions, PreprocessorInternals } from "./preprocessor-context";
import * as preprocessorPart0 from "./preprocessor-core";
import * as preprocessorPart1 from "./directive-handler";
import * as preprocessorPart2 from "./condition-evaluator";
import * as preprocessorPart3 from "./macro-expander";
import * as preprocessorPart4 from "./source-scanner";

export class Preprocessor {
    private defines: Map<string, MacroDef> = new Map();
    private expanding: Set<string> = new Set();
    private line: number = 1;
    private result: string = "";
    private input: string = "";
    private pos: number = 0;
    private srcLine: number[]; // line → byte offset map
    // Track whether each conditional branch is active or already taken.
    private condStack: {
        active: boolean;
        taken: boolean;
        parentActive: boolean;
    }[] = [];
    constructor() {
        this.srcLine = [];
    }
    private condActive(): boolean {
        return preprocessorPart0.condActive(this as unknown as PreprocessorInternals);
    }
    // The macro table after a run — used to capture qpi.h's #defines for reuse on user source.
    getDefines(): Map<string, MacroDef> {
        return preprocessorPart0.getDefines(this as unknown as PreprocessorInternals);
    }
    preprocess(options: PreprocessOptions): string {
        return preprocessorPart0.preprocess(this as unknown as PreprocessorInternals, options);
    }
    define(name: string, body: string): void {
        return preprocessorPart0.define(this as unknown as PreprocessorInternals, name, body);
    }
    private buildLineMap(src: string): void {
        return preprocessorPart0.buildLineMap(this as unknown as PreprocessorInternals, src);
    }
    private process(src: string): string {
        return preprocessorPart0.process(this as unknown as PreprocessorInternals, src);
    }
    private handleDirective(): void {
        return preprocessorPart1.handleDirective(this as unknown as PreprocessorInternals);
    }
    // ---- conditional stack ----
    private pushCond(condition: boolean): void {
        return preprocessorPart1.pushCond(this as unknown as PreprocessorInternals, condition);
    }
    private applyElif(condition: boolean): void {
        return preprocessorPart1.applyElif(this as unknown as PreprocessorInternals, condition);
    }
    private applyElse(): void {
        return preprocessorPart1.applyElse(this as unknown as PreprocessorInternals);
    }
    private readDirectiveWord(): string {
        return preprocessorPart1.readDirectiveWord(this as unknown as PreprocessorInternals);
    }
    // Read the rest of the line (the #if/#elif condition), expand defined()/macros, evaluate to bool.
    private evalIfCondition(): boolean {
        return preprocessorPart2.evalIfCondition(this as unknown as PreprocessorInternals);
    }
    // Evaluate a preprocessor constant expression: defined(X), !, &&, ||, comparisons, integer literals.
    private evalConstCondition(expression: string): bigint {
        return preprocessorPart2.evalConstCondition(this as unknown as PreprocessorInternals, expression);
    }
    // Tiny arithmetic/logic evaluator over a string of integers and operators.
    private evalArith(text: string): bigint {
        return preprocessorPart2.evalArith(this as unknown as PreprocessorInternals, text);
    }
    private handleInclude(): void {
        return preprocessorPart1.handleInclude(this as unknown as PreprocessorInternals);
    }
    private handleDefine(): void {
        return preprocessorPart1.handleDefine(this as unknown as PreprocessorInternals);
    }
    private handleUndef(): void {
        return preprocessorPart1.handleUndef(this as unknown as PreprocessorInternals);
    }
    private handlePragma(): void {
        return preprocessorPart1.handlePragma(this as unknown as PreprocessorInternals);
    }
    // ---- Macro expansion ----
    private tryExpandMacro(name: string): string | null {
        return preprocessorPart3.tryExpandMacro(this as unknown as PreprocessorInternals, name);
    }
    private expandBody(def: MacroDef, callArguments: string[]): string {
        return preprocessorPart3.expandBody(this as unknown as PreprocessorInternals, def, callArguments);
    }
    // Like replaceParam but handles the case where param appears before/after ##
    private replaceParamInBody(body: string, param: string, value: string): string {
        return preprocessorPart3.replaceParamInBody(this as unknown as PreprocessorInternals, body, param, value);
    }
    private processTokenPaste(body: string): string {
        return preprocessorPart3.processTokenPaste(this as unknown as PreprocessorInternals, body);
    }
    private processStringify(body: string, callArguments: string[], def: MacroDef): string {
        return preprocessorPart3.processStringify(this as unknown as PreprocessorInternals, body, callArguments, def);
    }
    private replaceParam(body: string, param: string, value: string): string {
        return preprocessorPart3.replaceParam(this as unknown as PreprocessorInternals, body, param, value);
    }
    // Read macro arguments from a string starting at the opening parenthesis.
    private readArgsFromString(text: string, openIdx: number): {
        callArguments: string[];
        end: number;
    } | null {
        return preprocessorPart3.readArgsFromString(this as unknown as PreprocessorInternals, text, openIdx);
    }
    private expandRecursive(text: string): string {
        return preprocessorPart3.expandRecursive(this as unknown as PreprocessorInternals, text);
    }
    private readIdentAt(text: string, start: number): string {
        return preprocessorPart4.readIdentAt(this as unknown as PreprocessorInternals, text, start);
    }
    // ---- Helpers ----
    private isIdStart(ch: string): boolean {
        return preprocessorPart4.isIdStart(this as unknown as PreprocessorInternals, ch);
    }
    private readIdentifier(): string {
        return preprocessorPart4.readIdentifier(this as unknown as PreprocessorInternals);
    }
    private isIdContinue(ch: string): boolean {
        return preprocessorPart4.isIdContinue(this as unknown as PreprocessorInternals, ch);
    }
    private peek(offset: number): string {
        return preprocessorPart4.peek(this as unknown as PreprocessorInternals, offset);
    }
    private skipWhitespace(): void {
        return preprocessorPart4.skipWhitespace(this as unknown as PreprocessorInternals);
    }
    private skipWhitespaceAndNewlines(): void {
        return preprocessorPart4.skipWhitespaceAndNewlines(this as unknown as PreprocessorInternals);
    }
    private readToNewline(): string {
        return preprocessorPart4.readToNewline(this as unknown as PreprocessorInternals);
    }
    private skipToNewline(): void {
        return preprocessorPart4.skipToNewline(this as unknown as PreprocessorInternals);
    }
    private readUntil(stop: string): string {
        return preprocessorPart4.readUntil(this as unknown as PreprocessorInternals, stop);
    }
    private skipLineComment(): void {
        return preprocessorPart4.skipLineComment(this as unknown as PreprocessorInternals);
    }
    private skipBlockComment(): void {
        return preprocessorPart4.skipBlockComment(this as unknown as PreprocessorInternals);
    }
    private escapeRegex(text: string): string {
        return preprocessorPart4.escapeRegex(this as unknown as PreprocessorInternals, text);
    }
}
