import { Reader, WasmParseError, error } from "./binary-reader";
import type { ParsedModule } from "./parsed-module";
import { readConstExpression, readGlobalType, readInstruction, readLimits, readTableType, readValueType, readValueTypeVector } from "./instruction-parser";
import type { WasmExternalKind, WasmFunctionSignature } from "./inspection-types";
import { signature } from "./inspection-types";

export function parseTypeSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("type count");
    for (let index = 0; index < count; index++) {
        const at = reader.pos;
        if (reader.byte("function type form") !== 0x60)
            throw new WasmParseError("type is not a function type", at);
        const params = readValueTypeVector(reader, parsed, "parameter");
        const results = readValueTypeVector(reader, parsed, "result");
        if (results.length > 1)
            parsed.features.add("multi-value-results");
        parsed.types.push(signature(params, results));
    }
}

export function typeAt(parsed: ParsedModule, index: number, context: string, offset: number): WasmFunctionSignature {
    const type = parsed.types[index];
    if (!type)
        throw new WasmParseError(`${context} refers to missing type ${index}`, offset);
    return type;
}

export function parseImportSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("import count");
    for (let index = 0; index < count; index++) {
        const module = reader.name("import module");
        const name = reader.name("import name");
        const kindAt = reader.pos;
        const kind = reader.byte("import kind");
        if (kind === 0) {
            const typeIndexAt = reader.pos;
            const typeIndex = reader.u32("import function type index");
            const fnType = typeAt(parsed, typeIndex, `import ${module}.${name}`, typeIndexAt);
            parsed.functionTypeIndices.push(typeIndex);
            parsed.imports.push({ module, name, kind: "function", signature: fnType });
        }
        else if (kind === 1) {
            readTableType(reader, parsed);
            parsed.tableCount++;
            if (parsed.tableCount > 1)
                parsed.features.add("multiple-tables");
            parsed.imports.push({ module, name, kind: "table" });
        }
        else if (kind === 2) {
            const limits = readLimits(reader, parsed, "memory");
            parsed.memories.push({
                source: "imported",
                module,
                name,
                minimumPages: limits.minimum,
                maximumPages: limits.maximum,
                shared: limits.shared,
                memory64: limits.memory64,
            });
            parsed.imports.push({ module, name, kind: "memory" });
        }
        else if (kind === 3) {
            parsed.globals.push(readGlobalType(reader, parsed));
            parsed.imports.push({ module, name, kind: "global" });
        }
        else if (kind === 4) {
            parsed.features.add("exception-handling/tags");
            reader.byte("tag attribute");
            reader.u32("tag type index");
            parsed.imports.push({ module, name, kind: "tag" });
        }
        else {
            throw new WasmParseError(`unknown import kind ${kind}`, kindAt);
        }
    }
}

export function parseFunctionSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("defined function count");
    parsed.definedFunctionCount = count;
    for (let index = 0; index < count; index++) {
        const at = reader.pos;
        const typeIndex = reader.u32("defined function type index");
        typeAt(parsed, typeIndex, "defined function", at);
        parsed.functionTypeIndices.push(typeIndex);
    }
}

export function parseTableSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("table count");
    for (let index = 0; index < count; index++) {
        readTableType(reader, parsed);
        parsed.tableCount++;
    }
    if (parsed.tableCount > 1)
        parsed.features.add("multiple-tables");
}

export function parseMemorySection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("memory count");
    for (let index = 0; index < count; index++) {
        const limits = readLimits(reader, parsed, "memory");
        parsed.memories.push({
            source: "defined",
            minimumPages: limits.minimum,
            maximumPages: limits.maximum,
            shared: limits.shared,
            memory64: limits.memory64,
        });
    }
    if (parsed.memories.length > 1)
        parsed.features.add("multiple-memories");
}

export function parseGlobalSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("global count");
    for (let index = 0; index < count; index++) {
        parsed.globals.push(readGlobalType(reader, parsed));
        readConstExpression(reader, parsed);
    }
}

export function parseExportSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("export count");
    for (let index = 0; index < count; index++) {
        const name = reader.name("export name");
        const kindAt = reader.pos;
        const rawKind = reader.byte("export kind");
        const index = reader.u32("export index");
        const kinds: WasmExternalKind[] = ["function", "table", "memory", "global", "tag"];
        const kind = kinds[rawKind];
        if (!kind)
            throw new WasmParseError(`unknown export kind ${rawKind}`, kindAt);
        if (kind === "tag")
            parsed.features.add("exception-handling/tags");
        if (kind === "function") {
            const typeIndex = parsed.functionTypeIndices[index];
            const fnType = typeIndex === undefined ? undefined : parsed.types[typeIndex];
            parsed.exports.push({ name, kind, index, signature: fnType });
        }
        else {
            parsed.exports.push({ name, kind, index });
        }
    }
}

export function parseElementSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("element segment count");
    for (let index = 0; index < count; index++) {
        const tableOrFlags = reader.u32("element table index/flags");
        if (tableOrFlags !== 0) {
            parsed.features.add("bulk-memory/reference-type-elements");
            reader.skip(reader.remaining, "non-MVP element section");
            return;
        }
        readConstExpression(reader, parsed);
        const fnCount = reader.u32("element function count");
        for (let nestedIndex = 0; nestedIndex < fnCount; nestedIndex++)
            reader.u32("element function index");
    }
}

export function parseCodeSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("code body count");
    if (count !== parsed.definedFunctionCount) {
        error(parsed.diagnostics, "malformed-module", `function section declares ${parsed.definedFunctionCount} bodies but code section has ${count}`);
    }
    for (let index = 0; index < count; index++) {
        const size = reader.u32("function body size");
        const body = reader.subReader(size, "function body");
        const localGroupCount = body.u32("local group count");
        for (let nestedIndex = 0; nestedIndex < localGroupCount; nestedIndex++) {
            body.u32("local count");
            readValueType(body, parsed, "local");
        }
        let lastOpcode = -1;
        let opaque = false;
        while (!body.done) {
            lastOpcode = body.bytes[body.pos];
            if (!readInstruction(body, parsed)) {
                body.skip(body.remaining, "unsupported function body tail");
                opaque = true;
            }
        }
        if (!opaque && lastOpcode !== 0x0b) {
            error(parsed.diagnostics, "malformed-module", `function body ${index} does not end with end`, body.end - 1);
        }
    }
}

export function parseDataSection(reader: Reader, parsed: ParsedModule): void {
    const count = reader.u32("data segment count");
    for (let index = 0; index < count; index++) {
        const memoryOrFlags = reader.u32("data memory index/flags");
        if (memoryOrFlags !== 0) {
            parsed.features.add("bulk-memory/data-segments");
            reader.skip(reader.remaining, "non-MVP data section");
            return;
        }
        readConstExpression(reader, parsed);
        const size = reader.u32("data size");
        reader.skip(size, "data bytes");
    }
}
