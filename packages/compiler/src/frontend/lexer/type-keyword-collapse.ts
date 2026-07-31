import { TYPE_COMPOUNDS } from "./keywords";
import type { LexerInternals } from "./lexer-context";
import type { Token } from "./tokens";

export function collapseTypeKeywords(context: LexerInternals): void {
    const result: Token[] = [];
    let index = 0;
    while (index < context.tokens.length) {
        let collapsed = false;
        for (const [seq, compound] of TYPE_COMPOUNDS) {
            let match = true;
            for (let seqItemIndex = 0; seqItemIndex < seq.length; seqItemIndex++) {
                if (index + seqItemIndex >= context.tokens.length || context.tokens[index + seqItemIndex].kind !== seq[seqItemIndex]) {
                    match = false;
                    break;
                }
            }
            if (match) {
                const startTok = context.tokens[index];
                const endTok = context.tokens[index + seq.length - 1];
                const text = context.tokens
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
            result.push(context.tokens[index]);
            index++;
        }
    }
    context.tokens = result;
    context.index = 0;
}
