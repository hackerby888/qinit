
import type { MacroDef, PreprocessorInternals } from "./preprocessor-context";

export function tryExpandMacro(context: PreprocessorInternals, name: string): string | null {
    // __LINE__ special case
    if (name === "__LINE__") {
        return String(context.line);
    }
    const def = context.defines.get(name);
    if (!def) {
        return null;
    }
    // Object-like macro
    if (def.params === null) {
        if (context.expanding.has(name)) {
            return name; // recursion guard
        }
        // Body might have parameter references from outer scope — no args to bind.
        return context.expandBody(def, []);
    }
    // Function-like macro — need to read arguments
    const savePos = context.pos;
    const saveLine = context.line;
    // Expect opening paren
    context.skipWhitespaceAndNewlines();
    if (context.peek(0) !== "(") {
        context.pos = savePos;
        context.line = saveLine;
        return null; // not invoked as function-like macro
    }
    context.pos++; // skip (
    // Read arguments
    const callArguments: string[] = [];
    let argument = "";
    let depth = 1;
    while (context.pos < context.input.length && depth > 0) {
        const ch = context.input[context.pos];
        if (ch === "(") {
            depth++;
            argument += ch;
            context.pos++;
        }
        else if (ch === ")") {
            depth--;
            if (depth === 0) {
                callArguments.push(argument.trim());
                context.pos++; // skip )
                break;
            }
            argument += ch;
            context.pos++;
        }
        else if (ch === "," && depth === 1) {
            callArguments.push(argument.trim());
            argument = "";
            context.pos++;
        }
        else if (ch === "\n") {
            context.line++;
            argument += ch;
            context.pos++;
        }
        else {
            argument += ch;
            context.pos++;
        }
    }
    if (context.expanding.has(name)) {
        return name; // recursion guard
    }
    return context.expandBody(def, callArguments);
}

export function expandBody(context: PreprocessorInternals, def: MacroDef, callArguments: string[]): string {
    const macroName = def.name;
    context.expanding.add(macroName);
    let result = def.body;
    // Handle # (stringify) FIRST — operates on the original parameter name
    if (def.params && def.params.length > 0) {
        result = context.processStringify(result, callArguments, def);
    }
    // Substitute parameters BEFORE ## pasting — so p##_input with p=Inc becomes Inc##_input, then paste → Inc_input
    if (def.params) {
        for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
            const param = def.params[index];
            result = context.replaceParamInBody(result, param, callArguments[index]);
        }
        if (def.isVarArgs) {
            const extraArgs = callArguments.slice(def.params.length);
            result = result.replace(/__VA_ARGS__/g, extraArgs.join(", "));
        }
    }
    // Handle ## (token paste) AFTER substitution — removes ## and adjacent whitespace
    result = context.processTokenPaste(result);
    // Recursively expand macros in the result
    result = context.expandRecursive(result);
    context.expanding.delete(macroName);
    return result;
}

export function replaceParamInBody(context: PreprocessorInternals, body: string, param: string, value: string): string {
    // Replace `param` with `value` when it's a standalone word or adjacent to ##
    const escaped = context.escapeRegex(param);
    // Allow param preceded/followed by ## or non-word chars
    let result = body;
    // Replace param that's a standalone word (with optional ## on either side)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"), value);
    // Also handle param## → value## (param before ##)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}##`, "g"), value + "##");
    return result;
}

export function processTokenPaste(context: PreprocessorInternals, body: string): string {
    // Replace `a ## b` with `ab` (remove whitespace + ##)
    let result = "";
    let index = 0;
    while (index < body.length) {
        if (body[index] === "#" && body[index + 1] === "#") {
            // Found ## — trim trailing whitespace from result and skip leading whitespace after ##
            result = result.replace(/\s+$/, "");
            index += 2;
            while (index < body.length && (body[index] === " " || body[index] === "\t")) {
                index++;
            }
            continue;
        }
        result += body[index];
        index++;
    }
    return result;
}

export function processStringify(context: PreprocessorInternals, body: string, callArguments: string[], def: MacroDef): string {
    let result = body;
    if (def.params) {
        for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
            const param = def.params[index];
            // #param but not ##param
            result = result.replace(new RegExp(`(?<!#)#${context.escapeRegex(param)}\\b`, "g"), `"${callArguments[index].replace(/"/g, '\\"')}"`);
        }
    }
    return result;
}

export function replaceParam(context: PreprocessorInternals, body: string, param: string, value: string): string {
    // Replace occurrences of param that are NOT part of a larger identifier or following #/##
    const escaped = context.escapeRegex(param);
    return body.replace(new RegExp(`(?<![#\\w])${escaped}(?!\\w)`, "g"), value);
}

export function readArgsFromString(context: PreprocessorInternals, text: string, openIdx: number): {
    callArguments: string[];
    end: number;
} | null {
    if (text[openIdx] !== "(")
        return null;
    const callArguments: string[] = [];
    let argument = "";
    let depth = 0;
    for (let textItemIndex = openIdx; textItemIndex < text.length; textItemIndex++) {
        const ch = text[textItemIndex];
        if (ch === "(") {
            depth++;
            if (depth === 1)
                continue;
            argument += ch;
        }
        else if (ch === ")") {
            depth--;
            if (depth === 0) {
                callArguments.push(argument.trim());
                return { callArguments, end: textItemIndex + 1 };
            }
            argument += ch;
        }
        else if (ch === "," && depth === 1) {
            callArguments.push(argument.trim());
            argument = "";
        }
        else {
            argument += ch;
        }
    }
    return null;
}

export function expandRecursive(context: PreprocessorInternals, text: string): string {
    // Rescan expanded text to expand nested macro references.
    let result = text;
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        let expanded = "";
        // Simple identifier scanning within the result text
        for (let resultItemIndex = 0; resultItemIndex < result.length; resultItemIndex++) {
            const ch = result[resultItemIndex];
            if (context.isIdStart(ch)) {
                const ident = context.readIdentAt(result, resultItemIndex);
                const def = context.defines.get(ident);
                if (def && def.params === null && !context.expanding.has(ident)) {
                    // Object-like macro
                    context.expanding.add(ident);
                    expanded += context.expandBody(def, []);
                    context.expanding.delete(ident);
                    resultItemIndex += ident.length - 1;
                    changed = true;
                }
                else if (def && def.params !== null && !context.expanding.has(ident)) {
                    // Function-like macro — expand only if actually invoked (an open paren follows). A macro body
                    let nestedIndex = resultItemIndex + ident.length;
                    while (nestedIndex < result.length &&
                        (result[nestedIndex] === " " || result[nestedIndex] === "\t" || result[nestedIndex] === "\n"))
                        nestedIndex++;
                    const parsed = result[nestedIndex] === "(" ? context.readArgsFromString(result, nestedIndex) : null;
                    if (parsed) {
                        context.expanding.add(ident);
                        expanded += context.expandBody(def, parsed.callArguments);
                        context.expanding.delete(ident);
                        resultItemIndex = parsed.end - 1;
                        changed = true;
                    }
                    else {
                        expanded += ident;
                        resultItemIndex += ident.length - 1;
                    }
                }
                else {
                    expanded += ident;
                    resultItemIndex += ident.length - 1;
                }
            }
            else {
                expanded += ch;
            }
        }
        result = expanded;
        if (!changed) {
            break;
        }
    }
    return result;
}
