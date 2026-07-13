
import type { PreprocessorInternals } from "./preprocessor-context";

export function readIdentAt(context: PreprocessorInternals, text: string, start: number): string {
    let ident = "";
    let cursor = start;
    while (cursor < text.length &&
        (context.isIdStart(text[cursor]) ||
            (cursor > start && text[cursor] >= "0" && text[cursor] <= "9"))) {
        ident += text[cursor];
        cursor++;
    }
    return ident;
}

export function isIdStart(context: PreprocessorInternals, ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

export function readIdentifier(context: PreprocessorInternals): string {
    let ident = "";
    while (context.pos < context.input.length && context.isIdContinue(context.input[context.pos])) {
        ident += context.input[context.pos];
        context.pos++;
    }
    return ident;
}

export function isIdContinue(context: PreprocessorInternals, ch: string): boolean {
    return context.isIdStart(ch) || (ch >= "0" && ch <= "9");
}

export function peek(context: PreprocessorInternals, offset: number): string {
    const index = context.pos + offset;
    if (index >= context.input.length) {
        return "\0";
    }
    return context.input[index];
}

export function skipWhitespace(context: PreprocessorInternals): void {
    while (context.pos < context.input.length &&
        (context.input[context.pos] === " " || context.input[context.pos] === "\t")) {
        context.pos++;
    }
}

export function skipWhitespaceAndNewlines(context: PreprocessorInternals): void {
    while (context.pos < context.input.length &&
        (context.input[context.pos] === " " ||
            context.input[context.pos] === "\t" ||
            context.input[context.pos] === "\n" ||
            context.input[context.pos] === "\r")) {
        if (context.input[context.pos] === "\n") {
            context.line++;
            context.result += "\n";
        }
        context.pos++;
    }
}

export function readToNewline(context: PreprocessorInternals): string {
    let text = "";
    while (context.pos < context.input.length && context.input[context.pos] !== "\n") {
        // Handle backslash-newline continuation
        if (context.input[context.pos] === "\\" && context.peek(1) === "\n") {
            context.pos += 2;
            context.line++;
            continue;
        }
        text += context.input[context.pos];
        context.pos++;
    }
    if (context.input[context.pos] === "\n") {
        context.pos++;
        context.line++;
    }
    return text.trim();
}

export function skipToNewline(context: PreprocessorInternals): void {
    while (context.pos < context.input.length && context.input[context.pos] !== "\n") {
        context.pos++;
    }
    if (context.input[context.pos] === "\n") {
        context.pos++;
        context.line++;
    }
}

export function readUntil(context: PreprocessorInternals, stop: string): string {
    let text = "";
    while (context.pos < context.input.length &&
        context.input[context.pos] !== stop &&
        context.input[context.pos] !== "\n") {
        text += context.input[context.pos];
        context.pos++;
    }
    return text;
}

export function skipLineComment(context: PreprocessorInternals): void {
    while (context.pos < context.input.length && context.input[context.pos] !== "\n") {
        context.pos++;
    }
}

export function skipBlockComment(context: PreprocessorInternals): void {
    context.pos += 2; // skip /*
    while (context.pos < context.input.length) {
        if (context.input[context.pos] === "\n") {
            context.result += "\n";
            context.line++;
            context.pos++;
        }
        else if (context.input[context.pos] === "*" && context.peek(1) === "/") {
            context.pos += 2; // skip */
            return;
        }
        else {
            context.pos++;
        }
    }
}

export function escapeRegex(context: PreprocessorInternals, text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
