import { BinaryOp, DiagnosticSeverity, QpiMacroKind, TokenKind } from "../shared/enums";
import { AbiTypeKind, type AbiType, type ContractIdl } from "@qinit/proto/contract-idl";
import type { ContractRegistration } from "../backend/wasm/module/registrations";
import { Lexer, type Token } from "../frontend/lexer";
import type { SourceAnalysisDiagnostic, SourceFix } from "./index";
import { USER_FUNCTION_KIND } from "../shared/entry-abi";
import { DEFAULT_CALL_ERROR_VAR, type SourceContractCall } from "../driver/semantic-calls";
import { TYPE_KINDS, findEntryFunctions, findLocalDeclarations, findNext, isUsingNamespaceQpi, matchingToken, type EntryFunction } from "./rules/tokens";
import { arrayFix, compareDiagnostics, diagnostic, divModFix, moveLocalToWithLocalsEdits, sourceFix } from "./rules/fixes";
import { analyzeCheatcodes, cheatArgumentRanges } from "./cheatcodes";

const KEYWORD_RULES: Record<string, { code: string; message: string }> = {
    float: {
        code: "qpi/no-float",
        message: "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
    },
    double: {
        code: "qpi/no-float",
        message: "Floating-point types (`float`/`double`) are forbidden — their arithmetic isn't deterministic.",
    },
    union: {
        code: "qpi/no-union",
        message: "`union` is forbidden in QPI (it obscures code audits).",
    },
    const_cast: {
        code: "qpi/no-const-cast",
        message: "`const_cast` is forbidden in QPI.",
    },
    QpiContext: {
        code: "qpi/no-qpicontext",
        message: "`QpiContext` may not be used directly in a contract.",
    },
};

// Names a contract may not write, for callers that suppress rather than diagnose them.
export const QPI_BANNED_KEYWORDS: readonly string[] = Object.keys(KEYWORD_RULES);

// QPI math helpers a user contract must namespace: with `using namespace QPI`, MSVC's C runtime declares a global `div` that beats `QPI::div<T>` on Windows.
const UNQUALIFIED_MATH: Record<string, { code: string; message: string }> = {
    div: {
        code: "qpi/unqualified-div",
        message:
            "`div(…)` is unqualified — write `QPI::div(…)`. With `using namespace QPI`, MSVC's C runtime declares a global " +
            "`lldiv_t div(long long, long long)` that beats `QPI::div<T>` on signed operands, so Core's Windows build rejects the contract (C2440).",
    },
    mod: {
        code: "qpi/unqualified-mod",
        message: "`mod(…)` is unqualified — write `QPI::mod(…)` (QPI math helpers are spelled with their namespace so they never bind to a C-runtime overload).",
    },
};

// Rule codes that apply to user contracts only; core's own contracts are exempt (they are built by Qinit too).
export const USER_CONTRACT_RULES: ReadonlySet<string> = new Set(Object.values(UNQUALIFIED_MATH).map((rule) => rule.code));

const MEMBER_ACCESS_KINDS = new Set<TokenKind>([TokenKind.D_COLON, TokenKind.DOT, TokenKind.ARROW]);
const DECLARATOR_KINDS = new Set<TokenKind>([TokenKind.IDENTIFIER, TokenKind.R_ANGLE, TokenKind.AMP, TokenKind.STAR, TokenKind.KW_INLINE]);

// `div(` as a call: not `QPI::div(`, not `x.div(`, and not a declaration such as `uint64 div(` or `T& div(`.
function isUnqualifiedCall(tokens: Token[], index: number): boolean {
    if (index === 0 || tokens[index + 1]?.kind !== TokenKind.L_PAREN) {
        return false;
    }
    const previous = tokens[index - 1].kind;
    return !MEMBER_ACCESS_KINDS.has(previous) && !DECLARATOR_KINDS.has(previous) && !TYPE_KINDS.has(previous);
}

const FORBIDDEN_PUBLIC_TYPE_NAMES = new Set(["Collection", "LinkedList", "HashMap", "HashSet"]);

function inCheatArgument(ranges: Array<{ start: number; end: number }>, token: Token): boolean {
    return ranges.some((range) => token.span.start >= range.start && token.span.end <= range.end);
}

export function analyzeQpiPolicy(
    source: string,
    registrations?: readonly ContractRegistration[],
    idl?: ContractIdl,
    calls: readonly SourceContractCall[] = [],
    // Type name -> the callee declaring it (from the compiler's callee context), when callee sources were given.
    calleeTypeOwners: ReadonlyMap<string, string> = new Map(),
): SourceAnalysisDiagnostic[] {
    const tokens = new Lexer(source).tokenize();
    const entries = findEntryFunctions(tokens);
    const calleeNames = new Set([...calls.map((call) => call.callee), ...calleeTypeOwners.values()]);
    const diagnostics = [
        ...analyzeCheatcodes(source),
        ...forbiddenConstructs(source, tokens, cheatArgumentRanges(source)),
        ...localDiagnostics(source, tokens, entries),
        ...localsFormDiagnostics(tokens, entries),
        ...logInFunctionDiagnostics(tokens, entries),
        ...invocatorInFunctionDiagnostics(tokens, entries),
        ...idlDiagnostics(tokens, entries, registrations, idl, calleeNames, calleeTypeOwners),
        ...contractNameDiagnostics(tokens),
        ...interContractErrorVarDiagnostics(source, tokens, calls),
    ];

    return diagnostics.sort(compareDiagnostics);
}

// Every inter-contract macro declares its error variable in the caller's scope, so two calls sharing one error name in a block are a C++ redefinition.
function interContractErrorVarDiagnostics(source: string, tokens: readonly Token[], calls: readonly SourceContractCall[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];

    for (const scope of callScopes(tokens, calls).values()) {
        for (const [errorVar, colliding] of collidingCalls(scope)) {
            const renamed = errorVarNames(colliding, source);
            const fixes = rewriteToExplicitErrorVars(source, colliding, renamed);
            const entries = colliding.map((call) => call.entry).join(", ");
            const suggested = colliding.map((call, index) => `${explicitMacro(call)}(…, ${renamed[index]})`).join(" and ");
            const message =
                `${colliding.length} inter-contract calls in this scope (${entries}) all declare \`${errorVar}\`, which is a redefinition. ` +
                `Use the \`_E\` variants with distinct error variables — ${suggested} — or wrap each call in its own \`{ }\`.`;

            // The first call is blameless on its own; the collision starts at the second one.
            for (const call of colliding.slice(1)) {
                diagnostics.push(diagnostic("qpi/duplicate-call-error-var", message, call.span, DiagnosticSeverity.ERROR, fixes));
            }
        }
    }

    return diagnostics;
}

function explicitMacro(call: SourceContractCall): string {
    return call.macro.endsWith("_E") ? call.macro : `${call.macro}_E`;
}

function collidingCalls(scope: readonly SourceContractCall[]): Map<string, SourceContractCall[]> {
    const byErrorVar = new Map<string, SourceContractCall[]>();

    for (const call of scope) {
        const errorVar = call.errorVar ?? DEFAULT_CALL_ERROR_VAR;
        const sharing = byErrorVar.get(errorVar) ?? [];
        sharing.push(call);
        byErrorVar.set(errorVar, sharing);
    }

    for (const [errorVar, sharing] of byErrorVar) {
        if (sharing.length < 2) {
            byErrorVar.delete(errorVar);
        }
    }

    return byErrorVar;
}

// Group the calls by the offset of their innermost enclosing `{`: calls arrive in source order with raw spans, so one pass with a brace stack places them.
function callScopes(tokens: readonly Token[], calls: readonly SourceContractCall[]): Map<number, SourceContractCall[]> {
    const scopes = new Map<number, SourceContractCall[]>();
    const openBraces: number[] = [];
    let next = 0;

    const placeCallsBefore = (offset: number): void => {
        while (next < calls.length && calls[next].span.start <= offset) {
            const scope = openBraces[openBraces.length - 1] ?? -1;
            const placed = scopes.get(scope) ?? [];
            placed.push(calls[next]);
            scopes.set(scope, placed);
            next++;
        }
    };

    for (const token of tokens) {
        placeCallsBefore(token.span.start);

        if (token.kind === TokenKind.L_BRACE) {
            openBraces.push(token.span.start);
        } else if (token.kind === TokenKind.R_BRACE) {
            openBraces.pop();
        }
    }
    placeCallsBefore(Number.MAX_SAFE_INTEGER);

    return scopes;
}

// `Inc` -> `incError`, kept clear of each other and of every name the source already spells.
function errorVarNames(calls: readonly SourceContractCall[], source: string): string[] {
    const taken = new Set<string>();
    const names: string[] = [];

    for (const call of calls) {
        const base = `${call.entry.charAt(0).toLowerCase()}${call.entry.slice(1)}Error`;
        let candidate = base;

        for (let suffix = 2; taken.has(candidate) || new RegExp(`\\b${candidate}\\b`).test(source); suffix++) {
            candidate = `${base}${suffix}`;
        }

        taken.add(candidate);
        names.push(candidate);
    }

    return names;
}

// Rewrite every colliding call, the first included: renaming only later calls would leave the first owning the shared name, which reads as an arbitrary split.
function rewriteToExplicitErrorVars(source: string, calls: readonly SourceContractCall[], names: readonly string[]): SourceFix[] | undefined {
    const edits: Array<{ start: number; end: number; newText: string }> = [];

    for (const [index, call] of calls.entries()) {
        if (source[call.span.end - 1] !== ")") {
            return undefined;
        }

        if (!call.macro.endsWith("_E")) {
            edits.push({ start: call.span.start, end: call.span.start + call.macro.length, newText: explicitMacro(call) });
            edits.push({ start: call.span.end - 1, end: call.span.end - 1, newText: `, ${names[index]}` });
            continue;
        }

        // An _E call already has the argument slot, so only the name it spells there changes.
        const errorVar = call.errorVar ?? DEFAULT_CALL_ERROR_VAR;
        const argument = source.lastIndexOf(errorVar, call.span.end);
        if (argument < call.span.start) {
            return undefined;
        }

        edits.push({ start: argument, end: argument + errorVar.length, newText: names[index] });
    }

    return [sourceFix("Use the _E variants with distinct error variables", source, edits, true)];
}

// Core wraps every contract include in `#define CONTRACT_STATE_TYPE <Name>` / `#undef`, so a struct naming itself with the macro has no name of its own.
// Read alone, by clangd or a reviewer, it is literally `CONTRACT_STATE_TYPE`. Advisory, because Qinit defines the macro too and the contract still builds.
function contractNameDiagnostics(tokens: readonly Token[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];

    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].kind !== TokenKind.KW_STRUCT && tokens[index].kind !== TokenKind.KW_CLASS) {
            continue;
        }
        const name = tokens[index + 1];
        if (name?.kind !== TokenKind.IDENTIFIER || (name.text !== "CONTRACT_STATE_TYPE" && name.text !== "CONTRACT_STATE2_TYPE")) {
            continue;
        }

        for (let cursor = index + 2; cursor < tokens.length; cursor++) {
            const token = tokens[cursor];
            if (token.kind === TokenKind.L_BRACE || token.kind === TokenKind.SEMICOLON) {
                break;
            }
            if (token.kind === TokenKind.IDENTIFIER && token.text === "ContractBase") {
                diagnostics.push(
                    diagnostic(
                        "qpi/macro-contract-name",
                        `Name the contract struct after the contract (\`struct MyToken : public ContractBase\`) rather than the \`${name.text}\` macro — core defines that macro around the include, so the struct has no name of its own outside it.`,
                        name.span,
                    ),
                );
                break;
            }
        }
    }

    return diagnostics;
}

export function detectQpiContractName(source: string): string | undefined {
    const tokens = new Lexer(source).tokenize();

    for (let index = 0; index < tokens.length; index++) {
        if (tokens[index].kind !== TokenKind.KW_STRUCT && tokens[index].kind !== TokenKind.KW_CLASS) {
            continue;
        }

        const name = tokens[index + 1];
        if (name?.kind !== TokenKind.IDENTIFIER) {
            continue;
        }

        for (let cursor = index + 2; cursor < tokens.length; cursor++) {
            const token = tokens[cursor];
            if (token.kind === TokenKind.L_BRACE || token.kind === TokenKind.SEMICOLON) {
                break;
            }
            if (token.kind === TokenKind.IDENTIFIER && token.text === "ContractBase") {
                return name.text;
            }
        }
    }

    return undefined;
}

function forbiddenConstructs(source: string, tokens: Token[], cheatRanges: Array<{ start: number; end: number }>): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];
    let braceDepth = 0;
    let skipUntil = -1;

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === TokenKind.EOF) {
            break;
        }
        if (token.span.start < skipUntil) {
            continue;
        }

        if ((token.kind === TokenKind.KW_STATIC_ASSERT || token.text === "STATIC_ASSERT") && tokens[index + 1]?.kind === TokenKind.L_PAREN) {
            const close = matchingToken(tokens, index + 1, TokenKind.L_PAREN, TokenKind.R_PAREN);
            if (close >= 0) {
                index = close;
                continue;
            }
        }

        if (token.kind === TokenKind.HASH) {
            const newline = source.indexOf("\n", token.span.start);
            skipUntil = newline < 0 ? source.length : newline;
            const directive = source.slice(token.span.start, skipUntil);
            if (!/^#\s*include\s*[<"][^>"]*qpi\.h[>"]/.test(directive)) {
                diagnostics.push(
                    diagnostic(
                        "qpi/no-preprocessor",
                        "Preprocessor directives (`#`) are forbidden in QPI (remove before deploying).",
                        token.span,
                        DiagnosticSeverity.INFORMATION,
                    ),
                );
            }
            continue;
        }

        if (token.kind === TokenKind.L_BRACE) {
            braceDepth++;
            continue;
        }
        if (token.kind === TokenKind.R_BRACE) {
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
        }

        if (token.kind === TokenKind.STRING_LITERAL) {
            // A literal inside a cheat argument is interned into the IDL and never reaches memory.
            if (!inCheatArgument(cheatRanges, token)) {
                diagnostics.push(diagnostic("qpi/no-string", 'String literals (`"`) are forbidden in QPI — they can address arbitrary memory.', token.span));
            }
            continue;
        }
        if (token.kind === TokenKind.CHAR_LITERAL) {
            if (/[0-9a-fA-F]/.test(source[token.span.start - 1] ?? "") && /[0-9a-fA-F]/.test(source[token.span.end] ?? "")) {
                continue;
            }
            diagnostics.push(diagnostic("qpi/no-char", "Character literals (`'`) are forbidden in QPI.", token.span));
            continue;
        }
        if (token.kind === TokenKind.SLASH || token.kind === TokenKind.SLASH_EQ) {
            diagnostics.push(
                diagnostic(
                    "qpi/no-division",
                    "The `/` operator is forbidden (division by zero is undefined). Use `QPI::div(a, b)`.",
                    token.span,
                    DiagnosticSeverity.WARNING,
                    divModFix(source, token, BinaryOp.DIVIDE),
                ),
            );
            continue;
        }
        if (token.kind === TokenKind.PERCENT || token.kind === TokenKind.PERCENT_EQ) {
            diagnostics.push(
                diagnostic(
                    "qpi/no-modulo",
                    "The `%` operator is forbidden. Use `QPI::mod(a, b)`.",
                    token.span,
                    DiagnosticSeverity.WARNING,
                    divModFix(source, token, BinaryOp.MODULO),
                ),
            );
            continue;
        }
        if (token.kind === TokenKind.L_BRACKET || token.kind === TokenKind.R_BRACKET) {
            diagnostics.push(
                diagnostic(
                    "qpi/no-brackets",
                    `\`${token.text}\` is forbidden (no low-level arrays / unchecked buffers). Use \`Array<T, N>\`.`,
                    token.span,
                    DiagnosticSeverity.WARNING,
                    arrayFix(source, token.span.start),
                ),
            );
            continue;
        }
        if (
            token.kind === TokenKind.ELLIPSIS ||
            (token.kind === TokenKind.DOT &&
                tokens[index + 1]?.kind === TokenKind.DOT &&
                tokens[index + 2]?.kind === TokenKind.DOT &&
                token.span.end === tokens[index + 1].span.start &&
                tokens[index + 1].span.end === tokens[index + 2].span.start)
        ) {
            const span =
                token.kind === TokenKind.ELLIPSIS
                    ? token.span
                    : {
                          ...token.span,
                          end: tokens[index + 2].span.end,
                      };
            diagnostics.push(diagnostic("qpi/no-varargs", "Variadic arguments / parameter packs (`...`) are forbidden.", span));
            if (token.kind === TokenKind.DOT) {
                index += 2;
            }
            continue;
        }
        if (token.text.includes("__")) {
            diagnostics.push(diagnostic("qpi/no-dunder", "Double underscores (`__`) are reserved for internal use and forbidden in contracts.", token.span));
            continue;
        }

        const keyword = KEYWORD_RULES[token.text];
        if (keyword) {
            diagnostics.push(diagnostic(keyword.code, keyword.message, token.span));
            continue;
        }

        const lp64Spelling = lp64WidthSpelling(tokens, index);
        if (lp64Spelling) {
            diagnostics.push(
                diagnostic(
                    "qpi/lp64-width-type",
                    `\`${lp64Spelling}\` is 4 bytes on wasm32 but 8 on Core (LP64), so the contract would test at one layout and ship at another — ` +
                        "use a fixed-width QPI type (sint64/uint64 or sint32/uint32).",
                    token.span,
                ),
            );
            continue;
        }

        const math = token.kind === TokenKind.IDENTIFIER ? UNQUALIFIED_MATH[token.text] : undefined;
        if (math && isUnqualifiedCall(tokens, index)) {
            const qualify = sourceFix(`Qualify as QPI::${token.text}`, source, [{ start: token.span.start, end: token.span.start, newText: "QPI::" }], true);
            diagnostics.push(diagnostic(math.code, math.message, token.span, DiagnosticSeverity.WARNING, [qualify]));
            continue;
        }

        if (braceDepth === 0 && token.kind === TokenKind.KW_TYPEDEF) {
            diagnostics.push(diagnostic("qpi/no-global-typedef", "`typedef` is only allowed in local scope (inside a struct or function).", token.span));
            continue;
        }
        if (braceDepth === 0 && token.kind === TokenKind.KW_USING && !isUsingNamespaceQpi(tokens, index)) {
            diagnostics.push(diagnostic("qpi/no-global-using", "`using` at global scope is forbidden, except `using namespace QPI`.", token.span));
        }
    }

    return diagnostics;
}

function localDiagnostics(source: string, tokens: Token[], entries: EntryFunction[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];

    for (const entry of entries) {
        const declarations = findLocalDeclarations(tokens, entry);

        for (const declaration of declarations) {
            for (const name of declaration.names) {
                const edits =
                    declaration.names.length === 1 && !declaration.forInitializer ? moveLocalToWithLocalsEdits(source, tokens, entry, declaration, name) : null;
                const fixes = edits && edits.length > 0 ? [sourceFix("Move into <fn>_locals struct (use *_WITH_LOCALS)", source, edits)] : undefined;

                diagnostics.push(
                    diagnostic(
                        "qpi/stack-local",
                        `Stack-local \`${name.text}\` is forbidden in QPI — declare it in a \`<fn>_locals\` struct (use the *_WITH_LOCALS form), or keep state in StateData via \`state.mut()\`.`,
                        name.span,
                        DiagnosticSeverity.WARNING,
                        fixes,
                    ),
                );
            }
        }
    }

    return diagnostics;
}

function localsFormDiagnostics(tokens: Token[], entries: EntryFunction[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];
    const localsStructs = new Set<string>();

    for (let index = 0; index + 1 < tokens.length; index++) {
        if (tokens[index].kind === TokenKind.KW_STRUCT && tokens[index + 1].kind === TokenKind.IDENTIFIER && tokens[index + 1].text.endsWith("_locals")) {
            localsStructs.add(tokens[index + 1].text.slice(0, -"_locals".length));
        }
    }

    for (const entry of entries) {
        if (entry.withLocals) {
            continue;
        }

        let usesLocals = false;
        for (let index = entry.bodyOpen + 1; index < entry.bodyClose; index++) {
            if (tokens[index].kind === TokenKind.IDENTIFIER && tokens[index].text === "locals" && tokens[index + 1]?.kind === TokenKind.DOT) {
                usesLocals = true;
                break;
            }
        }
        const hasStruct = localsStructs.has(entry.name);
        if (!usesLocals && !hasStruct) {
            continue;
        }

        diagnostics.push(
            diagnostic(
                "qpi/needs-with-locals",
                hasStruct
                    ? `\`${entry.name}\` has a \`${entry.name}_locals\` struct, but \`${entry.plainForm}\` ignores it and re-typedefs \`${entry.name}_locals\` to empty (QPI::NoData). Use \`${entry.withForm}\` so \`locals\` is your struct.`
                    : `\`${entry.name}\` uses \`locals\`, but \`${entry.plainForm}\` provides none (locals = empty QPI::NoData). Use \`${entry.withForm}\` and declare \`struct ${entry.name}_locals { … };\`.`,
                entry.macroSpan,
            ),
        );
    }

    return diagnostics;
}

// The spelling of a native C type whose width differs between wasm32 and Core's LP64 build; `long long` lexes as one keyword, so a lone `long` is never part.
function lp64WidthSpelling(tokens: Token[], index: number): string | null {
    const token = tokens[index];

    if (token.kind === TokenKind.IDENTIFIER && token.text === "size_t") {
        return "size_t";
    }
    if (token.kind !== TokenKind.KW_LONG) {
        return null;
    }

    const previous = tokens[index - 1];
    const next = tokens[index + 1];
    const sign = previous?.kind === TokenKind.KW_UNSIGNED ? "unsigned " : previous?.kind === TokenKind.KW_SIGNED ? "signed " : "";
    const width = next?.kind === TokenKind.KW_INT ? " int" : "";
    return `${sign}long${width}`;
}

const LOG_MACROS = new Set(["LOG_DEBUG", "LOG_ERROR", "LOG_INFO", "LOG_WARNING"]);

// A function is a read-only query with no transaction to pair a log with: core's guide forbids it, the node drops the record, so both backends refuse it.
function logInFunctionDiagnostics(tokens: Token[], entries: EntryFunction[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];

    for (const entry of entries) {
        if (!/^(PUBLIC|PRIVATE)_FUNCTION(_WITH_LOCALS)?$/.test(entry.macro)) {
            continue;
        }
        for (let cursor = entry.bodyOpen + 1; cursor < entry.bodyClose; cursor++) {
            const token = tokens[cursor];
            if (token.kind !== TokenKind.IDENTIFIER || !LOG_MACROS.has(token.text) || tokens[cursor + 1]?.kind !== TokenKind.L_PAREN) {
                continue;
            }
            diagnostics.push(
                diagnostic(
                    "qpi/log-in-function",
                    `\`${token.text}\` inside function \`${entry.name}\` — logging is only allowed in procedures: a function is a read-only query ` +
                        "with no transaction to pair the log with. Move the log into a procedure.",
                    token.span,
                ),
            );
        }
    }

    return diagnostics;
}

// `qpi.invocator()` is the null identity on the query path, so a caller check inside a function can never pass. PUBLIC only: a procedure has a real invocator.
function invocatorInFunctionDiagnostics(tokens: Token[], entries: EntryFunction[]): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];

    for (const entry of entries) {
        if (!/^PUBLIC_FUNCTION(_WITH_LOCALS)?$/.test(entry.macro)) {
            continue;
        }
        for (let cursor = entry.bodyOpen + 1; cursor < entry.bodyClose; cursor++) {
            const token = tokens[cursor];
            if (
                token.kind !== TokenKind.IDENTIFIER ||
                token.text !== "qpi" ||
                tokens[cursor + 1]?.kind !== TokenKind.DOT ||
                tokens[cursor + 2]?.text !== "invocator" ||
                tokens[cursor + 3]?.kind !== TokenKind.L_PAREN
            ) {
                continue;
            }
            diagnostics.push(
                diagnostic(
                    "qpi/invocator-in-function",
                    `\`qpi.invocator()\` inside function \`${entry.name}\` is the null identity — a function is answered as an RPC query, ` +
                        "with no transaction and so no caller. A comparison against it can never pass. Move the check into a procedure, " +
                        "or take the identity as an input field.",
                    tokens[cursor + 2].span,
                ),
            );
        }
    }

    return diagnostics;
}

// A type another contract declares, spelled inside a public interface struct: core's verifier cannot see the callee, so the message names the owner instead.
function calleeTypeAt(
    tokens: Token[],
    cursor: number,
    calleeNames: ReadonlySet<string>,
    calleeTypeOwners: ReadonlyMap<string, string>,
): { spelling: string; owner: string; tokenCount: number } | null {
    const token = tokens[cursor];
    if (token.kind !== TokenKind.IDENTIFIER) {
        return null;
    }

    const scoped = tokens[cursor + 1]?.kind === TokenKind.D_COLON && tokens[cursor + 2]?.kind === TokenKind.IDENTIFIER;
    if (scoped && calleeNames.has(token.text)) {
        return { spelling: `${token.text}::${tokens[cursor + 2].text}`, owner: token.text, tokenCount: 3 };
    }

    const owner = calleeTypeOwners.get(token.text);
    if (owner !== undefined && !scoped) {
        return { spelling: token.text, owner, tokenCount: 1 };
    }

    return null;
}

function idlDiagnostics(
    tokens: Token[],
    entries: EntryFunction[],
    semanticRegistrations?: readonly ContractRegistration[],
    idl?: ContractIdl,
    calleeNames: ReadonlySet<string> = new Set(),
    calleeTypeOwners: ReadonlyMap<string, string> = new Map(),
): SourceAnalysisDiagnostic[] {
    const diagnostics: SourceAnalysisDiagnostic[] = [];
    const registrations = {
        FUNCTION: new Map<number, string>(),
        PROCEDURE: new Map<number, string>(),
    };
    const registered = new Set<string>();

    if (semanticRegistrations) {
        for (const registration of semanticRegistrations) {
            const kind = registration.kind === USER_FUNCTION_KIND ? QpiMacroKind.FUNCTION : QpiMacroKind.PROCEDURE;

            registered.add(registration.fnName);
            const previous = registrations[kind].get(registration.inputType);
            if (previous !== undefined && previous !== registration.fnName) {
                const entry = entries.find((candidate) => candidate.name === registration.fnName);
                diagnostics.push(
                    diagnostic(
                        kind === QpiMacroKind.FUNCTION ? "qpi/dup-fn-index" : "qpi/dup-proc-index",
                        `Duplicate ${kind.toLowerCase()} index ${registration.inputType} — already used by \`${previous}\`. Each ${kind.toLowerCase()} needs a unique index.`,
                        entry?.nameSpan ?? tokens[0].span,
                    ),
                );
            } else if (previous === undefined) {
                registrations[kind].set(registration.inputType, registration.fnName);
            }
        }
    }

    const publicNames = new Set(entries.filter((entry) => entry.publicEntry).map((entry) => entry.name));
    if (semanticRegistrations) {
        for (const entry of entries) {
            if (entry.publicEntry && !registered.has(entry.name)) {
                const kind = entry.macro.includes("FUNCTION") ? QpiMacroKind.FUNCTION : QpiMacroKind.PROCEDURE;
                diagnostics.push(
                    diagnostic(
                        "qpi/unregistered",
                        `\`${entry.name}\` is defined but never registered — add REGISTER_USER_${kind}(${entry.name}, <index>) so it's callable on-chain.`,
                        entry.nameSpan,
                    ),
                );
            }
        }
    }

    const reportedTypes = new Set<string>();
    for (let index = 0; index + 2 < tokens.length; index++) {
        if (tokens[index].kind !== TokenKind.KW_STRUCT || tokens[index + 1].kind !== TokenKind.IDENTIFIER) {
            continue;
        }

        const match = /^(\w+)_(input|output)$/.exec(tokens[index + 1].text);
        if (!match || !publicNames.has(match[1])) {
            continue;
        }

        const open = findNext(tokens, index + 2, TokenKind.L_BRACE, TokenKind.SEMICOLON);
        if (open < 0 || tokens[open].kind !== TokenKind.L_BRACE) {
            continue;
        }
        const close = matchingToken(tokens, open, TokenKind.L_BRACE, TokenKind.R_BRACE);
        if (close < 0) {
            continue;
        }

        for (let cursor = open + 1; cursor < close; cursor++) {
            const calleeType = calleeTypeAt(tokens, cursor, calleeNames, calleeTypeOwners);
            if (calleeType) {
                diagnostics.push(
                    diagnostic(
                        "qpi/public-callee-type",
                        `\`${calleeType.spelling}\` is declared by contract ${calleeType.owner} — another contract's types are not allowed in a public ` +
                            `input/output (\`${tokens[index + 1].text}\`): core's verifier cannot see them. Copy the struct into this contract, ` +
                            "or keep the callee's type in `_locals` or the state.",
                        tokens[cursor].span,
                    ),
                );
                cursor += calleeType.tokenCount - 1;
                continue;
            }
            if (!FORBIDDEN_PUBLIC_TYPE_NAMES.has(tokens[cursor].text)) {
                continue;
            }
            diagnostics.push(
                diagnostic(
                    "qpi/public-complex-type",
                    `\`${tokens[cursor].text}\` is forbidden in the public interface (\`${tokens[index + 1].text}\`) — complex types can carry inconsistent internal state across the call boundary. Use scalars, \`id\`, \`Array\`, or \`BitArray\`.`,
                    tokens[cursor].span,
                ),
            );
            reportedTypes.add(`${tokens[index + 1].text}:${tokens[cursor].text}`);
        }
    }

    const idlEntries = idl ? [...idl.functions, ...idl.procedures] : [];
    for (const entry of idlEntries) {
        const sourceEntry = entries.find((candidate) => candidate.name === entry.name);
        for (const [suffix, type] of [
            ["input", entry.input],
            ["output", entry.output],
        ] as const) {
            const interfaceName = `${entry.name}_${suffix}`;
            for (const typeName of forbiddenAbiTypes(type)) {
                if (reportedTypes.has(`${interfaceName}:${typeName}`)) {
                    continue;
                }
                diagnostics.push(
                    diagnostic(
                        "qpi/public-complex-type",
                        `\`${typeName}\` is forbidden in the public interface (\`${interfaceName}\`) — complex types can carry inconsistent internal state across the call boundary. Use scalars, \`id\`, \`Array\`, or \`BitArray\`.`,
                        sourceEntry?.nameSpan ?? tokens[0].span,
                    ),
                );
            }
        }
    }

    return diagnostics;
}

function forbiddenAbiTypes(type: AbiType): string[] {
    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            return [];
        case AbiTypeKind.ARRAY:
            return forbiddenAbiTypes(type.element);
        case AbiTypeKind.BIT_ARRAY:
            return [];
        case AbiTypeKind.STRUCT:
            // A container the IDL could not resolve into its own kind still carries its C++ name.
            return [
                ...(FORBIDDEN_PUBLIC_TYPE_NAMES.has(type.name ?? "") ? [type.name!] : []),
                ...type.fields.flatMap((field) => forbiddenAbiTypes(field.type)),
            ];
        case AbiTypeKind.COLLECTION:
            return ["Collection", ...forbiddenAbiTypes(type.value)];
        case AbiTypeKind.HASH_MAP:
            return ["HashMap", ...forbiddenAbiTypes(type.key), ...forbiddenAbiTypes(type.value)];
        case AbiTypeKind.HASH_SET:
            return ["HashSet", ...forbiddenAbiTypes(type.key)];
        case AbiTypeKind.LINKED_LIST:
            return ["LinkedList", ...forbiddenAbiTypes(type.value)];
    }
}
