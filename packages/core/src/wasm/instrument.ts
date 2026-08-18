// Bakes the state-write journal into a compiled contract module: every store that can land in the
// contract state first records the original bytes of the block it is about to overwrite.
//
// The rewrite only appends types, functions, globals and one export, so no existing index moves, and
// it injects no wasm block or loop into user code, so no branch depth changes. A store's `offset` is a
// static immediate, so `i64.store offset=N` becomes `i32.const N` + `call $__q_i64_store` and the
// helper owns the address arithmetic — which is why no function needs extra locals.
import {
    JOURNAL_ENTRY_BYTES,
    JOURNAL_FIRST_GENERATION,
    JOURNAL_FORMAT_VERSION,
    JOURNAL_BLOCK_BYTES,
    JOURNAL_HASH_MULTIPLIER,
    JOURNAL_HEADER_BYTES,
    JOURNAL_MAGIC,
    JOURNAL_OVERFLOW_FLAG,
    JOURNAL_SLOT_BLOCK_OFFSET,
    JOURNAL_SLOT_BYTES,
    JournalHeaderOffset,
} from "./journal";
import {
    ByteReader,
    ByteWriter,
    WASM_MAGIC,
    WasmBinaryError,
    WasmSectionId,
    decodeVector,
    encodeVector,
    joinSections,
    splitSections,
    type WasmSection,
} from "./wasm-binary";
import {
    BULK_MEMORY_COPY,
    BULK_MEMORY_FILL,
    BULK_MEMORY_INIT,
    CodeEmitter,
    Op,
    WasmType,
    encodeFunctionExport,
    encodeFunctionType,
    encodeMutableI32Global,
    type WasmTypeCode,
} from "./wasm-emit";
import { DEFAULT_JOURNAL_CAP_BYTES, JOURNAL_REGION_BYTES } from "./sizing";

export const JOURNAL_RESET_EXPORT = "__q_journal_reset";

interface StoreKind {
    readonly opcode: number;
    readonly valueType: WasmTypeCode;
    readonly bytes: number;
}

const STORE_KINDS: readonly StoreKind[] = [
    { opcode: 0x36, valueType: WasmType.I32, bytes: 4 }, // i32.store
    { opcode: 0x37, valueType: WasmType.I64, bytes: 8 }, // i64.store
    { opcode: 0x38, valueType: WasmType.F32, bytes: 4 }, // f32.store
    { opcode: 0x39, valueType: WasmType.F64, bytes: 8 }, // f64.store
    { opcode: 0x3a, valueType: WasmType.I32, bytes: 1 }, // i32.store8
    { opcode: 0x3b, valueType: WasmType.I32, bytes: 2 }, // i32.store16
    { opcode: 0x3c, valueType: WasmType.I64, bytes: 1 }, // i64.store8
    { opcode: 0x3d, valueType: WasmType.I64, bytes: 2 }, // i64.store16
    { opcode: 0x3e, valueType: WasmType.I64, bytes: 4 }, // i64.store32
];

const STORE_BY_OPCODE = new Map(STORE_KINDS.map((kind) => [kind.opcode, kind]));

const ACCESSOR_EXPORTS = ["state_addr", "state_size", "io_base", "io_size"] as const;

type AccessorName = (typeof ACCESSOR_EXPORTS)[number];

export interface InstrumentOptions {
    /** Journal budget in bytes, before the arena clamp. */
    readonly journalCapBytes?: number;
}

export interface InstrumentResult {
    readonly wasm: Uint8Array<ArrayBuffer>;
    /** Absolute address of the journal in linear memory. */
    readonly journalBase: number;
    readonly journalBytes: number;
    readonly capacityBlocks: number;
    readonly stateSize: number;
    readonly storesInstrumented: number;
    readonly bulkInstrumented: number;
    /**
     * Piecewise map from pristine to instrumented module offsets, ascending by `from`: an offset at or
     * after `from` (and before the next entry) moves by `shift`. A debug line map built from the
     * pristine module is remapped through this, so trap backtraces still symbolize.
     */
    readonly offsetMap: readonly { from: number; shift: number }[];
}

/** Applies an `offsetMap` to a pristine-module code offset. */
export function remapCodeOffset(offsetMap: readonly { from: number; shift: number }[], offset: number): number {
    let shift = 0;
    for (const entry of offsetMap) {
        if (entry.from > offset) {
            break;
        }
        shift = entry.shift;
    }
    return offset + shift;
}

export class InstrumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "InstrumentError";
    }
}

/** Journal capacity in blocks — fixed, so a 1 GB state costs no more journal than an 8-byte one. */
export function capacityBlocksFor(stateSize: number, capBytes: number): number {
    const blocksInState = Math.ceil(stateSize / JOURNAL_BLOCK_BYTES);
    const affordable = Math.floor(capBytes / JOURNAL_ENTRY_BYTES);
    return Math.max(1, Math.min(blocksInState, affordable));
}

/** Probe table size: a power of two, never more than half full, so a free slot always exists. */
export function tableSlotsFor(capacityBlocks: number): number {
    let slots = 1;
    while (slots < capacityBlocks * 2) {
        slots *= 2;
    }
    return slots;
}

export function journalBytesFor(capacityBlocks: number): number {
    return JOURNAL_HEADER_BYTES + tableSlotsFor(capacityBlocks) * JOURNAL_SLOT_BYTES + capacityBlocks * JOURNAL_ENTRY_BYTES;
}

/** Largest block count whose header, probe table and entries all fit the region reserved for them. */
export function capacityFittingRegion(capacityBlocks: number): number {
    let fitted = capacityBlocks;

    while (fitted > 1 && journalBytesFor(fitted) > JOURNAL_REGION_BYTES) {
        const tableBytes = tableSlotsFor(fitted) * JOURNAL_SLOT_BYTES;
        const entryBudget = JOURNAL_REGION_BYTES - JOURNAL_HEADER_BYTES - tableBytes;
        fitted = Math.min(fitted - 1, Math.max(1, Math.floor(entryBudget / JOURNAL_ENTRY_BYTES)));
    }

    return fitted;
}

interface ModuleView {
    readonly sections: WasmSection[];
    readonly types: Uint8Array[];
    readonly importedFunctionCount: number;
    readonly functionTypeIndices: number[];
    readonly globals: Uint8Array[];
    readonly exports: Uint8Array[];
    readonly exportedFunctions: Map<string, number>;
    readonly bodies: Uint8Array[];
}

function sectionOf(sections: readonly WasmSection[], id: number): WasmSection | undefined {
    return sections.find((section) => section.id === id);
}

function readTypeSection(section: WasmSection | undefined): Uint8Array[] {
    if (!section) {
        return [];
    }
    return decodeVector(section.payload, (reader) => {
        if (reader.byte("functype tag") !== 0x60) {
            throw new InstrumentError("type section holds a non-function type");
        }
        const params = reader.u32("param count");
        reader.skip(params, "param types");
        const results = reader.u32("result count");
        reader.skip(results, "result types");
    });
}

function countImportedFunctions(section: WasmSection | undefined): number {
    if (!section) {
        return 0;
    }

    const reader = new ByteReader(section.payload);
    const count = reader.u32("import count");
    let functions = 0;

    for (let index = 0; index < count; index++) {
        reader.name("import module");
        reader.name("import name");
        const kind = reader.byte("import kind");
        if (kind === 0x00) {
            functions++;
            reader.u32("import type index");
        } else if (kind === 0x01) {
            reader.byte("table element type");
            readLimits(reader);
        } else if (kind === 0x02) {
            readLimits(reader);
        } else if (kind === 0x03) {
            reader.byte("global type");
            reader.byte("global mutability");
        } else {
            throw new InstrumentError(`unsupported import kind ${kind}`);
        }
    }

    return functions;
}

function readLimits(reader: ByteReader): void {
    const flags = reader.u32("limits flags");
    reader.u32("limits minimum");
    if ((flags & 0x01) !== 0) {
        reader.u32("limits maximum");
    }
}

function readFunctionSection(section: WasmSection | undefined): number[] {
    if (!section) {
        return [];
    }

    const reader = new ByteReader(section.payload);
    const count = reader.u32("function count");
    const typeIndices: number[] = [];
    for (let index = 0; index < count; index++) {
        typeIndices.push(reader.u32("function type index"));
    }
    return typeIndices;
}

function readGlobalSection(section: WasmSection | undefined): Uint8Array[] {
    if (!section) {
        return [];
    }
    return decodeVector(section.payload, (reader) => {
        reader.byte("global value type");
        reader.byte("global mutability");
        skipConstantExpression(reader);
    });
}

function skipConstantExpression(reader: ByteReader): void {
    for (;;) {
        const opcode = reader.byte("constant expression opcode");
        if (opcode === Op.END) {
            return;
        }
        if (opcode === Op.I32_CONST) {
            reader.i32("i32.const");
        } else if (opcode === 0x42) {
            reader.skipI64("i64.const");
        } else if (opcode === 0x43) {
            reader.skip(4, "f32.const");
        } else if (opcode === 0x44) {
            reader.skip(8, "f64.const");
        } else if (opcode === Op.GLOBAL_GET) {
            reader.u32("global.get index");
        } else {
            throw new InstrumentError(`unsupported constant expression opcode 0x${opcode.toString(16)}`);
        }
    }
}

function readExportSection(section: WasmSection | undefined): { elements: Uint8Array[]; functions: Map<string, number> } {
    if (!section) {
        return { elements: [], functions: new Map() };
    }

    const functions = new Map<string, number>();
    const elements = decodeVector(section.payload, (reader) => {
        const name = reader.name("export name");
        const kind = reader.byte("export kind");
        const index = reader.u32("export index");
        if (kind === 0x00) {
            functions.set(name, index);
        }
    });

    return { elements, functions };
}

function readCodeSection(section: WasmSection | undefined): Uint8Array[] {
    if (!section) {
        return [];
    }

    const reader = new ByteReader(section.payload);
    const count = reader.u32("code body count");
    const bodies: Uint8Array[] = [];

    for (let index = 0; index < count; index++) {
        const start = reader.position;
        const size = reader.u32("function body size");
        reader.skip(size, "function body");
        bodies.push(section.payload.subarray(start, reader.position));
    }

    return bodies;
}

function viewOf(wasm: Uint8Array): ModuleView {
    const sections = splitSections(wasm);
    const exports = readExportSection(sectionOf(sections, WasmSectionId.EXPORT));

    return {
        sections,
        types: readTypeSection(sectionOf(sections, WasmSectionId.TYPE)),
        importedFunctionCount: countImportedFunctions(sectionOf(sections, WasmSectionId.IMPORT)),
        functionTypeIndices: readFunctionSection(sectionOf(sections, WasmSectionId.FUNCTION)),
        globals: readGlobalSection(sectionOf(sections, WasmSectionId.GLOBAL)),
        exports: exports.elements,
        exportedFunctions: exports.functions,
        bodies: readCodeSection(sectionOf(sections, WasmSectionId.CODE)),
    };
}

/** The `i32.const` a constant accessor returns, e.g. `state_size` or `io_size`. */
function constantAccessorValue(view: ModuleView, name: AccessorName): number {
    const functionIndex = view.exportedFunctions.get(name);
    if (functionIndex === undefined) {
        throw new InstrumentError(`module has no '${name}' export`);
    }

    const body = view.bodies[functionIndex - view.importedFunctionCount];
    if (!body) {
        throw new InstrumentError(`'${name}' is an imported function`);
    }

    const reader = new ByteReader(body);
    reader.u32("body size");
    const localGroups = reader.u32("local group count");
    for (let index = 0; index < localGroups; index++) {
        reader.u32("local count");
        reader.byte("local type");
    }

    if (reader.byte("first opcode") !== Op.I32_CONST) {
        throw new InstrumentError(`'${name}' does not begin with i32.const`);
    }
    return reader.i32(`${name} constant`);
}

interface BodyRewrite {
    readonly bytes: Uint8Array;
    readonly stores: number;
    readonly bulk: number;
    /** Positions just after each rewritten site, in old and new body-content coordinates. */
    readonly sites: { oldContentOffset: number; newContentOffset: number }[];
    /** Where the body's content (locals vector onward) starts, past the size LEB. */
    readonly oldContentStart: number;
    readonly newContentStart: number;
}

/**
 * Copies a function body verbatim except at write instructions, which are replaced by a call to the
 * matching helper.
 */
function rewriteBody(body: Uint8Array, helperOf: (opcode: number, bulkOperation?: number) => number): BodyRewrite {
    const reader = new ByteReader(body);
    reader.u32("body size");

    const output = new ByteWriter();
    const localsStart = reader.position;
    const localGroups = reader.u32("local group count");
    for (let index = 0; index < localGroups; index++) {
        reader.u32("local count");
        reader.byte("local type");
    }
    output.bytes(body.subarray(localsStart, reader.position));

    const sites: { oldContentOffset: number; newContentOffset: number }[] = [];
    let stores = 0;
    let bulk = 0;

    while (!reader.done) {
        const instructionStart = reader.position;
        const opcode = reader.byte("opcode");
        const store = STORE_BY_OPCODE.get(opcode);

        if (store) {
            reader.u32("store alignment");
            const offset = reader.u32("store offset");
            output.byte(Op.I32_CONST).i32(offset).byte(Op.CALL).u32(helperOf(opcode));
            sites.push({ oldContentOffset: reader.position - localsStart, newContentOffset: output.length });
            stores++;
            continue;
        }

        if (opcode === Op.PREFIX_FC) {
            const operation = reader.u32("0xfc operation");
            if (operation === BULK_MEMORY_COPY || operation === BULK_MEMORY_FILL) {
                reader.u32("memory index");
                if (operation === BULK_MEMORY_COPY) {
                    reader.u32("source memory index");
                }
                output.byte(Op.CALL).u32(helperOf(opcode, operation));
                sites.push({ oldContentOffset: reader.position - localsStart, newContentOffset: output.length });
                bulk++;
                continue;
            }
            if (operation === BULK_MEMORY_INIT) {
                throw new InstrumentError("memory.init is not instrumented; a data segment could write state unnoticed");
            }
            skipImmediates(reader, opcode, operation);
            output.bytes(body.subarray(instructionStart, reader.position));
            continue;
        }

        skipImmediates(reader, opcode);
        output.bytes(body.subarray(instructionStart, reader.position));
    }

    const encoded = output.toBytes();
    const sizePrefix = new ByteWriter().u32(encoded.length);
    return {
        bytes: sizePrefix.bytes(encoded).toBytes(),
        stores,
        bulk,
        sites,
        oldContentStart: localsStart,
        newContentStart: new ByteWriter().u32(encoded.length).length,
    };
}

/** Advances past an instruction's immediates. Anything outside the portable profile fails loudly. */
function skipImmediates(reader: ByteReader, opcode: number, bulkOperation?: number): void {
    if (opcode === Op.PREFIX_FC) {
        if (bulkOperation !== undefined && bulkOperation <= 7) {
            return;
        }
        if (bulkOperation === 9 || (bulkOperation !== undefined && bulkOperation >= 15 && bulkOperation <= 17)) {
            reader.u32("segment index");
            return;
        }
        if (bulkOperation === 12 || bulkOperation === 14) {
            reader.u32("first index");
            reader.u32("second index");
            return;
        }
        if (bulkOperation === 13) {
            reader.u32("element index");
            return;
        }
        throw new InstrumentError(`unsupported 0xfc operation ${bulkOperation}`);
    }

    switch (opcode) {
        case 0x00:
        case 0x01:
        case Op.ELSE:
        case Op.END:
        case Op.RETURN:
        case Op.DROP:
        case 0x1b:
            return;
        case Op.BLOCK:
        case Op.LOOP:
        case Op.IF:
            skipBlockType(reader);
            return;
        case Op.BR:
        case Op.BR_IF:
        case Op.CALL:
        case Op.LOCAL_GET:
        case Op.LOCAL_SET:
        case Op.LOCAL_TEE:
        case Op.GLOBAL_GET:
        case Op.GLOBAL_SET:
            reader.u32("instruction index");
            return;
        case 0x0e: {
            const count = reader.u32("br_table target count");
            for (let index = 0; index <= count; index++) {
                reader.u32("br_table target");
            }
            return;
        }
        case 0x11:
            reader.u32("call_indirect type index");
            reader.u32("call_indirect table index");
            return;
        case 0x3f:
        case 0x40:
            reader.u32("memory index");
            return;
        case Op.I32_CONST:
            reader.i32("i32.const");
            return;
        case 0x42:
            reader.skipI64("i64.const");
            return;
        case 0x43:
            reader.skip(4, "f32.const");
            return;
        case 0x44:
            reader.skip(8, "f64.const");
            return;
        default:
            if (opcode >= 0x28 && opcode <= 0x3e) {
                reader.u32("memory alignment");
                reader.u32("memory offset");
                return;
            }
            if ((opcode >= 0x45 && opcode <= 0xbf) || (opcode >= 0xc0 && opcode <= 0xc4)) {
                return;
            }
            throw new InstrumentError(`opcode 0x${opcode.toString(16).padStart(2, "0")} is outside the portable profile`);
    }
}

function skipBlockType(reader: ByteReader): void {
    const first = reader.peek();
    if (first === 0x40 || first === WasmType.I32 || first === WasmType.I64 || first === WasmType.F32 || first === WasmType.F64) {
        reader.byte("block type");
        return;
    }
    reader.i32("block type index");
}

/** Appends `element` to a vector section, creating the section in canonical order when absent. */
function upsertVectorSection(sections: WasmSection[], id: number, elements: Uint8Array[]): void {
    const payload = encodeVector(elements);
    const existing = sectionOf(sections, id);
    if (existing) {
        existing.payload = payload;
        return;
    }

    let insertAt = sections.findIndex((section) => section.id !== WasmSectionId.CUSTOM && section.id > id);
    if (insertAt < 0) {
        insertAt = sections.length;
    }
    sections.splice(insertAt, 0, { id, payload });
}

interface HelperLayout {
    readonly initIndex: number;
    readonly resetIndex: number;
    readonly noteIndex: number;
    readonly storeIndex: Map<number, number>;
    readonly copyIndex: number;
    readonly fillIndex: number;
}

/** Bakes the journal into `wasm`. The result runs on any host; one that ignores the journal is unaffected. */
export function instrumentStateJournal(wasm: Uint8Array, options: InstrumentOptions = {}): InstrumentResult {
    const view = viewOf(wasm);

    if (view.bodies.length !== view.functionTypeIndices.length) {
        throw new WasmBinaryError(`function section declares ${view.functionTypeIndices.length} bodies but the code section has ${view.bodies.length}`);
    }

    const stateSize = constantAccessorValue(view, "state_size");
    const ioBase = constantAccessorValue(view, "io_base");
    const ioSize = constantAccessorValue(view, "io_size");

    // The journal sits past what io_size() reports, in memory reserved beside the arena, so the contract
    // keeps every byte of scratch and a host that ignores the journal still sees the region it expects.
    const capBytes = Math.max(JOURNAL_ENTRY_BYTES, options.journalCapBytes ?? DEFAULT_JOURNAL_CAP_BYTES);
    const capacityBlocks = capacityFittingRegion(capacityBlocksFor(stateSize, capBytes));

    const journalBytes = journalBytesFor(capacityBlocks);
    const tableSlots = tableSlotsFor(capacityBlocks);
    const entriesOffset = JOURNAL_HEADER_BYTES + tableSlots * JOURNAL_SLOT_BYTES;

    if (journalBytes > JOURNAL_REGION_BYTES) {
        throw new InstrumentError(`a ${journalBytes}-byte journal exceeds the ${JOURNAL_REGION_BYTES}-byte reserved region`);
    }

    // Instrumenting twice would duplicate the export and double-wrap every store, so it fails loudly
    // rather than producing a module that still validates but journals nonsense.
    if (view.exportedFunctions.has(JOURNAL_RESET_EXPORT)) {
        throw new InstrumentError("module already carries a state journal");
    }

    const accessorIndex = new Map<AccessorName, number>();
    for (const name of ACCESSOR_EXPORTS) {
        const index = view.exportedFunctions.get(name);
        if (index === undefined) {
            throw new InstrumentError(`module has no '${name}' export`);
        }
        accessorIndex.set(name, index);
    }

    const types = [...view.types];
    const typeIndexOf = (params: readonly WasmTypeCode[], results: readonly WasmTypeCode[]): number => {
        const encoded = encodeFunctionType(params, results);
        const existing = types.findIndex((candidate) => candidate.length === encoded.length && candidate.every((byte, at) => byte === encoded[at]));
        if (existing >= 0) {
            return existing;
        }
        types.push(encoded);
        return types.length - 1;
    };

    const voidType = typeIndexOf([], []);
    const noteType = typeIndexOf([WasmType.I32, WasmType.I32], []);
    const bulkType = typeIndexOf([WasmType.I32, WasmType.I32, WasmType.I32], []);

    // Helpers are appended, so their indices start after every function the module already has.
    let nextFunctionIndex = view.importedFunctionCount + view.functionTypeIndices.length;
    const helperTypes: number[] = [];
    const claim = (typeIndex: number): number => {
        helperTypes.push(typeIndex);
        return nextFunctionIndex++;
    };

    const initIndex = claim(voidType);
    const resetIndex = claim(voidType);
    const noteIndex = claim(noteType);
    const storeIndex = new Map<number, number>();
    for (const kind of STORE_KINDS) {
        storeIndex.set(kind.opcode, claim(typeIndexOf([WasmType.I32, kind.valueType, WasmType.I32], [])));
    }
    const copyIndex = claim(bulkType);
    const fillIndex = claim(bulkType);

    const globalBase = view.globals.length;
    const readyGlobal = globalBase;
    const stateGlobal = globalBase + 1;
    const sizeGlobal = globalBase + 2;
    const journalGlobal = globalBase + 3;

    const layout: HelperLayout = { initIndex, resetIndex, noteIndex, storeIndex, copyIndex, fillIndex };
    const helperOf = (opcode: number, bulkOperation?: number): number => {
        if (opcode === Op.PREFIX_FC) {
            return bulkOperation === BULK_MEMORY_COPY ? layout.copyIndex : layout.fillIndex;
        }
        const index = layout.storeIndex.get(opcode);
        if (index === undefined) {
            throw new InstrumentError(`no helper for opcode 0x${opcode.toString(16)}`);
        }
        return index;
    };

    let storesInstrumented = 0;
    let bulkInstrumented = 0;

    const rewrites = view.bodies.map((body) => {
        const rewrite = rewriteBody(body, helperOf);
        storesInstrumented += rewrite.stores;
        bulkInstrumented += rewrite.bulk;
        return rewrite;
    });
    const rewrittenBodies = rewrites.map((rewrite) => rewrite.bytes);

    const helperBodies = emitHelpers({
        accessorIndex,
        layout,
        readyGlobal,
        stateGlobal,
        sizeGlobal,
        journalGlobal,
        capacityBlocks,
        tableSlots,
        entriesOffset,
    });

    const sections = view.sections.map((section) => ({ id: section.id, payload: section.payload }));
    upsertVectorSection(sections, WasmSectionId.TYPE, types);
    upsertVectorSection(sections, WasmSectionId.FUNCTION, [...view.functionTypeIndices, ...helperTypes].map((index) => new ByteWriter().u32(index).toBytes()));
    upsertVectorSection(sections, WasmSectionId.GLOBAL, [...view.globals, encodeMutableI32Global(), encodeMutableI32Global(), encodeMutableI32Global(), encodeMutableI32Global()]);
    upsertVectorSection(sections, WasmSectionId.EXPORT, [...view.exports, encodeFunctionExport(JOURNAL_RESET_EXPORT, resetIndex)]);
    upsertVectorSection(sections, WasmSectionId.CODE, [...rewrittenBodies, ...helperBodies]);

    return {
        wasm: joinSections(sections),
        journalBase: ioBase + ioSize,
        journalBytes,
        capacityBlocks,
        stateSize,
        storesInstrumented,
        bulkInstrumented,
        offsetMap: buildOffsetMap(wasm, view, sections, rewrites, rewrittenBodies, rewrittenBodies.length + helperBodies.length),
    };
}

/** Byte length of a section once its header is included. */
function sectionLength(section: WasmSection): number {
    return 1 + new ByteWriter().u32(section.payload.length).length + section.payload.length;
}

/**
 * Where every pristine code offset lands in the instrumented module. Bodies move because the sections
 * ahead of the code section grew, and again because each rewritten site inside them is longer.
 */
function buildOffsetMap(
    wasm: Uint8Array,
    view: ModuleView,
    sections: readonly WasmSection[],
    rewrites: readonly BodyRewrite[],
    finalBodies: readonly Uint8Array[],
    totalBodies: number,
): { from: number; shift: number }[] {
    const newCodeSection = sectionOf(sections, WasmSectionId.CODE);
    if (!newCodeSection || view.bodies.length === 0) {
        return [];
    }

    let newBodyStart = WASM_MAGIC.length;
    for (const section of sections) {
        if (section.id === WasmSectionId.CODE) {
            break;
        }
        newBodyStart += sectionLength(section);
    }
    newBodyStart += 1 + new ByteWriter().u32(newCodeSection.payload.length).length + new ByteWriter().u32(totalBodies).length;

    const offsetMap: { from: number; shift: number }[] = [];

    for (let index = 0; index < view.bodies.length; index++) {
        const rewrite = rewrites[index]!;
        const oldBody = view.bodies[index]!;
        const finalBody = finalBodies[index]!;
        // Read from the body that is actually emitted: the io_size accessor is re-encoded after the
        // rewrite pass, and its size prefix can change width.
        const sizeReader = new ByteReader(finalBody);
        sizeReader.u32("final body size");
        const newContentStart = sizeReader.position;

        const oldContentAt = oldBody.byteOffset - wasm.byteOffset + rewrite.oldContentStart;
        const baseShift = newBodyStart + newContentStart - oldContentAt;

        offsetMap.push({ from: oldContentAt, shift: baseShift });
        for (const site of rewrite.sites) {
            offsetMap.push({ from: oldContentAt + site.oldContentOffset, shift: baseShift + site.newContentOffset - site.oldContentOffset });
        }

        newBodyStart += finalBody.byteLength;
    }

    return offsetMap;
}


interface HelperContext {
    readonly accessorIndex: Map<AccessorName, number>;
    readonly layout: HelperLayout;
    readonly readyGlobal: number;
    readonly stateGlobal: number;
    readonly sizeGlobal: number;
    readonly journalGlobal: number;
    readonly capacityBlocks: number;
    readonly tableSlots: number;
    readonly entriesOffset: number;
}

function emitHelpers(context: HelperContext): Uint8Array[] {
    const bodies = [emitInit(context), emitReset(context), emitNote(context)];
    for (const kind of STORE_KINDS) {
        bodies.push(emitStoreHelper(context, kind));
    }
    bodies.push(emitBulkHelper(context, BULK_MEMORY_COPY));
    bodies.push(emitBulkHelper(context, BULK_MEMORY_FILL));
    return bodies;
}

/** Resolves the journal base and writes the header. Runs once, lazily, from whichever helper is first. */
function emitInit(context: HelperContext): Uint8Array {
    const journal = 0;
    const code = new CodeEmitter([{ count: 1, type: WasmType.I32 }]);

    code.call(context.accessorIndex.get("state_addr")!).globalSet(context.stateGlobal);
    code.call(context.accessorIndex.get("state_size")!).globalSet(context.sizeGlobal);
    code.call(context.accessorIndex.get("io_base")!).call(context.accessorIndex.get("io_size")!).op(Op.I32_ADD);
    code.localTee(journal).globalSet(context.journalGlobal);

    code.localGet(journal).constI32(0).constI32(JOURNAL_HEADER_BYTES).bulk(BULK_MEMORY_FILL, 0);

    code.localGet(journal).constI32(JOURNAL_MAGIC).memory(Op.I32_STORE, JournalHeaderOffset.MAGIC);
    code.localGet(journal).constI32(JOURNAL_FORMAT_VERSION).memory(Op.I32_STORE, JournalHeaderOffset.VERSION);
    code.localGet(journal).constI32(context.capacityBlocks).memory(Op.I32_STORE, JournalHeaderOffset.CAPACITY);
    code.localGet(journal).globalGet(context.sizeGlobal).memory(Op.I32_STORE, JournalHeaderOffset.STATE_SIZE);
    code.localGet(journal).constI32(context.tableSlots - 1).memory(Op.I32_STORE, JournalHeaderOffset.TABLE_MASK);
    code.localGet(journal).constI32(JOURNAL_FIRST_GENERATION).memory(Op.I32_STORE, JournalHeaderOffset.GENERATION);

    // Set before the reset call, or reset would see an unready journal and recurse back into init.
    code.constI32(1).globalSet(context.readyGlobal);
    code.call(context.layout.resetIndex);

    return code.finish();
}

function emitReset(context: HelperContext): Uint8Array {
    const journal = 0;
    const generation = 1;
    const code = new CodeEmitter([{ count: 2, type: WasmType.I32 }]);

    code.globalGet(context.readyGlobal).op(Op.I32_EQZ);
    code.if(() => {
        code.call(context.layout.initIndex).op(Op.RETURN);
    });

    code.globalGet(context.journalGlobal).localTee(journal);
    code.constI32(0).memory(Op.I32_STORE, JournalHeaderOffset.FLAGS);
    code.localGet(journal).constI32(0).memory(Op.I32_STORE, JournalHeaderOffset.ENTRY_COUNT);

    // Retiring the generation frees every slot at once, so the table costs nothing to clear.
    code.localGet(journal).memory(Op.I32_LOAD, JournalHeaderOffset.GENERATION).constI32(1).op(Op.I32_ADD).localSet(generation);
    code.localGet(generation).op(Op.I32_EQZ);
    code.if(() => {
        // Wrapped: leftovers would read as live again, so this one dispatch pays a clear.
        code.localGet(journal).constI32(JOURNAL_HEADER_BYTES).op(Op.I32_ADD);
        code.constI32(0).constI32(context.tableSlots * JOURNAL_SLOT_BYTES).bulk(BULK_MEMORY_FILL, 0);
        code.constI32(JOURNAL_FIRST_GENERATION).localSet(generation);
    });
    code.localGet(journal).localGet(generation).memory(Op.I32_STORE, JournalHeaderOffset.GENERATION);

    return code.finish();
}

/**
 * Records the original bytes of each block this write is the first to touch. Membership lives in a
 * fixed open-addressed table, so the cost does not grow with the state size.
 */
function emitNote(context: HelperContext): Uint8Array {
    const address = 0;
    const length = 1;
    const relative = 2;
    const lastBlock = 3;
    const block = 4;
    const journal = 5;
    const slotIndex = 6;
    const slot = 7;
    const generation = 8;
    const count = 9;
    const destination = 10;
    const copyLength = 11;

    const code = new CodeEmitter([{ count: 10, type: WasmType.I32 }]);

    code.localGet(length).op(Op.I32_EQZ);
    code.if(() => {
        code.op(Op.RETURN);
    });

    code.localGet(address).globalGet(context.stateGlobal).op(Op.I32_SUB).localTee(relative);
    code.localGet(length).op(Op.I32_ADD).constI32(1).op(Op.I32_SUB).localSet(lastBlock);

    // A write may run past the end of the state; clamp so the tail block is not read out of bounds.
    code.localGet(lastBlock).globalGet(context.sizeGlobal).op(Op.I32_GE_U);
    code.if(() => {
        code.globalGet(context.sizeGlobal).constI32(1).op(Op.I32_SUB).localSet(lastBlock);
    });

    code.localGet(lastBlock).constI32(8).op(Op.I32_SHR_U).localSet(lastBlock);
    code.globalGet(context.journalGlobal).localSet(journal);
    code.localGet(journal).memory(Op.I32_LOAD, JournalHeaderOffset.GENERATION).localSet(generation);
    code.localGet(relative).constI32(8).op(Op.I32_SHR_U).localSet(block);

    code.block("done", () => {
        code.loop("next", () => {
            code.localGet(block).localGet(lastBlock).op(Op.I32_GT_U).brIf("done");

            code.block("seen", () => {
                code.localGet(block).constI32(JOURNAL_HASH_MULTIPLIER).op(Op.I32_MUL);
                code.constI32(context.tableSlots - 1).op(Op.I32_AND).localSet(slotIndex);

                code.block("placed", () => {
                    code.loop("probe", () => {
                        code.localGet(journal).constI32(JOURNAL_HEADER_BYTES).op(Op.I32_ADD);
                        code.localGet(slotIndex).constI32(3).op(Op.I32_SHL).op(Op.I32_ADD).localTee(slot);
                        // A slot stamped with any other generation is a leftover: take it.
                        code.memory(Op.I32_LOAD).localGet(generation).op(Op.I32_EQ).op(Op.I32_EQZ).brIf("placed");
                        code.localGet(slot).memory(Op.I32_LOAD, JOURNAL_SLOT_BLOCK_OFFSET).localGet(block).op(Op.I32_EQ).brIf("seen");
                        code.localGet(slotIndex).constI32(1).op(Op.I32_ADD).constI32(context.tableSlots - 1).op(Op.I32_AND).localSet(slotIndex);
                        code.br("probe");
                    });
                });

                code.localGet(journal).memory(Op.I32_LOAD, JournalHeaderOffset.ENTRY_COUNT).localSet(count);
                code.localGet(count).constI32(context.capacityBlocks).op(Op.I32_GE_U);
                code.if(() => {
                    code.localGet(journal);
                    code.localGet(journal).memory(Op.I32_LOAD, JournalHeaderOffset.FLAGS);
                    code.constI32(JOURNAL_OVERFLOW_FLAG).op(Op.I32_OR).memory(Op.I32_STORE, JournalHeaderOffset.FLAGS);
                    code.br("done");
                });

                code.localGet(slot).localGet(generation).memory(Op.I32_STORE);
                code.localGet(slot).localGet(block).memory(Op.I32_STORE, JOURNAL_SLOT_BLOCK_OFFSET);

                code.localGet(journal).constI32(context.entriesOffset).op(Op.I32_ADD);
                code.localGet(count).constI32(JOURNAL_ENTRY_BYTES).op(Op.I32_MUL).op(Op.I32_ADD).localTee(destination);
                code.localGet(block).memory(Op.I32_STORE);

                code.globalGet(context.sizeGlobal).localGet(block).constI32(8).op(Op.I32_SHL).op(Op.I32_SUB).localTee(copyLength);
                code.constI32(JOURNAL_BLOCK_BYTES).op(Op.I32_GT_U);
                code.if(() => {
                    code.constI32(JOURNAL_BLOCK_BYTES).localSet(copyLength);
                });

                code.localGet(destination).constI32(4).op(Op.I32_ADD);
                code.globalGet(context.stateGlobal).localGet(block).constI32(8).op(Op.I32_SHL).op(Op.I32_ADD);
                code.localGet(copyLength).bulk(BULK_MEMORY_COPY, 0, 0);

                code.localGet(journal).localGet(count).constI32(1).op(Op.I32_ADD).memory(Op.I32_STORE, JournalHeaderOffset.ENTRY_COUNT);
            });

            code.localGet(block).constI32(1).op(Op.I32_ADD).localSet(block);
            code.br("next");
        });
    });

    return code.finish();
}

/**
 * Wraps one store opcode. The range test is inlined so a store that misses the state region — most of
 * them — costs a compare rather than a second call.
 */
function emitStoreHelper(context: HelperContext, kind: StoreKind): Uint8Array {
    const address = 0;
    const value = 1;
    const offset = 2;
    const effective = 3;

    const code = new CodeEmitter([{ count: 1, type: WasmType.I32 }]);

    code.localGet(address).localGet(offset).op(Op.I32_ADD).localTee(effective);
    // Wrapping past 2^32 would turn an out-of-bounds trap into a write somewhere else entirely.
    code.localGet(address).op(Op.I32_LT_U);
    code.if(() => {
        code.op(Op.UNREACHABLE);
    });

    code.globalGet(context.readyGlobal).op(Op.I32_EQZ);
    code.if(() => {
        code.call(context.layout.initIndex);
    });

    code.localGet(effective).globalGet(context.stateGlobal).op(Op.I32_SUB).globalGet(context.sizeGlobal).op(Op.I32_LT_U);
    code.if(() => {
        code.localGet(effective).constI32(kind.bytes).call(context.layout.noteIndex);
    });

    code.localGet(effective).localGet(value).memory(kind.opcode);

    return code.finish();
}

function emitBulkHelper(context: HelperContext, operation: number): Uint8Array {
    const destination = 0;
    const source = 1;
    const length = 2;

    const code = new CodeEmitter();

    code.globalGet(context.readyGlobal).op(Op.I32_EQZ);
    code.if(() => {
        code.call(context.layout.initIndex);
    });

    code.localGet(destination).localGet(length).call(context.layout.noteIndex);
    code.localGet(destination).localGet(source).localGet(length);
    if (operation === BULK_MEMORY_COPY) {
        code.bulk(BULK_MEMORY_COPY, 0, 0);
    } else {
        code.bulk(BULK_MEMORY_FILL, 0);
    }

    return code.finish();
}
