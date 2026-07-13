import type { ParsedModule } from "./parsed-module";
import { Reader, WasmParseError, error } from "./binary-reader";
import { parseCodeSection, parseDataSection, parseElementSection, parseExportSection, parseFunctionSection, parseGlobalSection, parseImportSection, parseMemorySection, parseTableSection, parseTypeSection } from "./section-parser";

export function parseModule(bytes: Uint8Array, parsed: ParsedModule): ParsedModule {
    const reader = new Reader(bytes);
    const expectedHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    for (let expectedHeaderItemIndex = 0; expectedHeaderItemIndex < expectedHeader.length; expectedHeaderItemIndex++) {
        if (reader.byte("Wasm header") !== expectedHeader[expectedHeaderItemIndex])
            throw new WasmParseError("invalid Wasm magic or version", expectedHeaderItemIndex);
    }
    const seenSections = new Set<number>();
    while (!reader.done) {
        const sectionAt = reader.pos;
        const id = reader.byte("section id");
        const length = reader.u32("section size");
        const section = reader.subReader(length, `section ${id}`);
        if (id !== 0) {
            if (seenSections.has(id))
                throw new WasmParseError(`duplicate section ${id}`, sectionAt);
            seenSections.add(id);
        }
        switch (id) {
            case 0:
                section.skip(section.remaining, "custom section");
                break;
            case 1:
                parseTypeSection(section, parsed);
                break;
            case 2:
                parseImportSection(section, parsed);
                break;
            case 3:
                parseFunctionSection(section, parsed);
                break;
            case 4:
                parseTableSection(section, parsed);
                break;
            case 5:
                parseMemorySection(section, parsed);
                break;
            case 6:
                parseGlobalSection(section, parsed);
                break;
            case 7:
                parseExportSection(section, parsed);
                break;
            case 8:
                section.u32("start function index");
                break;
            case 9:
                parseElementSection(section, parsed);
                break;
            case 10:
                parseCodeSection(section, parsed);
                break;
            case 11:
                parseDataSection(section, parsed);
                break;
            case 12:
                parsed.features.add("bulk-memory/data-count");
                section.u32("data count");
                break;
            case 13:
                parsed.features.add("exception-handling/tags");
                section.skip(section.remaining, "tag section");
                break;
            default:
                parsed.features.add(`unknown-section-${id}`);
                error(parsed.diagnostics, "unsupported-section", `section ${id} is outside the portable MVP profile`, sectionAt);
                section.skip(section.remaining, "unknown section");
                break;
        }
        if (!section.done)
            throw new WasmParseError(`section ${id} has ${section.remaining} unread bytes`, section.pos);
    }
    return parsed;
}
