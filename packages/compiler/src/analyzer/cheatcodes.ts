// Cheatcode rules and the stripper that removes them before a contract is submitted to Core.
//
// The rules exist so that stripping is provably safe: a cheat may only appear as a whole statement,
// and may not carry a side effect, so blanking the call site can never change what the contract does.
import { DiagnosticSeverity } from "../shared/enums";
import { Lexer, TokenKind, type Token } from "../frontend/lexer";
import { matchingToken } from "./rules/tokens";
import type { SourceAnalysisDiagnostic } from "./index";

/** Every cheat the shim defines. Anything else on the `CC_` prefix is a typo, and rule 1 says so. */
export const CHEAT_NAMES: ReadonlySet<string> = new Set([
    "CC_PRINT",
    "CC_ASSERT",
    "CC_PAY",
    "CC_DEAL",
    "CC_WARP_TICK",
    "CC_WARP_EPOCH",
    "CC_PRANK",
    "CC_UNPRANK",
]);

/** Cheats that move value or chain state, so a read-only entry must not carry them. */
const MUTATING_CHEATS: ReadonlySet<string> = new Set(["CC_PAY", "CC_DEAL", "CC_WARP_TICK", "CC_WARP_EPOCH", "CC_PRANK", "CC_UNPRANK"]);

// Assignment in any form, plus the two update operators. All of them would vanish with the cheat.
const MUTATING_OPERATORS: ReadonlySet<TokenKind> = new Set([
    TokenKind.EQ,
    TokenKind.PLUS_EQ,
    TokenKind.MINUS_EQ,
    TokenKind.STAR_EQ,
    TokenKind.SLASH_EQ,
    TokenKind.PERCENT_EQ,
    TokenKind.L_SHIFT_EQ,
    TokenKind.R_SHIFT_EQ,
    TokenKind.AMP_EQ,
    TokenKind.PIPE_EQ,
    TokenKind.CARET_EQ,
    TokenKind.PLUS_PLUS,
    TokenKind.MINUS_MINUS,
]);

const CHEAT_PREFIX = /^CC_[A-Z0-9_]*$/;
const MAX_CHEATS_PER_LINE = 8;

// A cheat statement may follow any of these, which is what makes `if (x) CC_PRINT(y); else f();` safe
// to blank: the `else` still finds its `;`.
const STATEMENT_START: ReadonlySet<TokenKind> = new Set([
    TokenKind.SEMICOLON,
    TokenKind.L_BRACE,
    TokenKind.R_BRACE,
    TokenKind.R_PAREN,
    TokenKind.KW_ELSE,
    TokenKind.COLON,
]);

interface CheatCall {
    name: string;
    open: number;
    close: number;
    token: Token;
}

/** Every well-formed cheat call in the source, in order. */
function cheatCalls(tokens: Token[]): CheatCall[] {
    const calls: CheatCall[] = [];

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== TokenKind.IDENTIFIER || !CHEAT_PREFIX.test(token.text)) {
            continue;
        }

        if (tokens[index + 1]?.kind !== TokenKind.L_PAREN) {
            continue;
        }

        const close = matchingToken(tokens, index + 1, TokenKind.L_PAREN, TokenKind.R_PAREN);

        if (close < 0) {
            continue;
        }

        calls.push({ name: token.text, open: index, close, token });
        index = close;
    }

    return calls;
}

/**
 * The half-open source ranges covered by cheat arguments. A string or char literal there is interned
 * into the IDL and never lowered, so QPI's ban on them does not apply.
 */
export function cheatArgumentRanges(source: string): Array<{ start: number; end: number }> {
    const tokens = new Lexer(source).tokenize();

    return cheatCalls(tokens)
        .filter((call) => CHEAT_NAMES.has(call.name))
        .map((call) => ({ start: tokens[call.open + 1].span.start, end: tokens[call.close].span.end }));
}

function diagnostic(code: string, message: string, token: Token): SourceAnalysisDiagnostic {
    return { code, message, severity: DiagnosticSeverity.ERROR, span: token.span } as SourceAnalysisDiagnostic;
}

/** True while `index` sits inside a body that QPI dispatches as a read-only function. */
function insideFunctionBody(tokens: Token[], index: number): boolean {
    let entry = "";

    for (let scan = 0; scan < index; scan++) {
        const text = tokens[scan].text;

        if (tokens[scan].kind === TokenKind.IDENTIFIER && (text.endsWith("_FUNCTION") || text.endsWith("_PROCEDURE") || text.endsWith("_WITH_LOCALS"))) {
            entry = text;
        }
    }

    return entry.includes("_FUNCTION");
}

export function analyzeCheatcodes(source: string): SourceAnalysisDiagnostic[] {
    const tokens = new Lexer(source).tokenize();
    const diagnostics: SourceAnalysisDiagnostic[] = [];
    const perLine = new Map<number, number>();

    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];

        if (token.kind !== TokenKind.IDENTIFIER || !CHEAT_PREFIX.test(token.text)) {
            continue;
        }

        if (!CHEAT_NAMES.has(token.text)) {
            diagnostics.push(diagnostic("cheat/reserved-prefix", `'${token.text}' is not a cheatcode; the CC_ prefix is reserved.`, token));
            continue;
        }

        if (tokens[index + 1]?.kind !== TokenKind.L_PAREN || matchingToken(tokens, index + 1, TokenKind.L_PAREN, TokenKind.R_PAREN) < 0) {
            diagnostics.push(diagnostic("cheat/needs-parens", `${token.text} needs a balanced argument list.`, token));
            continue;
        }

        const close = matchingToken(tokens, index + 1, TokenKind.L_PAREN, TokenKind.R_PAREN);
        const previous = tokens[index - 1];

        if (previous && !STATEMENT_START.has(previous.kind)) {
            diagnostics.push(diagnostic("cheat/statement-only", `${token.text} must stand alone as a statement so it can be stripped.`, token));
        }

        if (tokens[close + 1]?.kind !== TokenKind.SEMICOLON) {
            diagnostics.push(diagnostic("cheat/statement-only", `${token.text} must end in a semicolon so it can be stripped.`, token));
        }

        const sideEffect = sideEffectToken(tokens, index + 2, close);

        if (sideEffect) {
            diagnostics.push(
                diagnostic("cheat/no-side-effects", `${token.text} arguments must not have side effects; they disappear in a production build.`, sideEffect),
            );
        }

        if (MUTATING_CHEATS.has(token.text) && insideFunctionBody(tokens, index)) {
            diagnostics.push(diagnostic("cheat/mutator-in-function", `${token.text} changes state, so it cannot run inside a function.`, token));
        }

        const line = token.span.line;
        const seen = (perLine.get(line) ?? 0) + 1;
        perLine.set(line, seen);

        if (seen > MAX_CHEATS_PER_LINE) {
            diagnostics.push(diagnostic("cheat/too-many-per-line", `At most ${MAX_CHEATS_PER_LINE} cheatcodes may share a line.`, token));
        }

        index = close;
    }

    return diagnostics;
}

// Reads of `qpi.*()` and `state.get()` are the shapes a useful print is built from; any other call, or
// any assignment, would vanish along with the cheat and change the contract's behaviour.
function sideEffectToken(tokens: Token[], from: number, to: number): Token | undefined {
    for (let index = from; index < to; index++) {
        const token = tokens[index];

        if (MUTATING_OPERATORS.has(token.kind)) {
            return token;
        }

        if (token.kind !== TokenKind.IDENTIFIER || tokens[index + 1]?.kind !== TokenKind.L_PAREN) {
            continue;
        }

        const receiver = tokens[index - 2];
        const dot = tokens[index - 1];
        const qualified = dot?.kind === TokenKind.DOT && receiver?.kind === TokenKind.IDENTIFIER;

        if (qualified && (receiver.text === "qpi" || (receiver.text === "state" && token.text === "get"))) {
            continue;
        }

        return token;
    }

    return undefined;
}

/**
 * Blanks every cheat call, keeping the trailing `;` and every newline, so line numbers and the
 * surrounding control flow survive untouched.
 */
export function stripCheatcodes(source: string): string {
    const characters = [...source];

    for (const call of cheatCalls(new Lexer(source).tokenize())) {
        const end = call.close;
        const tokens = new Lexer(source).tokenize();

        for (let position = call.token.span.start; position < tokens[end].span.end; position++) {
            if (characters[position] !== "\n") {
                characters[position] = " ";
            }
        }
    }

    return characters.join("");
}
