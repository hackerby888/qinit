import type { Span } from "../../ast";
import type { TokenKind } from "../../lexer";
import type { ParserInternals } from "./parser-context";

export function skipBalanced(context: ParserInternals, open: TokenKind, close: TokenKind): void {
    if (context.peek().kind !== open)
        return;
    context.next(); // consume the opener
    let depth = 1;
    while (!context.eof() && depth > 0) {
        const kind = context.peek().kind;
        if (kind === open)
            depth++;
        else if (kind === close)
            depth--;
        context.next();
    }
}

export function recover(context: ParserInternals, beforeIndex: number, errsBefore: number): void {
    const idx = (context.lex as any).index;
    const noProgress = idx === beforeIndex;
    const newError = context.diagnostics.length > errsBefore;
    if (!noProgress && !newError)
        return;
    // A declaration that consumed its full balanced body ends on `}` or `;`. Its inner errors are already
    if (!noProgress && (context._last?.kind === "r_brace" || context._last?.kind === "semicolon")) {
        return;
    }
    if (noProgress) {
        context.next(); // force progress
    }
    let depth = 0;
    while (!context.eof()) {
        const kind = context.peek().kind;
        if (kind === "l_brace") {
            depth++;
            context.next();
            continue;
        }
        if (kind === "r_brace") {
            if (depth === 0)
                return; // class body's own close — let the caller handle it
            depth--;
            context.next();
            if (depth === 0)
                return; // finished a member's brace body (e.g. a constructor) — member boundary
            continue;
        }
        if (kind === "semicolon" && depth === 0) {
            context.next();
            return;
        }
        context.next();
    }
}

export function parseCharValue(context: ParserInternals, text: string): number {
    // Parse C++ character literal value
    const inner = text.replace(/^'|'$/g, "");
    if (inner.startsWith("\\")) {
        switch (inner[1]) {
            case "n":
                return 10;
            case "t":
                return 9;
            case "r":
                return 13;
            case "0":
                return 0;
            case "\\":
                return 92;
            case "'":
                return 39;
            default:
                return inner.charCodeAt(1);
        }
    }
    return inner.charCodeAt(0);
}

export function makeSpan(context: ParserInternals, start: Span): Span {
    const last = context._last?.span ?? context.peek().span;
    return { start: start.start, end: last.end, line: start.line, column: start.column };
}
