import type { Preprocessor } from "./preprocessor";
import type { MacroDef, PreprocessOptions } from "./preprocessor-context";

export function condActive(preprocessor: Preprocessor): boolean {
    for (const condStackItem of preprocessor.condStack) {
        if (!condStackItem.active) return false;
    }
    return true;
}

export function getDefines(preprocessor: Preprocessor): Map<string, MacroDef> {
    return new Map(preprocessor.defines);
}

export function preprocess(preprocessor: Preprocessor, options: PreprocessOptions): string {
    preprocessor.defines.clear();
    preprocessor.condStack = [];
    preprocessor.expandMacros = options.expandMacros !== false;
    preprocessor.preserveSourceOffsets = options.preserveSourceOffsets === true;
    if (options.seedMacros) {
        for (const [k, v] of options.seedMacros) preprocessor.defines.set(k, v);
    }
    // Built-in defines
    preprocessor.define("__LINE__", "__LINE__"); // special-cased during expansion
    preprocessor.define("LITE_WASM_TU_BUILD", "");
    preprocessor.define("LITEDYN_CONTRACT_TU", "");
    // Contract-specific defines
    preprocessor.define("CONTRACT_INDEX", String(options.contractIndex));
    preprocessor.define(`${options.contractName}_CONTRACT_INDEX`, String(options.contractIndex));
    preprocessor.define("CONTRACT_STATE_TYPE", options.contractName);
    preprocessor.define("CONTRACT_STATE2_TYPE", `${options.contractName}2`);
    // Assemble full input: qpi.h + callee prelude + contract source
    let fullSource = options.qpiHeader;
    if (options.calleePrelude) {
        fullSource += "\n" + options.calleePrelude + "\n";
    }
    fullSource += "\n" + options.source;
    // Build line offset map
    preprocessor.buildLineMap(fullSource);
    return preprocessor.process(fullSource);
}

export function define(preprocessor: Preprocessor, name: string, body: string): void {
    // Parse function-like: NAME(args) body
    const member = name.match(/^(\w+)\(([^)]*)\)$/);
    if (member) {
        const macroName = member[1];
        const paramStr = member[2].trim();
        const params = paramStr ? paramStr.split(",").map((text) => text.trim()) : [];
        const isVarArgs = paramStr.endsWith("...");
        preprocessor.defines.set(macroName, { name: macroName, params, body, isVarArgs });
        return;
    }
    preprocessor.defines.set(name, { name, params: null, body, isVarArgs: false });
}

export function buildLineMap(preprocessor: Preprocessor, src: string): void {
    preprocessor.srcLine = [0];
    for (let srcItemIndex = 0; srcItemIndex < src.length; srcItemIndex++) {
        if (src[srcItemIndex] === "\n") {
            preprocessor.srcLine.push(srcItemIndex + 1);
        }
    }
}

export function process(preprocessor: Preprocessor, src: string): string {
    // Normalize line endings before joining backslash continuations.
    preprocessor.input = preprocessor.preserveSourceOffsets ? src : src.replace(/\r\n?/g, "\n");
    preprocessor.pos = 0;
    preprocessor.line = 1;
    preprocessor.result = "";
    preprocessor.expanding.clear();
    while (preprocessor.pos < preprocessor.input.length) {
        const ch = preprocessor.input[preprocessor.pos];
        // Line directives
        if (ch === "#") {
            const start = preprocessor.pos;
            const resultLength = preprocessor.result.length;
            preprocessor.handleDirective();
            if (preprocessor.preserveSourceOffsets) {
                preprocessor.result = preprocessor.result.slice(0, resultLength);
                preprocessor.result += maskSource(preprocessor.input.slice(start, preprocessor.pos));
            }
            continue;
        }
        // Whitespace — pass through but track newlines
        if (ch === "\n") {
            preprocessor.result += ch;
            preprocessor.line++;
            preprocessor.pos++;
            continue;
        }
        if (ch === " " || ch === "\t" || ch === "\r") {
            preprocessor.result += ch;
            preprocessor.pos++;
            continue;
        }
        // Comment stripping
        if (ch === "/" && preprocessor.peekChar(1) === "/") {
            const start = preprocessor.pos;
            preprocessor.skipLineComment();
            if (preprocessor.preserveSourceOffsets) {
                preprocessor.result += maskSource(preprocessor.input.slice(start, preprocessor.pos));
            }
            continue;
        }
        if (ch === "/" && preprocessor.peekChar(1) === "*") {
            const start = preprocessor.pos;
            const resultLength = preprocessor.result.length;
            preprocessor.skipBlockComment();
            if (preprocessor.preserveSourceOffsets) {
                preprocessor.result = preprocessor.result.slice(0, resultLength);
                preprocessor.result += maskSource(preprocessor.input.slice(start, preprocessor.pos));
            }
            continue;
        }
        // Inside an inactive conditional branch: consume text without emitting/expanding.
        if (!preprocessor.condActive()) {
            if (preprocessor.preserveSourceOffsets) {
                preprocessor.result += " ";
            }
            preprocessor.pos++;
            continue;
        }
        // Identifier — check for macro expansion
        if (preprocessor.isIdStart(ch)) {
            const ident = preprocessor.readIdentifier();
            const expanded = preprocessor.expandMacros ? preprocessor.tryExpandMacro(ident) : null;
            if (expanded !== null) {
                preprocessor.result += expanded;
            } else {
                preprocessor.result += ident;
            }
            continue;
        }
        // Pass through everything else
        preprocessor.result += ch;
        preprocessor.pos++;
    }
    return preprocessor.result;
}

function maskSource(source: string): string {
    return source.replace(/[^\n]/g, " ");
}
