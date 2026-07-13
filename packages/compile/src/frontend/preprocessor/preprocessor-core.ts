
import type { MacroDef, PreprocessOptions, PreprocessorInternals } from "./preprocessor-context";

export function condActive(context: PreprocessorInternals): boolean {
    for (const condStackItem of context.condStack) {
        if (!condStackItem.active)
            return false;
    }
    return true;
}

export function getDefines(context: PreprocessorInternals): Map<string, MacroDef> {
    return new Map(context.defines);
}

export function preprocess(context: PreprocessorInternals, options: PreprocessOptions): string {
    context.defines.clear();
    context.condStack = [];
    if (options.seedMacros) {
        for (const [k, v] of options.seedMacros)
            context.defines.set(k, v);
    }
    // Built-in defines
    context.define("__LINE__", "__LINE__"); // special-cased during expansion
    context.define("LITE_WASM_TU_BUILD", "");
    context.define("LITEDYN_CONTRACT_TU", "");
    // Contract-specific defines
    context.define("CONTRACT_INDEX", String(options.contractIndex));
    context.define(`${options.contractName}_CONTRACT_INDEX`, String(options.contractIndex));
    context.define("CONTRACT_STATE_TYPE", options.contractName);
    context.define("CONTRACT_STATE2_TYPE", `${options.contractName}2`);
    // Assemble full input: qpi.h + callee prelude + contract source
    let fullSource = options.qpiHeader;
    if (options.calleePrelude) {
        fullSource += "\n" + options.calleePrelude + "\n";
    }
    fullSource += "\n" + options.source;
    // Build line offset map
    context.buildLineMap(fullSource);
    return context.process(fullSource);
}

export function define(context: PreprocessorInternals, name: string, body: string): void {
    // Parse function-like: NAME(args) body
    const member = name.match(/^(\w+)\(([^)]*)\)$/);
    if (member) {
        const macroName = member[1];
        const paramStr = member[2].trim();
        const params = paramStr ? paramStr.split(",").map((text) => text.trim()) : [];
        const isVarArgs = paramStr.endsWith("...");
        context.defines.set(macroName, { name: macroName, params, body, isVarArgs });
        return;
    }
    context.defines.set(name, { name, params: null, body, isVarArgs: false });
}

export function buildLineMap(context: PreprocessorInternals, src: string): void {
    context.srcLine = [0];
    for (let srcItemIndex = 0; srcItemIndex < src.length; srcItemIndex++) {
        if (src[srcItemIndex] === "\n") {
            context.srcLine.push(srcItemIndex + 1);
        }
    }
}

export function process(context: PreprocessorInternals, src: string): string {
    // Normalize CRLF/CR → LF so backslash line-continuations (`\` + CRLF) in multi-line macro definitions join correctly — core-lite
    context.input = src.replace(/\r\n?/g, "\n");
    context.pos = 0;
    context.line = 1;
    context.result = "";
    context.expanding.clear();
    while (context.pos < context.input.length) {
        const ch = context.input[context.pos];
        // Line directives
        if (ch === "#") {
            context.handleDirective();
            continue;
        }
        // Whitespace — pass through but track newlines
        if (ch === "\n") {
            context.result += ch;
            context.line++;
            context.pos++;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\r") {
            context.result += ch;
            context.pos++;
            continue;
        }
        // Comment stripping
        if (ch === "/" && context.peek(1) === "/") {
            context.skipLineComment();
            continue;
        }
        if (ch === "/" && context.peek(1) === "*") {
            context.skipBlockComment();
            continue;
        }
        // Inside an inactive conditional branch: consume text without emitting/expanding.
        if (!context.condActive()) {
            if (ch === "\n") {
                context.result += "\n";
                context.line++;
            }
            context.pos++;
            continue;
        }
        // Identifier — check for macro expansion
        if (context.isIdStart(ch)) {
            const ident = context.readIdentifier();
            const expanded = context.tryExpandMacro(ident);
            if (expanded !== null) {
                context.result += expanded;
            }
            else {
                context.result += ident;
            }
            continue;
        }
        // Pass through everything else
        context.result += ch;
        context.pos++;
    }
    return context.result;
}
