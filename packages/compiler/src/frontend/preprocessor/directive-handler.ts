import type { Preprocessor } from "./preprocessor";

export function handleDirective(preprocessor: Preprocessor): void {
    preprocessor.pos++; // skip #
    // Skip whitespace after #
    preprocessor.skipWhitespace();
    const directive = preprocessor.readIdentifier();
    // Conditional directives are always processed (to keep the stack balanced), even when inactive.
    switch (directive) {
        case "if":
            preprocessor.pushCond(preprocessor.evalIfCondition());
            return;
        case "ifdef": {
            const name = preprocessor.readDirectiveWord();
            preprocessor.skipToNewline();
            preprocessor.pushCond(preprocessor.defines.has(name));
            return;
        }
        case "ifndef": {
            const name = preprocessor.readDirectiveWord();
            preprocessor.skipToNewline();
            preprocessor.pushCond(!preprocessor.defines.has(name));
            return;
        }
        case "elif": {
            const condition =
                preprocessor.condStack.length > 0 &&
                !preprocessor.condStack[preprocessor.condStack.length - 1].taken
                    ? preprocessor.evalIfCondition()
                    : (preprocessor.skipToNewline(), false);
            preprocessor.applyElif(condition);
            return;
        }
        case "else":
            preprocessor.skipToNewline();
            preprocessor.applyElse();
            return;
        case "endif":
            preprocessor.skipToNewline();
            preprocessor.condStack.pop();
            return;
    }
    // Non-conditional directives only act in an active branch.
    if (!preprocessor.condActive()) {
        preprocessor.skipToNewline();
        return;
    }
    switch (directive) {
        case "include":
            preprocessor.handleInclude();
            break;
        case "define":
            preprocessor.handleDefine();
            break;
        case "undef":
            preprocessor.handleUndef();
            break;
        case "pragma":
            preprocessor.handlePragma();
            break;
        case "error":
            preprocessor.skipToNewline();
            break;
        default:
            preprocessor.skipToNewline();
            break;
    }
}

export function pushCond(preprocessor: Preprocessor, condition: boolean): void {
    const parentActive = preprocessor.condActive();
    preprocessor.condStack.push({
        active: parentActive && condition,
        taken: parentActive && condition,
        parentActive,
    });
}

export function applyElif(preprocessor: Preprocessor, condition: boolean): void {
    const condStackItem = preprocessor.condStack[preprocessor.condStack.length - 1];
    if (!condStackItem) return;
    if (condStackItem.taken) {
        condStackItem.active = false;
    } else {
        condStackItem.active = condStackItem.parentActive && condition;
        if (condStackItem.active) condStackItem.taken = true;
    }
}

export function applyElse(preprocessor: Preprocessor): void {
    const condStackItem = preprocessor.condStack[preprocessor.condStack.length - 1];
    if (!condStackItem) return;
    condStackItem.active = condStackItem.parentActive && !condStackItem.taken;
    condStackItem.taken = true;
}

export function readDirectiveWord(preprocessor: Preprocessor): string {
    preprocessor.skipWhitespace();
    return preprocessor.readIdentifier();
}

export function handleInclude(preprocessor: Preprocessor): void {
    preprocessor.skipWhitespace();
    const ch = preprocessor.input[preprocessor.pos];
    let filename = "";
    if (ch === '"') {
        preprocessor.pos++; // skip opening "
        while (
            preprocessor.pos < preprocessor.input.length &&
            preprocessor.input[preprocessor.pos] !== '"' &&
            preprocessor.input[preprocessor.pos] !== "\n"
        ) {
            filename += preprocessor.input[preprocessor.pos];
            preprocessor.pos++;
        }
        if (preprocessor.input[preprocessor.pos] === '"') {
            preprocessor.pos++; // skip closing "
        }
        preprocessor.skipToNewline();
    } else if (ch === "<") {
        preprocessor.pos++; // skip opening <
        while (
            preprocessor.pos < preprocessor.input.length &&
            preprocessor.input[preprocessor.pos] !== ">" &&
            preprocessor.input[preprocessor.pos] !== "\n"
        ) {
            filename += preprocessor.input[preprocessor.pos];
            preprocessor.pos++;
        }
        if (preprocessor.input[preprocessor.pos] === ">") {
            preprocessor.pos++; // skip closing >
        }
        preprocessor.skipToNewline();
    } else {
        preprocessor.skipToNewline();
    }
    // #include directives in preprocessed source are no-ops (qpi.h is already embedded).
    preprocessor.result += "\n";
}

export function handleDefine(preprocessor: Preprocessor): void {
    preprocessor.skipWhitespace();
    const name = preprocessor.readIdentifier();
    if (!name) {
        preprocessor.skipToNewline();
        return;
    }
    // Check for function-like macro: NAME(...)
    let params: string[] | null = null;
    let isVarArgs = false;
    if (preprocessor.peek(0) === "(") {
        preprocessor.pos++; // skip (
        preprocessor.skipWhitespace();
        const paramStr = preprocessor.readUntil(")");
        preprocessor.pos++; // skip )
        if (paramStr === "...") {
            params = [];
            isVarArgs = true;
        } else if (paramStr.endsWith("...")) {
            params = paramStr
                .replace("...", "")
                .split(",")
                .map((text) => text.trim())
                .filter(Boolean);
            isVarArgs = true;
        } else if (paramStr.trim()) {
            params = paramStr.split(",").map((text) => text.trim());
        } else {
            params = [];
        }
    }
    preprocessor.skipWhitespace();
    const body = preprocessor.readToNewline();
    preprocessor.defines.set(name, { name, params, body, isVarArgs });
    // Directive is consumed — don't add to output
}

export function handleUndef(preprocessor: Preprocessor): void {
    preprocessor.skipWhitespace();
    const name = preprocessor.readIdentifier();
    if (name) {
        preprocessor.defines.delete(name);
    }
    preprocessor.skipToNewline();
}

export function handlePragma(preprocessor: Preprocessor): void {
    preprocessor.skipWhitespace();
    const pragma = preprocessor.readIdentifier();
    // Ignore #pragma once; include ownership stays with the caller.
    if (pragma === "once") {
        preprocessor.skipToNewline();
    } else {
        const rest = preprocessor.readToNewline();
        preprocessor.result += `// #pragma ${pragma} ${rest}\n`;
    }
}
