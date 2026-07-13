import type { Token, TokenKind } from "../../lexer";
import { Lexer } from "../../lexer";
import type { ClassTemplateDecl, Declaration, EmptyDecl, EnumDecl, EnumeratorDecl, Expression, ExternBlockDecl, FriendDecl, FunctionDecl, FunctionTemplateDecl, NamespaceDecl, ParamDecl, Span, Statement, StaticAssertDecl, StructDecl, TemplateParam, TranslationUnit, TypedefDeclNode, TypeSpec, VariableDecl } from "../../ast";
import type {
    ParserDiagnostic as Diagnostic,
    ParserInternals,
} from "./parser-context";
import * as parserPart0 from "./declarations/declaration-parser";
import * as parserPart1 from "./declarations/record-parser";
import * as parserPart2 from "./declarations/template-parser";
import * as parserPart3 from "./declarations/enum-alias-parser";
import * as parserPart4 from "./declarations/function-parser";
import * as parserPart5 from "./types/type-parser";
import * as parserPart6 from "./types/name-and-cast-parser";
import * as parserPart7 from "./expressions/precedence-parser";
import * as parserPart8 from "./expressions/postfix-parser";
import * as parserPart9 from "./expressions/primary-parser";
import * as parserPart10 from "./statement-parser";
import * as parserPart11 from "./parser-recovery";
import * as parserPart12 from "./idl-extractor";

export type { ParserDiagnostic as Diagnostic } from "./parser-context";

export class Parser {
    private lex: Lexer;
    private diagnostics: Diagnostic[] = [];
    // Diagnostics raised while parsing a function body in isolation. They stay visible (getDiagnostics
    private bodyDiagnostics: Diagnostic[] = [];
    // While > 0 (inside a template parameter/argument list), a top-level `>` / `>>` closes the list rather than
    private gtDisabled = 0;
    // Extra declarations produced by a single parse step (e.g. `struct {...} a, b[4];` yields the
    private pending: Declaration[] = [];
    constructor(tokens: Token[]) {
        this.lex = new Lexer("");
        // Inject pre-tokenized stream
        (this.lex as any).tokens = tokens;
        (this.lex as any).index = 0;
        // Ensure there's an eof token
        if (tokens.length === 0 || tokens[tokens.length - 1].kind !== "eof") {
            tokens.push({ kind: "eof", text: "", span: { start: 0, end: 0, line: 0, column: 0 } });
        }
    }
    parseTranslationUnit(): TranslationUnit {
        const start = this.peek().span;
        const declarations: Declaration[] = [];
        while (!this.eof()) {
            const before = (this.lex as any).index;
            const errsBefore = this.diagnostics.length;
            const declaration = this.parseDeclaration();
            if (declaration && declaration.kind !== "empty")
                declarations.push(declaration);
            while (this.pending.length)
                declarations.push(this.pending.shift()!);
            this.recover(before, errsBefore);
        }
        const end = this.last().span;
        return {
            declarations: declarations,
            span: { start: start.start, end: end.end, line: start.line, column: start.column },
        };
    }
    getDiagnostics(): Diagnostic[] {
        return [...this.diagnostics, ...this.bodyDiagnostics];
    }
    // Parse function bodies in isolation when qpi.h bodies exceed expression subset.
    private parseFunctionBody(): Statement {
        const toks = (this.lex as any).tokens as Token[];
        const openIdx = (this.lex as any).index;
        let depth = 0;
        let closeIdx = -1;
        for (let tokIndex = openIdx; tokIndex < toks.length; tokIndex++) {
            const kind = toks[tokIndex].kind;
            if (kind === "l_brace") {
                depth++;
            }
            else if (kind === "r_brace") {
                depth--;
                if (depth === 0) {
                    closeIdx = tokIndex;
                    break;
                }
            }
            else if (kind === "eof") {
                break;
            }
        }
        if (closeIdx < 0) {
            this.next(); // unbalanced — best-effort inline parse
            return this.parseCompoundStatement();
        }
        const slice = toks.slice(openIdx, closeIdx + 1);
        slice.push({ kind: "eof", text: "", span: toks[closeIdx].span });
        const sub = new Parser(slice);
        sub.next(); // consume `{`
        const body = sub.parseCompoundStatement();
        for (const diagnostic of sub.diagnostics)
            this.bodyDiagnostics.push(diagnostic);
        for (const bodyDiagnostic of sub.bodyDiagnostics)
            this.bodyDiagnostics.push(bodyDiagnostic);
        (this.lex as any).index = closeIdx + 1; // resume after the matched `}`
        return body;
    }
    // ---- Token helpers ----
    private peek(offset: number = 0): Token {
        return this.lex.peek(offset);
    }
    private next(): Token {
        const tok = this.lex.next();
        this._last = tok;
        return tok;
    }
    private last(): Token {
        return this._last ?? this.peek();
    }
    private eof(): boolean {
        return this.peek().kind === "eof";
    }
    private expect(kind: TokenKind, context: string): Token | null {
        const tok = this.peek();
        if (tok.kind === kind) {
            return this.next();
        }
        this.diagnostics.push({
            severity: "error",
            message: `Expected ${kind} but got ${tok.kind} (${tok.text}) in ${context}`,
            span: tok.span,
        });
        return null;
    }
    private tryConsume(kind: TokenKind): Token | null {
        if (this.peek().kind === kind) {
            return this.next();
        }
        return null;
    }
    private tryConsumeKw(kw: string): Token | null {
        const tok = this.peek();
        if (tok.text === kw) {
            return this.next();
        }
        return null;
    }
    // Close a template angle. C++ lexes `>>` (and `>=`) as one token; when it closes nested template
    private consumeAngleClose(): void {
        const tok = this.peek();
        const idx = (this.lex as any).index;
        const toks = (this.lex as any).tokens as Token[];
        if (tok.kind === "r_angle") {
            this.next();
            return;
        }
        if (tok.kind === "r_shift") {
            toks[idx] = { kind: "r_angle", text: ">", span: tok.span };
            this._last = tok;
            return; // consumed one '>', the remaining '>' stays as the current token
        }
        if (tok.kind === "gt_eq") {
            toks[idx] = { kind: "eq", text: "=", span: tok.span };
            this._last = tok;
            return;
        }
        this.expect("r_angle", "template close");
    }
    // ---- Declarations ----
    private parseDeclaration(): Declaration | null {
        return parserPart0.parseDeclaration(this as unknown as ParserInternals);
    }
    private parseNamespace(): NamespaceDecl {
        return parserPart1.parseNamespace(this as unknown as ParserInternals);
    }
    private parseStruct(): StructDecl {
        return parserPart1.parseStruct(this as unknown as ParserInternals);
    }
    // True when a variable declarator (not `;`) follows a record body: an identifier, `*`, `&`, or `[`.
    private declaratorFollows(): boolean {
        return parserPart1.declaratorFollows(this as unknown as ParserInternals);
    }
    // Parse the `<...>` of a (partial) class specialization head — `struct Foo<ProposalDataYesNo, numOfVotes>`.
    private parseSpecializationArgs(): TypeSpec[] {
        return parserPart1.parseSpecializationArgs(this as unknown as ParserInternals);
    }
    private parseUnion(): StructDecl {
        return parserPart1.parseUnion(this as unknown as ParserInternals);
    }
    private parseClassOrTemplate(): StructDecl | ClassTemplateDecl {
        return parserPart1.parseClassOrTemplate(this as unknown as ParserInternals);
    }
    private parseTemplateDeclaration(): Declaration {
        return parserPart2.parseTemplateDeclaration(this as unknown as ParserInternals);
    }
    private parseTemplateParams(): TemplateParam[] {
        return parserPart2.parseTemplateParams(this as unknown as ParserInternals);
    }
    private parseFunctionTemplate(params: TemplateParam[]): FunctionTemplateDecl {
        return parserPart2.parseFunctionTemplate(this as unknown as ParserInternals, params);
    }
    private parseEnum(): EnumDecl {
        return parserPart3.parseEnum(this as unknown as ParserInternals);
    }
    private parseEnumeratorList(): EnumeratorDecl[] {
        return parserPart3.parseEnumeratorList(this as unknown as ParserInternals);
    }
    private parseTypedef(): TypedefDeclNode {
        return parserPart3.parseTypedef(this as unknown as ParserInternals);
    }
    private parseUsing(): Declaration {
        return parserPart3.parseUsing(this as unknown as ParserInternals);
    }
    private parseStaticAssertDecl(): StaticAssertDecl {
        return parserPart3.parseStaticAssertDecl(this as unknown as ParserInternals);
    }
    private parseExternBlock(): ExternBlockDecl | FunctionDecl {
        return parserPart3.parseExternBlock(this as unknown as ParserInternals);
    }
    private parseFriend(): FriendDecl {
        return parserPart3.parseFriend(this as unknown as ParserInternals);
    }
    private parseAccessSpec(): EmptyDecl {
        return parserPart3.parseAccessSpec(this as unknown as ParserInternals);
    }
    // ---- Functions and variables ----
    private parseFunctionOrVariable(): Declaration {
        return parserPart4.parseFunctionOrVariable(this as unknown as ParserInternals);
    }
    private parseFunctionOrVariablePeekType(): Declaration {
        return parserPart4.parseFunctionOrVariablePeekType(this as unknown as ParserInternals);
    }
    private parseIdentifierDeclaration(): Declaration {
        return parserPart4.parseIdentifierDeclaration(this as unknown as ParserInternals);
    }
    private parseAfterModifiers(isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExtern: boolean): Declaration {
        return parserPart4.parseAfterModifiers(this as unknown as ParserInternals, isConstexpr, isStatic, isInline, isVirtual, isExtern);
    }
    // After a `name`, peek past `(` to decide function-declaration vs constructor-style direct-init: a function parameter list opens with
    private looksLikeDirectInit(): boolean {
        return parserPart4.looksLikeDirectInit(this as unknown as ParserInternals);
    }
    private parseDirectInitVar(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): VariableDecl {
        return parserPart4.parseDirectInitVar(this as unknown as ParserInternals, name, type, isConstexpr, isStatic);
    }
    private parseFunctionAfterReturnType(retType: TypeSpec, isExternC: boolean): FunctionDecl {
        return parserPart4.parseFunctionAfterReturnType(this as unknown as ParserInternals, retType, isExternC);
    }
    private parseFunctionRest(name: string, retType: TypeSpec, isConstexpr: boolean, isStatic: boolean, isInline: boolean, isVirtual: boolean, isExternC: boolean): FunctionDecl {
        return parserPart4.parseFunctionRest(this as unknown as ParserInternals, name, retType, isConstexpr, isStatic, isInline, isVirtual, isExternC);
    }
    private parseVariableRest(name: string, type: TypeSpec, isConstexpr: boolean, isStatic: boolean): Declaration {
        return parserPart4.parseVariableRest(this as unknown as ParserInternals, name, type, isConstexpr, isStatic);
    }
    // Parse one or more declarators sharing a base type: `name[dim]...`, `name = init`, `, name2, ...`, terminated by
    private parseDeclaratorList(baseType: TypeSpec, firstName: string, isConstexpr: boolean, isStatic: boolean): VariableDecl[] {
        return parserPart4.parseDeclaratorList(this as unknown as ParserInternals, baseType, firstName, isConstexpr, isStatic);
    }
    private parseFunctionParams(): ParamDecl[] {
        return parserPart4.parseFunctionParams(this as unknown as ParserInternals);
    }
    // ---- Type parsing ----
    private parseTypeSpec(): TypeSpec {
        return parserPart5.parseTypeSpec(this as unknown as ParserInternals);
    }
    private parseBaseType(): TypeSpec {
        return parserPart5.parseBaseType(this as unknown as ParserInternals);
    }
    // A template argument that begins with a (qualified) identifier followed by an arithmetic operator and another operand is
    private templateArgIsExpr(): boolean {
        return parserPart5.templateArgIsExpr(this as unknown as ParserInternals);
    }
    private parseBuiltinType(): TypeSpec {
        return parserPart5.parseBuiltinType(this as unknown as ParserInternals);
    }
    private parseAccessAndType(): TypeSpec {
        return parserPart5.parseAccessAndType(this as unknown as ParserInternals);
    }
    // ---- Expressions ----
    private parseExpression(): Expression {
        return parserPart7.parseExpression(this as unknown as ParserInternals);
    }
    private parseAssignment(): Expression {
        return parserPart7.parseAssignment(this as unknown as ParserInternals);
    }
    private parseTernary(): Expression {
        return parserPart7.parseTernary(this as unknown as ParserInternals);
    }
    private parseLogicalOr(): Expression {
        return parserPart7.parseLogicalOr(this as unknown as ParserInternals);
    }
    private parseLogicalAnd(): Expression {
        return parserPart7.parseLogicalAnd(this as unknown as ParserInternals);
    }
    private parseBitwiseOr(): Expression {
        return parserPart7.parseBitwiseOr(this as unknown as ParserInternals);
    }
    private parseBitwiseXor(): Expression {
        return parserPart7.parseBitwiseXor(this as unknown as ParserInternals);
    }
    private parseBitwiseAnd(): Expression {
        return parserPart7.parseBitwiseAnd(this as unknown as ParserInternals);
    }
    private parseEquality(): Expression {
        return parserPart7.parseEquality(this as unknown as ParserInternals);
    }
    private parseComparison(): Expression {
        return parserPart7.parseComparison(this as unknown as ParserInternals);
    }
    private parseShift(): Expression {
        return parserPart7.parseShift(this as unknown as ParserInternals);
    }
    private parseAdditive(): Expression {
        return parserPart7.parseAdditive(this as unknown as ParserInternals);
    }
    private parseMultiplicative(): Expression {
        return parserPart7.parseMultiplicative(this as unknown as ParserInternals);
    }
    private parseUnary(): Expression {
        return parserPart8.parseUnary(this as unknown as ParserInternals);
    }
    private parsePostfix(): Expression {
        return parserPart8.parsePostfix(this as unknown as ParserInternals);
    }
    // Disambiguate `<` as template-args vs comparison: scan from the `<` for a matching `>` that is immediately followed
    private looksLikeTemplateArgs(): boolean {
        return parserPart8.looksLikeTemplateArgs(this as unknown as ParserInternals);
    }
    // A single brace-init element: a nested `{ ... }` becomes an initializer_list, otherwise an expression.
    private parseBraceArg(): Expression {
        return parserPart8.parseBraceArg(this as unknown as ParserInternals);
    }
    private parsePrimaryExpression(): Expression {
        return parserPart9.parsePrimaryExpression(this as unknown as ParserInternals);
    }
    private parseQualifiedName(stopAtAngle = false): string {
        return parserPart6.parseQualifiedName(this as unknown as ParserInternals, stopAtAngle);
    }
    private parseMaybeQualifiedName(): string {
        return parserPart6.parseMaybeQualifiedName(this as unknown as ParserInternals);
    }
    // Parse a comma-operator sequence (`i++, flags >>= 2`) into one expression. Used where a comma joins
    private parseCommaSequence(): Expression {
        return parserPart9.parseCommaSequence(this as unknown as ParserInternals);
    }
    // A local variable declaration at statement start is `Type var`/`Type* var`, not a keyword usage.
    private looksLikeLocalDecl(): boolean {
        return parserPart9.looksLikeLocalDecl(this as unknown as ParserInternals);
    }
    // Consume a balanced <...> template-argument group (handling nested <> and >>). Returns true if it
    private skipAngleArgs(): boolean {
        return parserPart6.skipAngleArgs(this as unknown as ParserInternals);
    }
    // Decide whether `( ... )` begins a C-style cast vs a parenthesized expression. Only a *pure type*
    private isTypeCast(): boolean {
        return parserPart6.isTypeCast(this as unknown as ParserInternals);
    }
    private parseCast(): Expression {
        return parserPart6.parseCast(this as unknown as ParserInternals);
    }
    private parseSizeof(): Expression {
        return parserPart6.parseSizeof(this as unknown as ParserInternals);
    }
    private parseArgList(): Expression[] {
        return parserPart9.parseArgList(this as unknown as ParserInternals);
    }
    // ---- Statements ----
    private parseStatement(): Statement {
        return parserPart10.parseStatement(this as unknown as ParserInternals);
    }
    private parseCompoundStatement(): Statement {
        return parserPart10.parseCompoundStatement(this as unknown as ParserInternals);
    }
    private parseIf(): Statement {
        return parserPart10.parseIf(this as unknown as ParserInternals);
    }
    private parseFor(): Statement {
        return parserPart10.parseFor(this as unknown as ParserInternals);
    }
    private parseWhile(): Statement {
        return parserPart10.parseWhile(this as unknown as ParserInternals);
    }
    private parseDoWhile(): Statement {
        return parserPart10.parseDoWhile(this as unknown as ParserInternals);
    }
    private parseSwitch(): Statement {
        return parserPart10.parseSwitch(this as unknown as ParserInternals);
    }
    private parseCase(): Statement {
        return parserPart10.parseCase(this as unknown as ParserInternals);
    }
    private parseDefault(): Statement {
        return parserPart10.parseDefault(this as unknown as ParserInternals);
    }
    private parseReturn(): Statement {
        return parserPart10.parseReturn(this as unknown as ParserInternals);
    }
    // ---- Preprocessor line (leftover #-directive in preprocessed source) ----
    private parsePreprocessorLine(): Declaration {
        return parserPart0.parsePreprocessorLine(this as unknown as ParserInternals);
    }
    // ---- Helpers ----
    // Assumes the current token is the opening delimiter; consumes through the matching close (inclusive). Safe no-op if the
    private skipBalanced(open: TokenKind, close: TokenKind): void {
        return parserPart11.skipBalanced(this as unknown as ParserInternals, open, close);
    }
    private parseDeclarationList(): Declaration[] {
        return parserPart0.parseDeclarationList(this as unknown as ParserInternals);
    }
    private parseClassMembers(): Declaration[] {
        return parserPart0.parseClassMembers(this as unknown as ParserInternals);
    }
    // Panic recovery for declaration failures.
    private recover(beforeIndex: number, errsBefore: number): void {
        return parserPart11.recover(this as unknown as ParserInternals, beforeIndex, errsBefore);
    }
    private parseCharValue(text: string): number {
        return parserPart11.parseCharValue(this as unknown as ParserInternals, text);
    }
    private _last: Token | null = null;
    private makeSpan(start: Span): Span {
        return parserPart11.makeSpan(this as unknown as ParserInternals, start);
    }
    // --- IDL extraction ---- Extract contract IDL from parsed AST (input/output types per registered entry)
    extractIdl(translationUnit: TranslationUnit): Record<string, {
        inputType: number;
        kind: number;
        inSize: number;
        outSize: number;
    }> {
        return parserPart12.extractIdl(this as unknown as ParserInternals, translationUnit);
    }
    private extractIdlFromNode(node: Declaration, idl: Record<string, any>): void {
        return parserPart12.extractIdlFromNode(this as unknown as ParserInternals, node, idl);
    }
    private extractIdlFromStmt(statement: Statement, idl: Record<string, any>): void {
        return parserPart12.extractIdlFromStmt(this as unknown as ParserInternals, statement, idl);
    }
    private checkRegistrationCall(call: any, idl: Record<string, any>): void {
        return parserPart12.checkRegistrationCall(this as unknown as ParserInternals, call, idl);
    }
}
