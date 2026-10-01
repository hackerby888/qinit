// QPI's PRIVATE_* macros leave `protected:` in force until a PUBLIC_* or system-procedure macro reopens `public:`. clang refuses another contract
// naming a member declared in between ("is a protected member"); the TypeScript backend reads no access, so the shared gate refuses it here.
import { AccessSpec, DiagnosticSeverity, TokenKind } from "../../shared/enums";
import { Lexer, type Token } from "../../frontend/lexer";
import type { MacroDef } from "../../frontend/preprocessor/preprocessor-context";
import type { SourceAnalysisDiagnostic } from "../index";
import { diagnostic } from "./fixes";

const ACCESS_KEYWORDS = new Map<TokenKind, AccessSpec>([
    [TokenKind.KW_PUBLIC, AccessSpec.PUBLIC],
    [TokenKind.KW_PROTECTED, AccessSpec.PROTECTED],
    [TokenKind.KW_PRIVATE, AccessSpec.PRIVATE],
]);

/** The access a macro's expansion leaves in force: its last access label, its own or one a macro it expands to writes. */
export function accessAfterMacro(macros: ReadonlyMap<string, MacroDef>, name: string, path: ReadonlySet<string> = new Set()): AccessSpec | null {
    const macro = macros.get(name);
    if (!macro || path.has(name)) return null;
    const inner = new Set(path).add(name);
    let access: AccessSpec | null = null;
    for (const match of macro.body.matchAll(/\b(public|protected|private)\s*:(?!:)|\b([A-Za-z_]\w*)\s*\(/g)) {
        const after = match[1] ? (match[1] as AccessSpec) : accessAfterMacro(macros, match[2], inner);
        if (after) access = after;
    }
    return access;
}

/** The structs and typedefs a contract declares where they are not public, each with the macro that made them so. */
export function nonPublicMembers(source: string, stateType: string, macros: ReadonlyMap<string, MacroDef>): Map<string, string> {
    const tokens = new Lexer(source).tokenize();
    const members = new Map<string, string>();
    const open = findContractBody(tokens, stateType);
    if (open < 0) return members;

    let access = AccessSpec.PUBLIC; // a struct's members start public
    let opener = "";
    let depth = 0;
    for (let index = open; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === TokenKind.L_BRACE) depth++;
        else if (token.kind === TokenKind.R_BRACE && --depth === 0) break;
        if (depth !== 1) continue;

        const label = ACCESS_KEYWORDS.get(token.kind);
        if (label && tokens[index + 1]?.kind === TokenKind.COLON) {
            access = label;
            opener = `${token.text}:`;
        } else if (token.kind === TokenKind.IDENTIFIER && tokens[index + 1]?.kind === TokenKind.L_PAREN && macros.has(token.text)) {
            const after = accessAfterMacro(macros, token.text);
            if (after) {
                access = after;
                const declared = tokens[index + 2]?.kind === TokenKind.IDENTIFIER ? tokens[index + 2].text : "";
                opener = `${token.text}(${declared})`;
                // the function or procedure a PRIVATE_* macro declares is itself protected
                if (after !== AccessSpec.PUBLIC && declared) members.set(declared, `declared by ${opener}`);
            }
        } else if (access !== AccessSpec.PUBLIC && (token.kind === TokenKind.KW_STRUCT || token.kind === TokenKind.KW_CLASS)) {
            const name = tokens[index + 1];
            if (name?.kind === TokenKind.IDENTIFIER) members.set(name.text, `declared after ${opener}`);
        } else if (access !== AccessSpec.PUBLIC && token.kind === TokenKind.KW_TYPEDEF) {
            let end = index + 1;
            while (end < tokens.length && tokens[end].kind !== TokenKind.SEMICOLON) end++;
            const name = tokens[end - 1];
            if (name?.kind === TokenKind.IDENTIFIER) members.set(name.text, `declared after ${opener}`);
        }
    }
    return members;
}

// `struct <stateType> ... {` at the top level: the token index of its opening brace.
function findContractBody(tokens: Token[], stateType: string): number {
    for (let index = 0; index + 1 < tokens.length; index++) {
        if (tokens[index].kind !== TokenKind.KW_STRUCT || tokens[index + 1].text !== stateType) continue;
        for (let brace = index + 2; brace < tokens.length; brace++) {
            if (tokens[brace].kind === TokenKind.SEMICOLON) break; // a forward declaration
            if (tokens[brace].kind === TokenKind.L_BRACE) return brace;
        }
    }
    return -1;
}

// The cross-contract call macros name the callee's members themselves (qpi_macros.h): `Callee::Proc`, `Callee::Proc##_locals` and
// `Callee::StateData`, none of which the caller writes.
const CROSS_CONTRACT_MACROS = new Set([
    "INVOKE_OTHER_CONTRACT_PROCEDURE",
    "INVOKE_OTHER_CONTRACT_PROCEDURE_E",
    "CALL_OTHER_CONTRACT_FUNCTION",
    "CALL_OTHER_CONTRACT_FUNCTION_E",
]);

const refusal = (member: string, reason: string, callee: string) =>
    `'${member}' is ${reason} in ${callee}, which leaves it protected: another contract cannot name it ` +
    `(clang: "'${member}' is a protected member of '${callee}'") — declare it above the private function or procedure`;

/** Every `Callee::Member` in the caller, and every member a cross-contract call macro names for it, that the callee leaves protected. */
export function nonPublicCalleeMemberDiagnostics(
    source: string,
    calleeSources: ReadonlyArray<{ name: string; source: string }>,
    macros: ReadonlyMap<string, MacroDef>,
): SourceAnalysisDiagnostic[] {
    const hidden = new Map<string, Map<string, string>>();
    for (const callee of calleeSources) {
        const members = nonPublicMembers(callee.source, callee.name, macros);
        if (members.size) hidden.set(callee.name, members);
    }
    if (!hidden.size) return [];

    const diagnostics: SourceAnalysisDiagnostic[] = [];
    const tokens = new Lexer(source).tokenize();
    for (let index = 0; index + 4 < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind === TokenKind.IDENTIFIER && CROSS_CONTRACT_MACROS.has(token.text) && tokens[index + 1].kind === TokenKind.L_PAREN) {
            const callee = tokens[index + 2].text;
            const entry = tokens[index + 4];
            const members = hidden.get(callee);
            if (members && tokens[index + 3].kind === TokenKind.COMMA && entry.kind === TokenKind.IDENTIFIER) {
                for (const named of [entry.text, `${entry.text}_locals`, "StateData"]) {
                    const reason = members.get(named);
                    if (reason === undefined) continue;
                    diagnostics.push(
                        diagnostic(
                            "qpi/non-public-callee-member",
                            `${token.text}(${callee}, ${entry.text}, …) names ${callee}::${named}: ${refusal(named, reason, callee)}`,
                            token.span,
                            DiagnosticSeverity.ERROR,
                        ),
                    );
                }
            }
        }
        const members = hidden.get(tokens[index].text);
        if (!members || tokens[index].kind !== TokenKind.IDENTIFIER || tokens[index + 1].kind !== TokenKind.D_COLON) continue;
        const member = tokens[index + 2];
        const reason = members.get(member.text);
        if (reason === undefined) continue;
        diagnostics.push(diagnostic("qpi/non-public-callee-member", refusal(member.text, reason, tokens[index].text), member.span, DiagnosticSeverity.ERROR));
    }
    return diagnostics;
}
