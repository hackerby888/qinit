import { BinaryOp, DiagnosticSeverity, QpiMacroKind, TokenKind } from "../shared/enums";
import { AbiTypeKind, type AbiType, type ContractIdl } from "@qinit/proto/contract-idl";
import type { ContractRegistration } from "../backend/wasm/module/registrations";
import { Lexer, type Token } from "../frontend/lexer";
import type { SourceAnalysisDiagnostic } from "./index";
import { USER_FUNCTION_KIND } from "../shared/entry-abi";
import { findEntryFunctions, findLocalDeclarations, findNext, isUsingNamespaceQpi, matchingToken, type EntryFunction } from "./rules/tokens";
import { arrayFix, compareDiagnostics, diagnostic, divModFix, moveLocalToWithLocalsEdits, sourceFix } from "./rules/fixes";

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

const FORBIDDEN_PUBLIC_TYPE_NAMES = new Set(["Collection", "LinkedList", "HashMap", "HashSet"]);

export function analyzeQpiPolicy(source: string, registrations?: readonly ContractRegistration[], idl?: ContractIdl): SourceAnalysisDiagnostic[] {
    const tokens = new Lexer(source).tokenize();
    const entries = findEntryFunctions(tokens);
    const diagnostics = [
        ...forbiddenConstructs(source, tokens),
        ...localDiagnostics(source, tokens, entries),
        ...localsFormDiagnostics(tokens, entries),
        ...idlDiagnostics(tokens, entries, registrations, idl),
        ...contractNameDiagnostics(tokens),
    ];

    return diagnostics.sort(compareDiagnostics);
}

// Core wraps every contract include in `#define CONTRACT_STATE_TYPE <Name>` / `#undef`, so a struct that
// names itself with the macro compiles there — but it has no name of its own. Read on its own, by clangd
// or a reviewer, the struct is literally `CONTRACT_STATE_TYPE` and nothing can refer to it: another
// contract's `RANDOM::BuyEntropy_input` only resolves because RANDOM declares its own name. All 36 core
// contracts do. Advisory, because Qinit defines the macro too and the contract still builds here.
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

function forbiddenConstructs(source: string, tokens: Token[]): SourceAnalysisDiagnostic[] {
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
            diagnostics.push(diagnostic("qpi/no-string", 'String literals (`"`) are forbidden in QPI — they can address arbitrary memory.', token.span));
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
                    "The `/` operator is forbidden (division by zero is undefined). Use `div(a, b)`.",
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
                    "The `%` operator is forbidden. Use `mod(a, b)`.",
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

function idlDiagnostics(
    tokens: Token[],
    entries: EntryFunction[],
    semanticRegistrations?: readonly ContractRegistration[],
    idl?: ContractIdl,
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
