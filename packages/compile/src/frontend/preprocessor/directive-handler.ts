
import type { PreprocessorInternals } from "./preprocessor-context";

export function handleDirective(context: PreprocessorInternals): void {
    const start = context.pos;
    context.pos++; // skip #
    // Skip whitespace after #
    context.skipWhitespace();
    const directive = context.readIdentifier();
    // Conditional directives are always processed (to keep the stack balanced), even when inactive.
    switch (directive) {
        case "if":
            context.pushCond(context.evalIfCondition());
            return;
        case "ifdef": {
            const name = context.readDirectiveWord();
            context.skipToNewline();
            context.pushCond(context.defines.has(name));
            return;
        }
        case "ifndef": {
            const name = context.readDirectiveWord();
            context.skipToNewline();
            context.pushCond(!context.defines.has(name));
            return;
        }
        case "elif": {
            const condition = context.condStack.length > 0 && !context.condStack[context.condStack.length - 1].taken
                ? context.evalIfCondition()
                : (context.skipToNewline(), false);
            context.applyElif(condition);
            return;
        }
        case "else":
            context.skipToNewline();
            context.applyElse();
            return;
        case "endif":
            context.skipToNewline();
            context.condStack.pop();
            return;
    }
    // Non-conditional directives only act in an active branch.
    if (!context.condActive()) {
        context.skipToNewline();
        return;
    }
    switch (directive) {
        case "include":
            context.handleInclude();
            break;
        case "define":
            context.handleDefine();
            break;
        case "undef":
            context.handleUndef();
            break;
        case "pragma":
            context.handlePragma();
            break;
        case "error":
            context.skipToNewline();
            break;
        default:
            context.skipToNewline();
            break;
    }
}

export function pushCond(context: PreprocessorInternals, condition: boolean): void {
    const parentActive = context.condActive();
    context.condStack.push({
        active: parentActive && condition,
        taken: parentActive && condition,
        parentActive,
    });
}

export function applyElif(context: PreprocessorInternals, condition: boolean): void {
    const condStackItem = context.condStack[context.condStack.length - 1];
    if (!condStackItem)
        return;
    if (condStackItem.taken) {
        condStackItem.active = false;
    }
    else {
        condStackItem.active = condStackItem.parentActive && condition;
        if (condStackItem.active)
            condStackItem.taken = true;
    }
}

export function applyElse(context: PreprocessorInternals): void {
    const condStackItem = context.condStack[context.condStack.length - 1];
    if (!condStackItem)
        return;
    condStackItem.active = condStackItem.parentActive && !condStackItem.taken;
    condStackItem.taken = true;
}

export function readDirectiveWord(context: PreprocessorInternals): string {
    context.skipWhitespace();
    return context.readIdentifier();
}

export function handleInclude(context: PreprocessorInternals): void {
    context.skipWhitespace();
    const ch = context.input[context.pos];
    let filename = "";
    if (ch === '"') {
        context.pos++; // skip opening "
        while (context.pos < context.input.length &&
            context.input[context.pos] !== '"' &&
            context.input[context.pos] !== "\n") {
            filename += context.input[context.pos];
            context.pos++;
        }
        if (context.input[context.pos] === '"') {
            context.pos++; // skip closing "
        }
        context.skipToNewline();
    }
    else if (ch === "<") {
        context.pos++; // skip opening <
        while (context.pos < context.input.length &&
            context.input[context.pos] !== ">" &&
            context.input[context.pos] !== "\n") {
            filename += context.input[context.pos];
            context.pos++;
        }
        if (context.input[context.pos] === ">") {
            context.pos++; // skip closing >
        }
        context.skipToNewline();
    }
    else {
        context.skipToNewline();
    }
    // #include directives in preprocessed source are no-ops (qpi.h is already embedded).
    context.result += "\n";
}

export function handleDefine(context: PreprocessorInternals): void {
    context.skipWhitespace();
    const name = context.readIdentifier();
    if (!name) {
        context.skipToNewline();
        return;
    }
    // Check for function-like macro: NAME(...)
    let params: string[] | null = null;
    let isVarArgs = false;
    if (context.peek(0) === "(") {
        context.pos++; // skip (
        context.skipWhitespace();
        const paramStr = context.readUntil(")");
        context.pos++; // skip )
        if (paramStr === "...") {
            params = [];
            isVarArgs = true;
        }
        else if (paramStr.endsWith("...")) {
            params = paramStr
                .replace("...", "")
                .split(",")
                .map((text) => text.trim())
                .filter(Boolean);
            isVarArgs = true;
        }
        else if (paramStr.trim()) {
            params = paramStr.split(",").map((text) => text.trim());
        }
        else {
            params = [];
        }
    }
    context.skipWhitespace();
    const body = context.readToNewline();
    context.defines.set(name, { name, params, body, isVarArgs });
    // Directive is consumed — don't add to output
}

export function handleUndef(context: PreprocessorInternals): void {
    context.skipWhitespace();
    const name = context.readIdentifier();
    if (name) {
        context.defines.delete(name);
    }
    context.skipToNewline();
}

export function handlePragma(context: PreprocessorInternals): void {
    context.skipWhitespace();
    const pragma = context.readIdentifier();
    // Ignore #pragma once; include ownership stays with the caller.
    if (pragma === "once") {
        context.skipToNewline();
    }
    else {
        const rest = context.readToNewline();
        context.result += `// #pragma ${pragma} ${rest}\n`;
    }
}
