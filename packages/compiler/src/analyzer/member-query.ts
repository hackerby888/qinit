// Member completion for editors: the members of the type left of the cursor's `.`/`->`.
// Covers a clangd bug (17-22) that returns an empty list through a preamble type holding a template member.
import type { Declaration, Expression, FunctionDecl, Statement, StructDecl, TypeSpec } from "../ast";
import { AstKind, MemberCompletionKind } from "../shared/enums";
import { Lexer } from "../frontend/lexer";
import { Parser } from "../frontend/parser";
import { parseContractSource, preprocessContractSource } from "../driver/contract-frontend";
import { collectCalleeContext } from "../driver/callees";
import { getQpiContext, type QpiContext } from "../driver/qpi-context";
import { getQpiMacros } from "../driver/qpi-macros";
import type { CompileOptions } from "../driver/types";
import { QPI_SNAPSHOT } from "../generated/qpi-snapshot";
import { ProgramAnalysis } from "../semantics";
import { SemanticAnalyzer } from "../semantics/semantic-analysis";
import { EMPTY_TEMPLATE_BINDINGS, type TemplateBindings } from "../semantics/types";
import { findContractStruct } from "../backend/wasm/module/contract-discovery";
import { isStateAccessor, stripPtrRefConst } from "../backend/wasm/memory/address-resolution";
import { registerLibraryMetadata } from "../backend/wasm/module/library-index";
import { detectQpiContractName } from "./source-policy";
import type { AnalyzeContractOptions } from "./index";

/** The nested struct name QPI reserves for contract state, the same one codegen resolves against. */
const STATE_STRUCT = "StateData";

export type MemberQueryOptions = Omit<AnalyzeContractOptions, "source"> & {
    source: string;
    /** UTF-16 offset into `source`, at or just past the member operator being completed. */
    offset: number;
};

// A gtest is general C++, so its receiver is not resolved from a contract AST. The caller supplies the
// root's type as text — from the language server, which resolves that correctly — and the field hops
// after it are QPI types this compiler already knows.
export type TypeMemberQueryOptions = Omit<AnalyzeContractOptions, "source"> & {
    /** The root's declared type as spelled, e.g. `QUOTTERY::CreateEvent_input`. */
    rootTypeText: string;
    /** Plain-identifier field hops between the root and the cursor. */
    path: string[];
};

export interface MemberCompletion {
    name: string;
    kind: MemberCompletionKind;
    /** Rendered declared type for a field, or return type for a method. */
    typeText?: string;
    /** One entry per parameter, e.g. `uint64 index`. */
    parameters: string[];
}

// A resolved receiver. Plain structs carry their members directly; a template instance carries the
// primary template's members plus the separately indexed inline methods, both under one binding set.
interface Target {
    members: Declaration[];
    methods: Map<string, Declaration>;
    bindings: TemplateBindings;
    /** Type name, so its constructor is not offered as a member. */
    typeName?: string;
    /** Template parameter → the argument as the author spelled it, for rendering only. */
    spelled?: Map<string, TypeSpec>;
    /** Enclosing contract qualifier, so a member spelled `QtryEventInfo` finds `QUOTTERY::QtryEventInfo`. */
    scope?: string;
}

// Render the type as spelled, substituting template parameters so `KeyT` reads as `id`. The compiler's
// bindings hold resolved types, so going through them would print `m256i` instead of the QPI names.
function describeType(type: TypeSpec | undefined, spelled: Map<string, TypeSpec> | undefined, depth = 0): string | undefined {
    if (!type || depth > 12) return undefined;
    const nested = (inner: TypeSpec | undefined) => describeType(inner, spelled, depth + 1) ?? "?";
    switch (type.kind) {
        case AstKind.NAME: {
            const bound = spelled?.get(type.name);
            return bound ? nested(bound) : type.name;
        }
        case AstKind.TEMPLATE_INSTANCE:
            return `${type.name}<${type.callArguments.map(nested).join(", ")}>`;
        case AstKind.CONST:
            return `const ${nested(type.valueType)}`;
        case AstKind.POINTER:
            return `${nested(type.pointee)}*`;
        case AstKind.REFERENCE:
            return `${nested(type.referentType)}&`;
        case AstKind.ARRAY:
            return `${nested(type.element)}[]`;
        case AstKind.INLINE_STRUCT:
            return type.struct.name;
        case AstKind.EXPR_VALUE:
            return type.expression.kind === AstKind.INT_LITERAL ? type.expression.value : undefined;
        default:
            return undefined;
    }
}

// Completion is asked at the member operator, so the receiver ends just before it.
function receiverEndOf(source: string, offset: number): number | undefined {
    let index = Math.min(Math.max(offset, 0), source.length);
    while (index > 0 && /[A-Za-z0-9_]/.test(source[index - 1]!)) index--;
    while (index > 0 && /[ \t]/.test(source[index - 1]!)) index--;
    if (source.slice(index - 2, index) === "->") return index - 2;
    if (source[index - 1] === ".") return index - 1;
    return undefined;
}

// Where the receiver begins, over a balanced call/subscript tail so `state.mut().q` survives whole.
// Textual because every node on a line shares the statement's span — the tree cannot locate the cursor.
function receiverStartOf(source: string, receiverEnd: number): number {
    let index = receiverEnd;
    let depth = 0;
    while (index > 0) {
        const character = source[index - 1]!;
        if (character === ")" || character === "]") depth++;
        else if (character === "(" || character === "[") {
            if (depth === 0) break;
            depth--;
        } else if (depth === 0 && !/[A-Za-z0-9_.:>\-]/.test(character)) break;
        index--;
    }
    return index;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Cut the receiver on its member operators at depth zero, so `f(a.b)` and `arr[i.j]` stay one segment.
function splitSegments(text: string): string[] {
    const segments: string[] = [];
    let depth = 0;
    let start = 0;
    for (let index = 0; index < text.length; index++) {
        const character = text[index]!;
        if (character === "(" || character === "[") depth++;
        else if (character === ")" || character === "]") depth--;
        else if (depth === 0 && (character === "." || (character === "-" && text[index + 1] === ">"))) {
            segments.push(text.slice(start, index));
            if (character === "-") index++;
            start = index + 1;
        }
    }
    segments.push(text.slice(start));
    return segments;
}

/**
 * Split the receiver at the cursor into its root and the plain-identifier hops after it.
 * Undefined when there is no member operator, or when a hop carries a call or subscript.
 */
export function splitReceiver(source: string, offset: number): { rootText: string; rootOffset: number; path: string[] } | undefined {
    const receiverEnd = receiverEndOf(source, offset);
    if (receiverEnd === undefined) return undefined;

    const receiverStart = receiverStartOf(source, receiverEnd);
    const text = source.slice(receiverStart, receiverEnd).replace(/\n/g, " ");
    const segments = splitSegments(text).map((segment) => segment.trim());
    const rootText = segments[0] ?? "";
    const path = segments.slice(1);
    if (rootText === "" || path.some((segment) => !IDENTIFIER.test(segment))) return undefined;

    return { rootText, rootOffset: receiverStart + text.length - text.trimStart().length, path };
}

/**
 * The declared type of `name`, read from its nearest declaration before `before`.
 * A language server drops the whole statement while it is being typed, so the root's type has to be
 * recoverable from the text alone. Undefined when no declaration of that name precedes the cursor.
 */
export function declaredTypeOf(source: string, before: number, name: string): string | undefined {
    if (!IDENTIFIER.test(name)) return undefined;
    // From a statement, parameter or line boundary, over a type that may be qualified, templated or a
    // reference. Line starts count because the statement above is often the half-typed one.
    const declaration = new RegExp(`(?:^|[;{}(),])\\s*((?:const\\s+)?[A-Za-z_]\\w*(?:::\\w+)*\\s*(?:<[^;{}()]*>)?\\s*[&*]?)\\s+${name}\\s*(?=[;=,)[(])`, "gm");

    const text = source.slice(0, before);
    let declared: string | undefined;
    for (let match = declaration.exec(text); match; match = declaration.exec(text)) declared = match[1];
    return declared?.trim().replace(/\s+/g, " ");
}

function lineNumberAt(source: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index++) if (source[index] === "\n") line++;
    return line;
}

function isFunction(declaration: Declaration): declaration is FunctionDecl {
    return declaration.kind === AstKind.FUNCTION;
}

// The probe statement is alone on its line, so the line identifies it where collapsed spans cannot.
// Nested kinds mirror `walkStatements`: a contract body is mostly branches and loops.
function statementOnLine(statement: Statement, line: number): Expression | undefined {
    if (statement.kind === AstKind.EXPRESSION) return statement.span.line === line ? statement.expression : undefined;
    const nested: Array<Statement | undefined> = [];
    switch (statement.kind) {
        case AstKind.COMPOUND:
            nested.push(...statement.body);
            break;
        case AstKind.IF:
            nested.push(statement.then, statement.else_);
            break;
        case AstKind.FOR:
            nested.push(statement.initializer, statement.body);
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            nested.push(statement.body);
            break;
    }
    for (const child of nested) {
        const found = child && statementOnLine(child, line);
        if (found) return found;
    }
    return undefined;
}

function memberNamed(target: Target, name: string): Declaration | undefined {
    return target.members.find((member) => (member as { name?: string }).name === name) ?? target.methods.get(name);
}

function parametersOf(declaration: Declaration): Array<{ name?: string; type: TypeSpec }> {
    const candidate = declaration as { functionParameters?: Array<{ name?: string; type: TypeSpec }>; params?: Array<{ name?: string; type: TypeSpec }> };
    return candidate.functionParameters ?? candidate.params ?? [];
}

function returnTypeOf(declaration: Declaration): TypeSpec | undefined {
    return (declaration as { returnType?: TypeSpec }).returnType;
}

function structTarget(programAnalysis: ProgramAnalysis, structDeclaration: StructDecl, bindings: TemplateBindings, scope?: string): Target {
    return {
        members: structDeclaration.members ?? [],
        methods: programAnalysis.templateMethods.get(structDeclaration.name) ?? new Map(),
        bindings,
        typeName: structDeclaration.name,
        scope,
    };
}

// A callee's structs are registered qualified (`QUOTTERY::QtryEventInfo`) but spelled bare inside the
// contract, so an unqualified miss is retried under the enclosing contract's name.
function structInScope(programAnalysis: ProgramAnalysis, type: TypeSpec, bindings: TemplateBindings, scope?: string): StructDecl | null {
    const direct = programAnalysis.structOf(type, bindings);
    if (direct || !scope || type.kind !== AstKind.NAME || type.name.includes("::")) return direct;
    return programAnalysis.structOf({ ...type, name: `${scope}::${type.name}` }, bindings);
}

// `structOf` returns null for a template instance, so an instantiation is the only way to reach
// HashMap/Array/Collection members — the case the clangd bug returns empty for.
function targetOfType(programAnalysis: ProgramAnalysis, type: TypeSpec | undefined, bindings: TemplateBindings, scope?: string): Target | undefined {
    if (!type) return undefined;
    let resolved: TypeSpec;
    try {
        resolved = programAnalysis.resolveType(stripPtrRefConst(type), bindings);
    } catch {
        return undefined;
    }
    if (resolved.kind === AstKind.TEMPLATE_INSTANCE) {
        const instance = programAnalysis.instantiateTemplate(resolved.name, resolved.callArguments, bindings);
        if (!instance) return undefined;
        const spelled = new Map<string, TypeSpec>();
        instance.templateDeclaration.params.forEach((parameter, index) => {
            const argument = resolved.kind === AstKind.TEMPLATE_INSTANCE ? resolved.callArguments[index] : undefined;
            if (argument) spelled.set(parameter.name, argument);
        });
        return {
            members: instance.templateDeclaration.members ?? [],
            methods: programAnalysis.templateMethods.get(resolved.name) ?? new Map(),
            bindings: instance.b,
            typeName: resolved.name,
            spelled,
            scope,
        };
    }
    const structDeclaration = structInScope(programAnalysis, resolved, bindings, scope);
    return structDeclaration ? structTarget(programAnalysis, structDeclaration, bindings, scope) : undefined;
}

// One field hop: the member's declared type, or a method's return type, resolved as a new receiver.
function hopTo(programAnalysis: ProgramAnalysis, parent: Target, name: string): Target | undefined {
    const member = memberNamed(parent, name);
    if (!member) return undefined;
    const type = isFunction(member) || member.kind === AstKind.FUNCTION_TEMPLATE ? returnTypeOf(member) : (member as { type?: TypeSpec }).type;
    return targetOfType(programAnalysis, type, parent.bindings, parent.scope);
}

function resolveReceiver(programAnalysis: ProgramAnalysis, expression: Expression, enclosing: FunctionDecl, depth = 0): Target | undefined {
    if (depth > 24) return undefined;
    if (isStateAccessor(expression)) {
        const state = programAnalysis.nested.get(STATE_STRUCT);
        return state ? structTarget(programAnalysis, state, EMPTY_TEMPLATE_BINDINGS) : undefined;
    }
    switch (expression.kind) {
        case AstKind.PAREN:
            return resolveReceiver(programAnalysis, expression.expression, enclosing, depth + 1);
        case AstKind.IDENTIFIER: {
            const parameter = enclosing.params.find((candidate) => candidate.name === expression.name);
            return targetOfType(programAnalysis, parameter?.type, EMPTY_TEMPLATE_BINDINGS);
        }
        case AstKind.MEMBER_ACCESS: {
            const parent = resolveReceiver(programAnalysis, expression.object, enclosing, depth + 1);
            return parent && hopTo(programAnalysis, parent, expression.member);
        }
        case AstKind.CALL:
            return resolveReceiver(programAnalysis, expression.callee, enclosing, depth + 1);
        default:
            return undefined;
    }
}

function completionsOf(target: Target): MemberCompletion[] {
    const completions: MemberCompletion[] = [];
    const seen = new Set<string>();
    const push = (declaration: Declaration, name: string): void => {
        if (seen.has(name) || name === target.typeName || name.startsWith("operator")) return;
        seen.add(name);
        completions.push({
            name,
            kind: MemberCompletionKind.METHOD,
            typeText: describeType(returnTypeOf(declaration), target.spelled),
            parameters: parametersOf(declaration).map((parameter) => `${describeType(parameter.type, target.spelled) ?? "?"} ${parameter.name ?? ""}`.trim()),
        });
    };

    for (const member of target.members) {
        if (member.kind === AstKind.FUNCTION || member.kind === AstKind.FUNCTION_TEMPLATE) {
            push(member, member.name);
        } else if (member.kind !== AstKind.STRUCT && (member as { name?: string }).name) {
            const name = (member as { name: string }).name;
            if (seen.has(name)) continue;
            seen.add(name);
            completions.push({
                name,
                kind: MemberCompletionKind.FIELD,
                typeText: describeType((member as { type?: TypeSpec }).type, target.spelled),
                parameters: [],
            });
        }
    }
    // templateMethods keys a method under `name`, `name/arity` and `name/arity@type`; the bare name is the one.
    for (const [key, definition] of target.methods) {
        if (!key.includes("/")) push(definition, key);
    }
    return completions;
}

// The QPI library plus every callee's structs. `own` is the queried document's own declarations, which
// a gtest does not have — it reaches the contract's types under their qualified names instead.
function queryProgramAnalysis(compileOptions: CompileOptions, qpiContext: QpiContext, own?: Declaration[]): ProgramAnalysis {
    const programAnalysis = new ProgramAnalysis(new SemanticAnalyzer());
    registerLibraryMetadata(programAnalysis, qpiContext.lib);
    const callees = collectCalleeContext(compileOptions, qpiContext);
    for (const [name, declaration] of callees.contractStructs) programAnalysis.globalStructs.set(name, declaration);
    if (own) programAnalysis.registerTopLevelDeclarations(own);
    for (const callee of callees.calleeTranslationUnits) {
        programAnalysis.registerCalleeContractDeclarations(callee.contractName, callee.declarations);
    }
    // Same normalization codegen runs, so the language server resolves a namespace's names the way it does.
    if (own) {
        programAnalysis.qualifyDeclarationsInScope(own);
        programAnalysis.layoutCache.clear();
    }
    return programAnalysis;
}

// Turn a spelled type back into a TypeSpec by parsing it as a field declaration, the one context where
// every form a language server prints — `const X&`, `Array<uint64, 8>`, `A::B` — is valid on its own.
function parseTypeText(text: string): TypeSpec | undefined {
    const declared = text.replace(/\bQPI::/g, "").trim();
    if (declared === "") return undefined;
    const unit = new Parser(new Lexer(`struct __QpiProbe { ${declared} __x; };`).tokenize()).parseTranslationUnit();
    const probe = unit.declarations.find((declaration) => declaration.kind === AstKind.STRUCT) as StructDecl | undefined;
    return (probe?.members?.[0] as { type?: TypeSpec } | undefined)?.type;
}

// The contract a qualified type belongs to, under which its sibling structs are registered.
function scopeOf(type: TypeSpec): string | undefined {
    const bare = stripPtrRefConst(type);
    if (bare.kind !== AstKind.NAME && bare.kind !== AstKind.TEMPLATE_INSTANCE) return undefined;
    const separator = bare.name.lastIndexOf("::");
    return separator > 0 ? bare.name.slice(0, separator) : undefined;
}

function membersOfPath(programAnalysis: ProgramAnalysis, root: Target, path: string[]): MemberCompletion[] | undefined {
    let target: Target | undefined = root;
    for (const name of path) {
        target = target && hopTo(programAnalysis, target, name);
    }
    if (!target) return undefined;
    const completions = completionsOf(target);
    return completions.length > 0 ? completions : undefined;
}

/** Members reached by walking `path` from a root of the given type; undefined when nothing resolves. */
export function completeMembersOfType(options: TypeMemberQueryOptions): MemberCompletion[] | undefined {
    const qpiHeader = options.qpiHeader ?? QPI_SNAPSHOT;
    const compileOptions: CompileOptions = {
        source: "",
        contractName: options.contractName ?? "Contract",
        slot: options.slot ?? 0,
        qpiHeader,
        callees: options.callees,
        calleeSources: options.calleeSources,
    };

    try {
        const programAnalysis = queryProgramAnalysis(compileOptions, getQpiContext(qpiHeader));
        const type = parseTypeText(options.rootTypeText);
        if (!type) return undefined;
        const root = targetOfType(programAnalysis, type, EMPTY_TEMPLATE_BINDINGS, scopeOf(type));
        return root && membersOfPath(programAnalysis, root, options.path);
    } catch {
        return undefined;
    }
}

/** Members of the type left of the cursor's member operator; undefined when nothing resolves. */
export function completeMembersAt(options: MemberQueryOptions): MemberCompletion[] | undefined {
    const receiverEnd = receiverEndOf(options.source, options.offset);
    if (receiverEnd === undefined) return undefined;

    // Replace the receiver's line with the receiver alone, so it parses as a statement of its own
    // whatever it was nested in. Inner newlines become spaces to keep every later line's number.
    const receiverStart = receiverStartOf(options.source, receiverEnd);
    const lineStart = options.source.lastIndexOf("\n", receiverStart) + 1;
    const lineEnd = options.source.indexOf("\n", receiverEnd);
    const receiverText = options.source.slice(receiverStart, receiverEnd).replace(/\n/g, " ");
    if (receiverText.trim() === "") return undefined;
    const probeSource = `${options.source.slice(0, lineStart)}${receiverText};${lineEnd < 0 ? "" : options.source.slice(lineEnd)}`;
    const qpiHeader = options.qpiHeader ?? QPI_SNAPSHOT;
    const compileOptions: CompileOptions = {
        source: probeSource,
        contractName: options.contractName ?? detectQpiContractName(options.source) ?? "Contract",
        slot: options.slot ?? 0,
        qpiHeader,
        callees: options.callees,
        calleeSources: options.calleeSources,
    };

    try {
        const qpiContext = getQpiContext(qpiHeader);
        const preprocessed = preprocessContractSource(compileOptions, getQpiMacros(qpiHeader));
        // Mid-edit source is expected to be invalid; the parser's recovery stands in for a clean parse.
        const unit = parseContractSource(preprocessed, []);
        const contract = findContractStruct(unit);
        if (!contract) return undefined;

        const programAnalysis = queryProgramAnalysis(compileOptions, qpiContext, unit.declarations);
        programAnalysis.collectNested(contract);

        const probeLine = lineNumberAt(options.source, receiverStart) + preprocessed.userBoundaryLine;
        for (const member of contract.members) {
            if (!isFunction(member) || !member.body) continue;
            const receiver = statementOnLine(member.body, probeLine);
            if (!receiver) continue;
            const target = resolveReceiver(programAnalysis, receiver, member);
            if (!target) return undefined;
            const completions = completionsOf(target);
            return completions.length > 0 ? completions : undefined;
        }
    } catch {
        return undefined;
    }
    return undefined;
}
