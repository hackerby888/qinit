import type { Preprocessor } from "./preprocessor";
import type { MacroDef } from "./preprocessor-context";

export function tryExpandMacro(preprocessor: Preprocessor, name: string): string | null {
    // __LINE__ special case
    if (name === "__LINE__") {
        return String(preprocessor.line);
    }
    const def = preprocessor.defines.get(name);
    if (!def) {
        return null;
    }
    // Object-like macro
    if (def.params === null) {
        if (preprocessor.expanding.has(name)) {
            return name; // recursion guard
        }
        // Body might have parameter references from outer scope — no args to bind.
        return preprocessor.expandBody(def, []);
    }
    // Function-like macro — need to read arguments
    const savePos = preprocessor.pos;
    const saveLine = preprocessor.line;
    // Expect opening paren
    preprocessor.skipWhitespaceAndNewlines();
    if (preprocessor.peek(0) !== "(") {
        preprocessor.pos = savePos;
        preprocessor.line = saveLine;
        return null; // not invoked as function-like macro
    }
    preprocessor.pos++; // skip (
    // Read arguments
    const callArguments: string[] = [];
    let argument = "";
    let depth = 1;
    while (preprocessor.pos < preprocessor.input.length && depth > 0) {
        const ch = preprocessor.input[preprocessor.pos];
        if (ch === "(") {
            depth++;
            argument += ch;
            preprocessor.pos++;
        } else if (ch === ")") {
            depth--;
            if (depth === 0) {
                callArguments.push(argument.trim());
                preprocessor.pos++; // skip )
                break;
            }
            argument += ch;
            preprocessor.pos++;
        } else if (ch === "," && depth === 1) {
            callArguments.push(argument.trim());
            argument = "";
            preprocessor.pos++;
        } else if (ch === "\n") {
            preprocessor.line++;
            argument += ch;
            preprocessor.pos++;
        } else {
            argument += ch;
            preprocessor.pos++;
        }
    }
    if (preprocessor.expanding.has(name)) {
        return name; // recursion guard
    }
    return preprocessor.expandBody(def, callArguments);
}

export function expandBody(preprocessor: Preprocessor, def: MacroDef, callArguments: string[]): string {
    const macroName = def.name;
    preprocessor.expanding.add(macroName);
    let result = def.body;
    // Handle # (stringify) FIRST — operates on the original parameter name
    if (def.params && def.params.length > 0) {
        result = preprocessor.processStringify(result, callArguments, def);
    }
    // Substitute parameters BEFORE ## pasting — so p##_input with p=Inc becomes Inc##_input, then paste → Inc_input
    if (def.params) {
        for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
            const param = def.params[index];
            result = preprocessor.replaceParamInBody(result, param, callArguments[index]);
        }
        if (def.isVarArgs) {
            const extraArgs = callArguments.slice(def.params.length);
            result = result.replace(/__VA_ARGS__/g, extraArgs.join(", "));
        }
    }
    // Handle ## (token paste) AFTER substitution — removes ## and adjacent whitespace
    result = preprocessor.processTokenPaste(result);
    // Recursively expand macros in the result
    result = preprocessor.expandRecursive(result);
    preprocessor.expanding.delete(macroName);
    return result;
}

export function replaceParamInBody(preprocessor: Preprocessor, body: string, param: string, value: string): string {
    // Replace `param` with `value` when it's a standalone word or adjacent to ##
    const escaped = preprocessor.escapeRegex(param);
    // Allow param preceded/followed by ## or non-word chars
    let result = body;
    // Replace param that's a standalone word (with optional ## on either side)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}(?![\\w])`, "g"), value);
    // Also handle param## → value## (param before ##)
    result = result.replace(new RegExp(`(?<![\\w])${escaped}##`, "g"), value + "##");
    return result;
}

export function processTokenPaste(body: string): string {
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

export function processStringify(preprocessor: Preprocessor, body: string, callArguments: string[], def: MacroDef): string {
    let result = body;
    if (def.params) {
        for (let index = 0; index < def.params.length && index < callArguments.length; index++) {
            const param = def.params[index];
            // #param but not ##param
            result = result.replace(new RegExp(`(?<!#)#${preprocessor.escapeRegex(param)}\\b`, "g"), `"${callArguments[index].replace(/"/g, '\\"')}"`);
        }
    }
    return result;
}

export function replaceParam(preprocessor: Preprocessor, body: string, param: string, value: string): string {
    // Replace occurrences of param that are NOT part of a larger identifier or following #/##
    const escaped = preprocessor.escapeRegex(param);
    return body.replace(new RegExp(`(?<![#\\w])${escaped}(?!\\w)`, "g"), value);
}

export function readArgsFromString(
    text: string,
    openIdx: number,
): {
    callArguments: string[];
    end: number;
} | null {
    if (text[openIdx] !== "(") return null;
    const callArguments: string[] = [];
    let argument = "";
    let depth = 0;
    for (let textItemIndex = openIdx; textItemIndex < text.length; textItemIndex++) {
        const ch = text[textItemIndex];
        if (ch === "(") {
            depth++;
            if (depth === 1) continue;
            argument += ch;
        } else if (ch === ")") {
            depth--;
            if (depth === 0) {
                callArguments.push(argument.trim());
                return { callArguments, end: textItemIndex + 1 };
            }
            argument += ch;
        } else if (ch === "," && depth === 1) {
            callArguments.push(argument.trim());
            argument = "";
        } else {
            argument += ch;
        }
    }
    return null;
}

export function expandRecursive(preprocessor: Preprocessor, text: string): string {
    // Rescan expanded text to expand nested macro references.
    let result = text;
    for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        let expanded = "";
        // Simple identifier scanning within the result text
        for (let resultItemIndex = 0; resultItemIndex < result.length; resultItemIndex++) {
            const ch = result[resultItemIndex];
            if (preprocessor.isIdStart(ch)) {
                const ident = preprocessor.readIdentAt(result, resultItemIndex);
                const def = preprocessor.defines.get(ident);
                if (def && def.params === null && !preprocessor.expanding.has(ident)) {
                    // Object-like macro
                    preprocessor.expanding.add(ident);
                    expanded += preprocessor.expandBody(def, []);
                    preprocessor.expanding.delete(ident);
                    resultItemIndex += ident.length - 1;
                    changed = true;
                } else if (def && def.params !== null && !preprocessor.expanding.has(ident)) {
                    // Expand function-like macros only when an argument list follows.
                    let nestedIndex = resultItemIndex + ident.length;
                    while (nestedIndex < result.length && (result[nestedIndex] === " " || result[nestedIndex] === "\t" || result[nestedIndex] === "\n"))
                        nestedIndex++;
                    const parsed = result[nestedIndex] === "(" ? preprocessor.readArgsFromString(result, nestedIndex) : null;
                    if (parsed) {
                        preprocessor.expanding.add(ident);
                        expanded += preprocessor.expandBody(def, parsed.callArguments);
                        preprocessor.expanding.delete(ident);
                        resultItemIndex = parsed.end - 1;
                        changed = true;
                    } else {
                        expanded += ident;
                        resultItemIndex += ident.length - 1;
                    }
                } else {
                    expanded += ident;
                    resultItemIndex += ident.length - 1;
                }
            } else {
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
