import { TokenKind } from "../../enums";
import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";

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
            return mk(TokenKind.L_BRACE);
        case "}":
            return mk(TokenKind.R_BRACE);
        case "(":
            return mk(TokenKind.L_PAREN);
        case ")":
            return mk(TokenKind.R_PAREN);
        case "[":
            return mk(TokenKind.L_BRACKET);
        case "]":
            return mk(TokenKind.R_BRACKET);
        case ";":
            return mk(TokenKind.SEMICOLON);
        case ":":
            return next === ":" ? mk2(TokenKind.D_COLON, ":") : mk(TokenKind.COLON);
        case ",":
            return mk(TokenKind.COMMA);
        case "?":
            return mk(TokenKind.QUESTION);
        case "~":
            return mk(TokenKind.TILDE);
        case ".":
            if (next === "*") {
                return mk2(TokenKind.DOT_STAR, "*");
            }
            if (next === "." && context.peekChar(2) === ".") {
                return mk3(TokenKind.ELLIPSIS, ".", ".");
            }
            return mk(TokenKind.DOT);
        case "+":
            if (next === "=") {
                return mk2(TokenKind.PLUS_EQ, "=");
            }
            if (next === "+") {
                return mk2(TokenKind.PLUS_PLUS, "+");
            }
            return mk(TokenKind.PLUS);
        case "-":
            if (next === "=") {
                return mk2(TokenKind.MINUS_EQ, "=");
            }
            if (next === "-") {
                return mk2(TokenKind.MINUS_MINUS, "-");
            }
            if (next === ">") {
                const after = context.peekChar(1);
                if (after === "*") {
                    return mk3(TokenKind.ARROW_STAR, ">", "*");
                }
                return mk2(TokenKind.ARROW, ">");
            }
            return mk(TokenKind.MINUS);
        case "*":
            if (next === "=") {
                return mk2(TokenKind.STAR_EQ, "=");
            }
            return mk(TokenKind.STAR);
        case "/":
            if (next === "=") {
                return mk2(TokenKind.SLASH_EQ, "=");
            }
            return mk(TokenKind.SLASH);
        case "%":
            if (next === "=") {
                return mk2(TokenKind.PERCENT_EQ, "=");
            }
            return mk(TokenKind.PERCENT);
        case "=":
            if (next === "=") {
                return mk2(TokenKind.EQ_EQ, "=");
            }
            return mk(TokenKind.EQ);
        case "!":
            if (next === "=") {
                return mk2(TokenKind.NOT_EQ, "=");
            }
            return mk(TokenKind.BANG);
        case "<":
            if (next === "=") {
                const after = context.peekChar(1);
                if (after === ">") {
                    return mk3(TokenKind.SPACESHIP, "=", ">");
                }
                return mk2(TokenKind.LT_EQ, "=");
            }
            if (next === "<") {
                const after = context.peekChar(1);
                if (after === "=") {
                    return mk3(TokenKind.L_SHIFT_EQ, "<", "=");
                }
                return mk2(TokenKind.L_SHIFT, "<");
            }
            return mk(TokenKind.L_ANGLE);
        case ">":
            if (next === "=") {
                return mk2(TokenKind.GT_EQ, "=");
            }
            if (next === ">") {
                const after = context.peekChar(1);
                if (after === "=") {
                    return mk3(TokenKind.R_SHIFT_EQ, ">", "=");
                }
                return mk2(TokenKind.R_SHIFT, ">");
            }
            return mk(TokenKind.R_ANGLE);
        case "&":
            if (next === "=") {
                return mk2(TokenKind.AMP_EQ, "=");
            }
            if (next === "&") {
                return mk2(TokenKind.AMP_AMP, "&");
            }
            return mk(TokenKind.AMP);
        case "|":
            if (next === "=") {
                return mk2(TokenKind.PIPE_EQ, "=");
            }
            if (next === "|") {
                return mk2(TokenKind.PIPE_PIPE, "|");
            }
            return mk(TokenKind.PIPE);
        case "^":
            if (next === "=") {
                return mk2(TokenKind.CARET_EQ, "=");
            }
            return mk(TokenKind.CARET);
        case "#":
            if (next === "#") {
                return mk2(TokenKind.D_HASH, "#");
            }
            return mk(TokenKind.HASH);
        default:
            // Unknown character — skip it but emit as identifier for error recovery
            return { kind: TokenKind.IDENTIFIER, text: ch, span: context.makeSpan(start, startLine, startCol) };
    }
}
