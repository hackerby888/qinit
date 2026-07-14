import type { Span } from "../../ast";
import type { TokenKind } from "../../lexer";
import type { Parser } from "./parser";

export class ParserRecovery {
    constructor(private readonly parser: Parser) {}

    skipBalanced(open: TokenKind, close: TokenKind): void {
        if (this.parser.state.peek().kind !== open)
            return;
        this.parser.state.next(); // consume the opener
        let depth = 1;
        while (!this.parser.state.eof() && depth > 0) {
            const kind = this.parser.state.peek().kind;
            if (kind === open)
                depth++;
            else if (kind === close)
                depth--;
            this.parser.state.next();
        }
    }

    recover(beforeIndex: number, errsBefore: number): void {
        const idx = this.parser.state.position;
        const noProgress = idx === beforeIndex;
        const newError = this.parser.state.diagnostics.length > errsBefore;
        if (!noProgress && !newError)
            return;
        // A declaration that consumed its full balanced body ends on `}` or `;`. Its inner errors are already
        if (!noProgress && (this.parser.state.lastToken?.kind === "r_brace" || this.parser.state.lastToken?.kind === "semicolon")) {
            return;
        }
        if (noProgress) {
            this.parser.state.next(); // force progress
        }
        let depth = 0;
        while (!this.parser.state.eof()) {
            const kind = this.parser.state.peek().kind;
            if (kind === "l_brace") {
                depth++;
                this.parser.state.next();
                continue;
            }
            if (kind === "r_brace") {
                if (depth === 0)
                    return; // class body's own close — let the caller handle it
                depth--;
                this.parser.state.next();
                if (depth === 0)
                    return; // finished a member's brace body (e.g. a constructor) — member boundary
                continue;
            }
            if (kind === "semicolon" && depth === 0) {
                this.parser.state.next();
                return;
            }
            this.parser.state.next();
        }
    }

    parseCharValue(text: string): number {
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

    makeSpan(start: Span): Span {
        const last = this.parser.state.lastToken?.span ?? this.parser.state.peek().span;
        return { start: start.start, end: last.end, line: start.line, column: start.column };
    }
}
