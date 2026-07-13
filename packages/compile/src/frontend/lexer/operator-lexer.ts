import type { LexerInternals } from "./lexer-context";
import type { Token, TokenKind } from "./tokens";

export function lexOperator(context: LexerInternals, start: number, startLine: number, startCol: number): Token {
    const ch = context.advance();
    const next = context.peekChar();
    const mk = (kind: TokenKind): Token => ({
        kind,
        text: ch,
        span: context.makeSpan(start, startLine, startCol),
    });
    const mk2 = (kind: TokenKind, ch2: string): Token => {
        context.advance();
        return { kind, text: ch + ch2, span: context.makeSpan(start, startLine, startCol) };
    };
    const mk3 = (kind: TokenKind, ch2: string, ch3: string): Token => {
        context.advance();
        context.advance();
        return { kind, text: ch + ch2 + ch3, span: context.makeSpan(start, startLine, startCol) };
    };
    switch (ch) {
        case "{":
            return mk("l_brace");
        case "}":
            return mk("r_brace");
        case "(":
            return mk("l_paren");
        case ")":
            return mk("r_paren");
        case "[":
            return mk("l_bracket");
        case "]":
            return mk("r_bracket");
        case ";":
            return mk("semicolon");
        case ":":
            return next === ":" ? mk2("d_colon", ":") : mk("colon");
        case ",":
            return mk("comma");
        case "?":
            return mk("question");
        case "~":
            return mk("tilde");
        case ".":
            if (next === "*") {
                return mk2("dot_star", "*");
            }
            if (next === "." && context.peekChar(2) === ".") {
                return mk3("ellipsis", ".", ".");
            }
            return mk("dot");
        case "+":
            if (next === "=") {
                return mk2("plus_eq", "=");
            }
            if (next === "+") {
                return mk2("plus_plus", "+");
            }
            return mk("plus");
        case "-":
            if (next === "=") {
                return mk2("minus_eq", "=");
            }
            if (next === "-") {
                return mk2("minus_minus", "-");
            }
            if (next === ">") {
                const after = context.peekChar(1);
                if (after === "*") {
                    return mk3("arrow_star", ">", "*");
                }
                return mk2("arrow", ">");
            }
            return mk("minus");
        case "*":
            if (next === "=") {
                return mk2("star_eq", "=");
            }
            return mk("star");
        case "/":
            if (next === "=") {
                return mk2("slash_eq", "=");
            }
            return mk("slash");
        case "%":
            if (next === "=") {
                return mk2("percent_eq", "=");
            }
            return mk("percent");
        case "=":
            if (next === "=") {
                return mk2("eq_eq", "=");
            }
            return mk("eq");
        case "!":
            if (next === "=") {
                return mk2("not_eq", "=");
            }
            return mk("bang");
        case "<":
            if (next === "=") {
                const after = context.peekChar(1);
                if (after === ">") {
                    return mk3("spaceship", "=", ">");
                }
                return mk2("lt_eq", "=");
            }
            if (next === "<") {
                const after = context.peekChar(1);
                if (after === "=") {
                    return mk3("l_shift_eq", "<", "=");
                }
                return mk2("l_shift", "<");
            }
            return mk("l_angle");
        case ">":
            if (next === "=") {
                return mk2("gt_eq", "=");
            }
            if (next === ">") {
                const after = context.peekChar(1);
                if (after === "=") {
                    return mk3("r_shift_eq", ">", "=");
                }
                return mk2("r_shift", ">");
            }
            return mk("r_angle");
        case "&":
            if (next === "=") {
                return mk2("amp_eq", "=");
            }
            if (next === "&") {
                return mk2("amp_amp", "&");
            }
            return mk("amp");
        case "|":
            if (next === "=") {
                return mk2("pipe_eq", "=");
            }
            if (next === "|") {
                return mk2("pipe_pipe", "|");
            }
            return mk("pipe");
        case "^":
            if (next === "=") {
                return mk2("caret_eq", "=");
            }
            return mk("caret");
        case "#":
            if (next === "#") {
                return mk2("d_hash", "#");
            }
            return mk("hash");
        default:
            // Unknown character — skip it but emit as identifier for error recovery
            return { kind: "identifier", text: ch, span: context.makeSpan(start, startLine, startCol) };
    }
}
