import { TYPE_COMPOUNDS } from "./keywords";
import type { Lexer } from "./lexer";
import type { Token } from "./tokens";

export function collapseTypeKeywords(lexer: Lexer): void {
    const result: Token[] = [];
    let index = 0;
    while (index < lexer.tokens.length) {
        let collapsed = false;
        for (const [seq, compound] of TYPE_COMPOUNDS) {
            let match = true;
            for (let seqItemIndex = 0; seqItemIndex < seq.length; seqItemIndex++) {
                if (index + seqItemIndex >= lexer.tokens.length || lexer.tokens[index + seqItemIndex].kind !== seq[seqItemIndex]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                const startTok = lexer.tokens[index];
                const endTok = lexer.tokens[index + seq.length - 1];
                const text = lexer.tokens
                    .slice(index, index + seq.length)
                    .map((token) => token.text)
                    .join(" ");
                result.push({
                    kind: compound,
                    text,
                    span: {
                        start: startTok.span.start,
                        end: endTok.span.end,
                        line: startTok.span.line,
                        column: startTok.span.column,
                    },
                });
                index += seq.length;
                collapsed = true;
                break;
            }
        }
        if (!collapsed) {
            result.push(lexer.tokens[index]);
            index++;
        }
    }
    lexer.tokens = result;
    lexer.index = 0;
}
