import type { Preprocessor } from "./preprocessor";

export function readIdentAt(preprocessor: Preprocessor, text: string, start: number): string {
    let ident = "";
    let cursor = start;
    while (
        cursor < text.length &&
        (preprocessor.isIdStart(text[cursor]) ||
            (cursor > start && text[cursor] >= "0" && text[cursor] <= "9"))
    ) {
        ident += text[cursor];
        cursor++;
    }
    return ident;
}

export function isIdStart(ch: string): boolean {
    return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "_";
}

export function readIdentifier(preprocessor: Preprocessor): string {
    let ident = "";
    while (
        preprocessor.pos < preprocessor.input.length &&
        preprocessor.isIdContinue(preprocessor.input[preprocessor.pos])
    ) {
        ident += preprocessor.input[preprocessor.pos];
        preprocessor.pos++;
    }
    return ident;
}

export function isIdContinue(preprocessor: Preprocessor, ch: string): boolean {
    return preprocessor.isIdStart(ch) || (ch >= "0" && ch <= "9");
}

export function peek(preprocessor: Preprocessor, offset: number): string {
    const index = preprocessor.pos + offset;
    if (index >= preprocessor.input.length) {
        return "\0";
    }
    return preprocessor.input[index];
}

export function skipWhitespace(preprocessor: Preprocessor): void {
    while (
        preprocessor.pos < preprocessor.input.length &&
        (preprocessor.input[preprocessor.pos] === " " ||
            preprocessor.input[preprocessor.pos] === "\t")
    ) {
        preprocessor.pos++;
    }
}

export function skipWhitespaceAndNewlines(preprocessor: Preprocessor): void {
    while (
        preprocessor.pos < preprocessor.input.length &&
        (preprocessor.input[preprocessor.pos] === " " ||
            preprocessor.input[preprocessor.pos] === "\t" ||
            preprocessor.input[preprocessor.pos] === "\n" ||
            preprocessor.input[preprocessor.pos] === "\r")
    ) {
        if (preprocessor.input[preprocessor.pos] === "\n") {
            preprocessor.line++;
            preprocessor.result += "\n";
        }
        preprocessor.pos++;
    }
}

export function readToNewline(preprocessor: Preprocessor): string {
    let text = "";
    while (
        preprocessor.pos < preprocessor.input.length &&
        preprocessor.input[preprocessor.pos] !== "\n"
    ) {
        // Handle backslash-newline continuation
        if (preprocessor.input[preprocessor.pos] === "\\" && preprocessor.peek(1) === "\n") {
            preprocessor.pos += 2;
            preprocessor.line++;
            continue;
        }
        text += preprocessor.input[preprocessor.pos];
        preprocessor.pos++;
    }
    if (preprocessor.input[preprocessor.pos] === "\n") {
        preprocessor.pos++;
        preprocessor.line++;
    }
    return text.trim();
}

export function skipToNewline(preprocessor: Preprocessor): void {
    while (
        preprocessor.pos < preprocessor.input.length &&
        preprocessor.input[preprocessor.pos] !== "\n"
    ) {
        preprocessor.pos++;
    }
    if (preprocessor.input[preprocessor.pos] === "\n") {
        preprocessor.pos++;
        preprocessor.line++;
    }
}

export function readUntil(preprocessor: Preprocessor, stop: string): string {
    let text = "";
    while (
        preprocessor.pos < preprocessor.input.length &&
        preprocessor.input[preprocessor.pos] !== stop &&
        preprocessor.input[preprocessor.pos] !== "\n"
    ) {
        text += preprocessor.input[preprocessor.pos];
        preprocessor.pos++;
    }
    return text;
}

export function skipLineComment(preprocessor: Preprocessor): void {
    while (
        preprocessor.pos < preprocessor.input.length &&
        preprocessor.input[preprocessor.pos] !== "\n"
    ) {
        preprocessor.pos++;
    }
}

export function skipBlockComment(preprocessor: Preprocessor): void {
    preprocessor.pos += 2; // skip /*
    while (preprocessor.pos < preprocessor.input.length) {
        if (preprocessor.input[preprocessor.pos] === "\n") {
            preprocessor.result += "\n";
            preprocessor.line++;
            preprocessor.pos++;
        } else if (preprocessor.input[preprocessor.pos] === "*" && preprocessor.peek(1) === "/") {
            preprocessor.pos += 2; // skip */
            return;
        } else {
            preprocessor.pos++;
        }
    }
}

export function escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
