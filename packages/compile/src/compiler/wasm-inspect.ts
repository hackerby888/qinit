/**
 * Static inspection for the Lite dynamic-contract Wasm ABI.
 *
 * This deliberately parses the binary instead of instantiating it.  That keeps
 * the gate usable in the browser compiler and lets it check function signatures,
 * which WebAssembly.Module.imports()/exports() do not expose consistently across
 * JavaScript engines.
 */

export type WasmValueType = "i32" | "i64" | "f32" | "f64";

export interface WasmFunctionSignature {
  readonly params: readonly WasmValueType[];
  readonly results: readonly WasmValueType[];
}

export type WasmExternalKind = "function" | "table" | "memory" | "global" | "tag";

export interface InspectedWasmImport {
  readonly module: string;
  readonly name: string;
  readonly kind: WasmExternalKind;
  readonly signature?: WasmFunctionSignature;
}

export interface InspectedWasmExport {
  readonly name: string;
  readonly kind: WasmExternalKind;
  readonly index: number;
  readonly signature?: WasmFunctionSignature;
}

export interface InspectedWasmMemory {
  readonly source: "imported" | "defined";
  readonly module?: string;
  readonly name?: string;
  readonly minimumPages: bigint;
  readonly maximumPages?: bigint;
  readonly shared: boolean;
  readonly memory64: boolean;
}

export type LiteWasmMemoryMode = "defined" | "imported" | "either";
export type InspectedMemoryMode = "none" | "defined" | "imported" | "mixed";

export interface WasmInspectionDiagnostic {
  readonly severity: "error";
  readonly code: string;
  readonly message: string;
  readonly offset?: number;
}

export interface LiteWasmInspectionOptions {
  /** Production contracts define memory; shared-memory gtests import env.memory. */
  readonly memoryMode?: LiteWasmMemoryMode;
}

export interface LiteWasmInspection {
  readonly ok: boolean;
  readonly diagnostics: readonly WasmInspectionDiagnostic[];
  readonly imports: readonly InspectedWasmImport[];
  readonly exports: readonly InspectedWasmExport[];
  readonly memories: readonly InspectedWasmMemory[];
  readonly memoryMode: InspectedMemoryMode;
  readonly features: readonly string[];
}

const signature = (
  params: readonly WasmValueType[] = [],
  results: readonly WasmValueType[] = [],
): WasmFunctionSignature => Object.freeze({ params: Object.freeze([...params]), results: Object.freeze([...results]) });

const I32 = "i32" as const;
const I64 = "i64" as const;

// Enabled by both JavaScript engines and WAMR's interpreter in the release node.
// Keep this deliberately narrow; every other detected post-MVP feature fails closed.
const PORTABLE_FEATURES = new Set(["sign-extension-operators"]);

/** Exact names and signatures registered by core-lite's LHOST_TABLE. */
export const LHOST_ABI: Readonly<Record<string, WasmFunctionSignature>> = Object.freeze({
  beginFn: signature([I32]),
  endFn: signature([I32]),
  markDirty: signature([I32]),
  pauseLog: signature(),
  resumeLog: signature(),
  acquireScratch: signature([I64, I32], [I32]),
  releaseScratch: signature([I32]),
  logBytes: signature([I32, I32, I32, I32]),
  k12: signature([I32, I32, I32]),
  transfer: signature([I32, I64], [I64]),
  transferTyped: signature([I32, I64, I32], [I64]),
  abort: signature([I32]),
  burn: signature([I64, I32], [I64]),
  epoch: signature([], [I32]),
  tick: signature([], [I32]),
  numberOfTickTransactions: signature([], [I32]),
  getEntity: signature([I32, I32], [I32]),
  queryFeeReserve: signature([I32], [I64]),
  nextId: signature([I32, I32]),
  prevId: signature([I32, I32]),
  isContractId: signature([I32], [I32]),
  arbitrator: signature([I32]),
  computor: signature([I32, I32]),
  day: signature([], [I32]),
  year: signature([], [I32]),
  hour: signature([], [I32]),
  minute: signature([], [I32]),
  month: signature([], [I32]),
  second: signature([], [I32]),
  millisecond: signature([], [I32]),
  now: signature([I32]),
  prevSpectrumDigest: signature([I32]),
  prevUniverseDigest: signature([I32]),
  prevComputerDigest: signature([I32]),
  isAssetIssued: signature([I32, I64], [I32]),
  issueAsset: signature([I64, I32, I32, I64, I64], [I64]),
  numberOfShares: signature([I32, I32, I32], [I64]),
  numberOfPossessedShares: signature([I64, I32, I32, I32, I32, I32], [I64]),
  assetEnumerate: signature([I32, I32, I32, I32, I32, I32], [I32]),
  transferShareOwnershipAndPossession: signature([I64, I32, I32, I32, I64, I32], [I64]),
  acquireShares: signature([I64, I32, I32, I32, I64, I32, I32, I64], [I64]),
  releaseShares: signature([I64, I32, I32, I32, I64, I32, I32, I64], [I64]),
  dayOfWeek: signature([I32, I32, I32], [I32]),
  signatureValidity: signature([I32, I32, I32], [I32]),
  bidInIPO: signature([I32, I64, I32], [I64]),
  ipoBidId: signature([I32, I32, I32]),
  ipoBidPrice: signature([I32, I32], [I64]),
  computeMiningFunction: signature([I32, I32, I32, I32]),
  initMiningSeed: signature([I32]),
  getOracleQueryStatus: signature([I64], [I32]),
  unsubscribeOracle: signature([I32], [I32]),
  queryOracle: signature([I32, I32, I32, I32, I32, I64], [I64]),
  subscribeOracle: signature([I32, I32, I32, I32, I32, I32, I64], [I32]),
  getOracleQuery: signature([I64, I32, I32], [I32]),
  getOracleReply: signature([I64, I32, I32], [I32]),
  distributeDividends: signature([I64], [I32]),
  liteCallFunction: signature([I32, I32, I32, I32, I32, I32], [I32]),
  liteInvokeProcedure: signature([I32, I32, I32, I32, I32, I32, I64], [I32]),
  liteSetShareholderProposal: signature([I32, I32, I64], [I32]),
  liteSetShareholderVotes: signature([I32, I32, I32, I64], [I32]),
});

/** Function exports consumed by the Qinit engine and core-lite dynamic loader. */
export const LITE_WASM_FUNCTION_ABI: Readonly<Record<string, WasmFunctionSignature>> = Object.freeze({
  state_addr: signature([], [I32]),
  state_size: signature([], [I32]),
  io_base: signature([], [I32]),
  io_size: signature([], [I32]),
  ctx_addr: signature([], [I32]),
  reg_count: signature([], [I32]),
  reg_info: signature([I32, I32]),
  reg_sysproc_mask: signature([], [I32]),
  sysproc_locals_size: signature([I32], [I32]),
  sysproc_in_size: signature([I32], [I32]),
  sysproc_out_size: signature([I32], [I32]),
  has_migrate: signature([], [I32]),
  migrate_old_state_size: signature([], [I32]),
  migrate_locals_size: signature([], [I32]),
  dispatch: signature([I32, I32, I32, I32, I32]),
  _initialize: signature(),
});

class WasmParseError extends Error {
  constructor(message: string, readonly offset: number) {
    super(message);
  }
}

class Reader {
  pos: number;

  constructor(
    readonly bytes: Uint8Array,
    start = 0,
    readonly end = bytes.byteLength,
  ) {
    this.pos = start;
    if (start < 0 || end < start || end > bytes.byteLength) throw new WasmParseError("invalid reader bounds", start);
  }

  get done(): boolean { return this.pos === this.end; }
  get remaining(): number { return this.end - this.pos; }

  byte(label = "byte"): number {
    if (this.pos >= this.end) throw new WasmParseError(`unexpected end while reading ${label}`, this.pos);
    return this.bytes[this.pos++];
  }

  skip(length: number, label = "bytes"): void {
    if (!Number.isSafeInteger(length) || length < 0 || this.pos + length > this.end) {
      throw new WasmParseError(`unexpected end while reading ${label}`, this.pos);
    }
    this.pos += length;
  }

  u32(label = "u32"): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const at = this.pos;
      const b = this.byte(label);
      if (i === 4 && (b & 0xf0) !== 0) throw new WasmParseError(`${label} exceeds uint32`, at);
      value += (b & 0x7f) * 2 ** (i * 7);
      if ((b & 0x80) === 0) return value >>> 0;
    }
    throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
  }

  u64(label = "u64"): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const at = this.pos;
      const b = this.byte(label);
      if (i === 9 && (b & 0xfe) !== 0) throw new WasmParseError(`${label} exceeds uint64`, at);
      value |= BigInt(b & 0x7f) << BigInt(i * 7);
      if ((b & 0x80) === 0) return value;
    }
    throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
  }

  signedLeb(maxBytes: number, label: string): void {
    for (let i = 0; i < maxBytes; i++) {
      if ((this.byte(label) & 0x80) === 0) return;
    }
    throw new WasmParseError(`${label} has an overlong LEB128 encoding`, this.pos);
  }

  name(label = "name"): string {
    const length = this.u32(`${label} length`);
    const start = this.pos;
    this.skip(length, label);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(this.bytes.subarray(start, start + length));
    } catch {
      throw new WasmParseError(`${label} is not valid UTF-8`, start);
    }
  }

  subReader(length: number, label: string): Reader {
    const start = this.pos;
    this.skip(length, label);
    return new Reader(this.bytes, start, start + length);
  }
}

interface InternalGlobal {
  type: WasmValueType;
  mutable: boolean;
}

interface ParsedModule {
  types: WasmFunctionSignature[];
  functionTypeIndices: number[];
  globals: InternalGlobal[];
  imports: InspectedWasmImport[];
  exports: InspectedWasmExport[];
  memories: InspectedWasmMemory[];
  features: Set<string>;
  diagnostics: WasmInspectionDiagnostic[];
  definedFunctionCount: number;
  tableCount: number;
}

function error(
  diagnostics: WasmInspectionDiagnostic[],
  code: string,
  message: string,
  offset?: number,
): void {
  diagnostics.push(offset === undefined
    ? { severity: "error", code, message }
    : { severity: "error", code, message, offset });
}

function readValueType(reader: Reader, parsed: ParsedModule, context: string): WasmValueType {
  const at = reader.pos;
  switch (reader.byte(`${context} value type`)) {
    case 0x7f: return "i32";
    case 0x7e: return "i64";
    case 0x7d: return "f32";
    case 0x7c: return "f64";
    case 0x7b:
      parsed.features.add("simd");
      throw new WasmParseError(`${context} uses v128`, at);
    case 0x70:
    case 0x6f:
      parsed.features.add("reference-types");
      throw new WasmParseError(`${context} uses a reference value type`, at);
    default:
      throw new WasmParseError(`${context} has an unknown value type`, at);
  }
}

function readValueTypeVector(reader: Reader, parsed: ParsedModule, context: string): WasmValueType[] {
  const count = reader.u32(`${context} count`);
  const values: WasmValueType[] = [];
  for (let i = 0; i < count; i++) values.push(readValueType(reader, parsed, context));
  return values;
}

function readLimits(reader: Reader, parsed: ParsedModule, context: "memory" | "table"): {
  minimum: bigint;
  maximum?: bigint;
  shared: boolean;
  memory64: boolean;
} {
  const at = reader.pos;
  const flags = reader.u32(`${context} limits flags`);
  const shared = (flags & 0x02) !== 0;
  const memory64 = context === "memory" && (flags & 0x04) !== 0;
  const hasMaximum = (flags & 0x01) !== 0;
  if (shared) parsed.features.add("threads/shared-memory");
  if (memory64) parsed.features.add("memory64");
  const known = context === "memory" ? 0x07 : 0x01;
  if ((flags & ~known) !== 0) throw new WasmParseError(`${context} has unsupported limits flags 0x${flags.toString(16)}`, at);
  const readLimit = () => memory64 ? reader.u64(`${context} limit`) : BigInt(reader.u32(`${context} limit`));
  const minimum = readLimit();
  const maximum = hasMaximum ? readLimit() : undefined;
  return { minimum, maximum, shared, memory64 };
}

function readTableType(reader: Reader, parsed: ParsedModule): void {
  const at = reader.pos;
  const elementType = reader.byte("table element type");
  // 0x70 was anyfunc in MVP and is funcref in the reference-types spelling.
  if (elementType !== 0x70) {
    parsed.features.add("reference-types");
    if (elementType !== 0x6f) throw new WasmParseError("table has an unsupported element type", at);
  }
  readLimits(reader, parsed, "table");
}

function readGlobalType(reader: Reader, parsed: ParsedModule): InternalGlobal {
  const type = readValueType(reader, parsed, "global");
  const at = reader.pos;
  const mutable = reader.byte("global mutability");
  if (mutable !== 0 && mutable !== 1) throw new WasmParseError("global mutability must be 0 or 1", at);
  return { type, mutable: mutable === 1 };
}

function readConstExpression(reader: Reader, parsed: ParsedModule): void {
  const opcodeAt = reader.pos;
  switch (reader.byte("constant-expression opcode")) {
    case 0x23: reader.u32("global.get index"); break;
    case 0x41: reader.signedLeb(5, "i32.const"); break;
    case 0x42: reader.signedLeb(10, "i64.const"); break;
    case 0x43: reader.skip(4, "f32.const"); break;
    case 0x44: reader.skip(8, "f64.const"); break;
    case 0xd0:
    case 0xd2:
      parsed.features.add("reference-types");
      throw new WasmParseError("constant expression uses reference types", opcodeAt);
    default:
      parsed.features.add("extended-constant-expressions");
      throw new WasmParseError("constant expression is outside the MVP subset", opcodeAt);
  }
  if (reader.byte("constant-expression end") !== 0x0b) {
    parsed.features.add("extended-constant-expressions");
    throw new WasmParseError("constant expression has more than one instruction", reader.pos - 1);
  }
}

function readBlockType(reader: Reader, parsed: ParsedModule): void {
  const at = reader.pos;
  const first = reader.byte("block type");
  if (first === 0x40 || first === 0x7f || first === 0x7e || first === 0x7d || first === 0x7c) return;
  parsed.features.add("multi-value/block-type-index");
  for (let i = 1; i < 5 && (first & 0x80) !== 0; i++) {
    if ((reader.byte("block type index") & 0x80) === 0) return;
  }
  if ((first & 0x80) !== 0) throw new WasmParseError("invalid block type index", at);
}

/** Returns false when an unsupported prefix makes the rest of this body opaque. */
function readInstruction(reader: Reader, parsed: ParsedModule): boolean {
  const at = reader.pos;
  const opcode = reader.byte("opcode");
  switch (opcode) {
    case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b:
      return true;
    case 0x02: case 0x03: case 0x04:
      readBlockType(reader, parsed);
      return true;
    case 0x0c: case 0x0d: case 0x10:
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
      reader.u32("instruction index");
      return true;
    case 0x0e: {
      const count = reader.u32("br_table target count");
      for (let i = 0; i <= count; i++) reader.u32("br_table target");
      return true;
    }
    case 0x11: {
      reader.u32("call_indirect type index");
      const table = reader.u32("call_indirect table index");
      if (table !== 0) parsed.features.add("multiple-tables");
      return true;
    }
    case 0x25: case 0x26:
      parsed.features.add("reference-types/table-instructions");
      reader.u32("table index");
      return true;
    case 0x3f: case 0x40: {
      const memory = reader.u32("memory index");
      if (memory !== 0) parsed.features.add("multiple-memories");
      return true;
    }
    case 0x41: reader.signedLeb(5, "i32.const"); return true;
    case 0x42: reader.signedLeb(10, "i64.const"); return true;
    case 0x43: reader.skip(4, "f32.const"); return true;
    case 0x44: reader.skip(8, "f64.const"); return true;
    case 0x12:
      parsed.features.add("tail-calls");
      reader.u32("return_call function index");
      return true;
    case 0x13:
      parsed.features.add("tail-calls");
      reader.u32("return_call_indirect type index");
      reader.u32("return_call_indirect table index");
      return true;
    case 0x14: case 0x15:
      parsed.features.add("typed-function-references/tail-calls");
      reader.u32("call_ref type index");
      return true;
    case 0x1c: {
      parsed.features.add("typed-select");
      const count = reader.u32("typed select type count");
      for (let i = 0; i < count; i++) readValueType(reader, parsed, "typed select");
      return true;
    }
    case 0xc0: case 0xc1: case 0xc2: case 0xc3: case 0xc4:
      parsed.features.add("sign-extension-operators");
      return true;
    case 0xd0:
      parsed.features.add("reference-types");
      reader.signedLeb(5, "heap type");
      return true;
    case 0xd1:
      parsed.features.add("reference-types");
      return true;
    case 0xd2:
      parsed.features.add("reference-types");
      reader.u32("ref.func function index");
      return true;
    case 0xfc: {
      parsed.features.add("bulk-memory/nontrapping-conversions");
      const sub = reader.u32("0xfc subopcode");
      if (sub <= 7) return true;
      if (sub === 8) { reader.u32("data index"); reader.u32("memory index"); return true; }
      if (sub === 9 || (sub >= 15 && sub <= 17)) { reader.u32("segment/table index"); return true; }
      if (sub === 10 || sub === 12 || sub === 14) { reader.u32("first index"); reader.u32("second index"); return true; }
      if (sub === 11 || sub === 13) { reader.u32("memory/element index"); return true; }
      return false;
    }
    case 0x06: case 0x07: case 0x08: case 0x09: case 0x18: case 0x19: case 0x1f:
      parsed.features.add("exception-handling");
      return false;
    case 0xfb:
      parsed.features.add("gc");
      return false;
    case 0xfd:
      parsed.features.add("simd");
      return false;
    case 0xfe:
      parsed.features.add("threads/atomics");
      return false;
    default:
      if (opcode >= 0x28 && opcode <= 0x3e) {
        const alignment = reader.u32("memory alignment");
        if (alignment >= 64) {
          parsed.features.add("multiple-memories/memarg-extension");
          return false;
        }
        reader.u32("memory offset");
        return true;
      }
      if (opcode >= 0x45 && opcode <= 0xbf) return true;
      parsed.features.add(`unknown-opcode-0x${opcode.toString(16).padStart(2, "0")}`);
      error(parsed.diagnostics, "unsupported-opcode", `opcode 0x${opcode.toString(16).padStart(2, "0")} is outside the portable MVP profile`, at);
      return false;
  }
}

function parseTypeSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("type count");
  for (let i = 0; i < count; i++) {
    const at = reader.pos;
    if (reader.byte("function type form") !== 0x60) throw new WasmParseError("type is not a function type", at);
    const params = readValueTypeVector(reader, parsed, "parameter");
    const results = readValueTypeVector(reader, parsed, "result");
    if (results.length > 1) parsed.features.add("multi-value-results");
    parsed.types.push(signature(params, results));
  }
}

function typeAt(parsed: ParsedModule, index: number, context: string, offset: number): WasmFunctionSignature {
  const type = parsed.types[index];
  if (!type) throw new WasmParseError(`${context} refers to missing type ${index}`, offset);
  return type;
}

function parseImportSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("import count");
  for (let i = 0; i < count; i++) {
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
    } else if (kind === 1) {
      readTableType(reader, parsed);
      parsed.tableCount++;
      if (parsed.tableCount > 1) parsed.features.add("multiple-tables");
      parsed.imports.push({ module, name, kind: "table" });
    } else if (kind === 2) {
      const limits = readLimits(reader, parsed, "memory");
      parsed.memories.push({
        source: "imported", module, name,
        minimumPages: limits.minimum, maximumPages: limits.maximum,
        shared: limits.shared, memory64: limits.memory64,
      });
      parsed.imports.push({ module, name, kind: "memory" });
    } else if (kind === 3) {
      parsed.globals.push(readGlobalType(reader, parsed));
      parsed.imports.push({ module, name, kind: "global" });
    } else if (kind === 4) {
      parsed.features.add("exception-handling/tags");
      reader.byte("tag attribute");
      reader.u32("tag type index");
      parsed.imports.push({ module, name, kind: "tag" });
    } else {
      throw new WasmParseError(`unknown import kind ${kind}`, kindAt);
    }
  }
}

function parseFunctionSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("defined function count");
  parsed.definedFunctionCount = count;
  for (let i = 0; i < count; i++) {
    const at = reader.pos;
    const typeIndex = reader.u32("defined function type index");
    typeAt(parsed, typeIndex, "defined function", at);
    parsed.functionTypeIndices.push(typeIndex);
  }
}

function parseTableSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("table count");
  for (let i = 0; i < count; i++) {
    readTableType(reader, parsed);
    parsed.tableCount++;
  }
  if (parsed.tableCount > 1) parsed.features.add("multiple-tables");
}

function parseMemorySection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("memory count");
  for (let i = 0; i < count; i++) {
    const limits = readLimits(reader, parsed, "memory");
    parsed.memories.push({
      source: "defined",
      minimumPages: limits.minimum, maximumPages: limits.maximum,
      shared: limits.shared, memory64: limits.memory64,
    });
  }
  if (parsed.memories.length > 1) parsed.features.add("multiple-memories");
}

function parseGlobalSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("global count");
  for (let i = 0; i < count; i++) {
    parsed.globals.push(readGlobalType(reader, parsed));
    readConstExpression(reader, parsed);
  }
}

function parseExportSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("export count");
  for (let i = 0; i < count; i++) {
    const name = reader.name("export name");
    const kindAt = reader.pos;
    const rawKind = reader.byte("export kind");
    const index = reader.u32("export index");
    const kinds: WasmExternalKind[] = ["function", "table", "memory", "global", "tag"];
    const kind = kinds[rawKind];
    if (!kind) throw new WasmParseError(`unknown export kind ${rawKind}`, kindAt);
    if (kind === "tag") parsed.features.add("exception-handling/tags");
    if (kind === "function") {
      const typeIndex = parsed.functionTypeIndices[index];
      const fnType = typeIndex === undefined ? undefined : parsed.types[typeIndex];
      parsed.exports.push({ name, kind, index, signature: fnType });
    } else {
      parsed.exports.push({ name, kind, index });
    }
  }
}

function parseElementSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("element segment count");
  for (let i = 0; i < count; i++) {
    const tableOrFlags = reader.u32("element table index/flags");
    if (tableOrFlags !== 0) {
      parsed.features.add("bulk-memory/reference-type-elements");
      reader.skip(reader.remaining, "non-MVP element section");
      return;
    }
    readConstExpression(reader, parsed);
    const fnCount = reader.u32("element function count");
    for (let j = 0; j < fnCount; j++) reader.u32("element function index");
  }
}

function parseCodeSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("code body count");
  if (count !== parsed.definedFunctionCount) {
    error(parsed.diagnostics, "malformed-module", `function section declares ${parsed.definedFunctionCount} bodies but code section has ${count}`);
  }
  for (let i = 0; i < count; i++) {
    const size = reader.u32("function body size");
    const body = reader.subReader(size, "function body");
    const localGroupCount = body.u32("local group count");
    for (let j = 0; j < localGroupCount; j++) {
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
      error(parsed.diagnostics, "malformed-module", `function body ${i} does not end with end`, body.end - 1);
    }
  }
}

function parseDataSection(reader: Reader, parsed: ParsedModule): void {
  const count = reader.u32("data segment count");
  for (let i = 0; i < count; i++) {
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

function emptyParsed(): ParsedModule {
  return {
    types: [], functionTypeIndices: [], globals: [], imports: [], exports: [], memories: [],
    features: new Set(), diagnostics: [], definedFunctionCount: 0, tableCount: 0,
  };
}

function parseModule(bytes: Uint8Array, parsed: ParsedModule): ParsedModule {
  const reader = new Reader(bytes);
  const expectedHeader = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (let i = 0; i < expectedHeader.length; i++) {
    if (reader.byte("Wasm header") !== expectedHeader[i]) throw new WasmParseError("invalid Wasm magic or version", i);
  }

  const seenSections = new Set<number>();
  while (!reader.done) {
    const sectionAt = reader.pos;
    const id = reader.byte("section id");
    const length = reader.u32("section size");
    const section = reader.subReader(length, `section ${id}`);
    if (id !== 0) {
      if (seenSections.has(id)) throw new WasmParseError(`duplicate section ${id}`, sectionAt);
      seenSections.add(id);
    }
    switch (id) {
      case 0: section.skip(section.remaining, "custom section"); break;
      case 1: parseTypeSection(section, parsed); break;
      case 2: parseImportSection(section, parsed); break;
      case 3: parseFunctionSection(section, parsed); break;
      case 4: parseTableSection(section, parsed); break;
      case 5: parseMemorySection(section, parsed); break;
      case 6: parseGlobalSection(section, parsed); break;
      case 7: parseExportSection(section, parsed); break;
      case 8: section.u32("start function index"); break;
      case 9: parseElementSection(section, parsed); break;
      case 10: parseCodeSection(section, parsed); break;
      case 11: parseDataSection(section, parsed); break;
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
    if (!section.done) throw new WasmParseError(`section ${id} has ${section.remaining} unread bytes`, section.pos);
  }
  return parsed;
}

function sameSignature(a: WasmFunctionSignature | undefined, b: WasmFunctionSignature): boolean {
  return !!a
    && a.params.length === b.params.length
    && a.results.length === b.results.length
    && a.params.every((value, i) => value === b.params[i])
    && a.results.every((value, i) => value === b.results[i]);
}

function formatSignature(value: WasmFunctionSignature | undefined): string {
  if (!value) return "<unresolved>";
  return `(${value.params.join(", ")}) -> ${value.results.length ? value.results.join(", ") : "void"}`;
}

function classifyMemory(memories: readonly InspectedWasmMemory[]): InspectedMemoryMode {
  if (memories.length === 0) return "none";
  const imported = memories.some((memory) => memory.source === "imported");
  const defined = memories.some((memory) => memory.source === "defined");
  return imported && defined ? "mixed" : imported ? "imported" : "defined";
}

function validateImports(parsed: ParsedModule): void {
  for (const imported of parsed.imports) {
    if (imported.module === "lhost" && imported.kind === "function") {
      const expected = LHOST_ABI[imported.name];
      if (!expected) {
        error(parsed.diagnostics, "unknown-import", `unknown lhost import '${imported.name}'`);
      } else if (!sameSignature(imported.signature, expected)) {
        error(
          parsed.diagnostics,
          "import-signature",
          `lhost.${imported.name} has ${formatSignature(imported.signature)}; expected ${formatSignature(expected)}`,
        );
      }
      continue;
    }
    if (imported.module === "env" && imported.name === "memory" && imported.kind === "memory") continue;
    error(parsed.diagnostics, "unknown-import", `unsupported import '${imported.module}.${imported.name}' (${imported.kind})`);
  }
}

function validateExports(parsed: ParsedModule, mode: InspectedMemoryMode): void {
  const byName = new Map<string, InspectedWasmExport[]>();
  for (const exported of parsed.exports) {
    const values = byName.get(exported.name) ?? [];
    values.push(exported);
    byName.set(exported.name, values);
  }
  for (const [name, values] of byName) {
    if (values.length > 1) error(parsed.diagnostics, "duplicate-export", `export '${name}' appears ${values.length} times`);
  }
  for (const [name, expected] of Object.entries(LITE_WASM_FUNCTION_ABI)) {
    const exported = byName.get(name)?.[0];
    if (!exported) {
      error(parsed.diagnostics, "missing-export", `missing required function export '${name}'`);
    } else if (exported.kind !== "function") {
      error(parsed.diagnostics, "export-kind", `export '${name}' is ${exported.kind}; expected function`);
    } else if (!sameSignature(exported.signature, expected)) {
      error(
        parsed.diagnostics,
        "export-signature",
        `export '${name}' has ${formatSignature(exported.signature)}; expected ${formatSignature(expected)}`,
      );
    }
  }

  const arena = byName.get("arena_top")?.[0];
  if (!arena) {
    error(parsed.diagnostics, "missing-export", "missing required mutable i32 global export 'arena_top'");
  } else if (arena.kind !== "global") {
    error(parsed.diagnostics, "export-kind", `export 'arena_top' is ${arena.kind}; expected global`);
  } else {
    const global = parsed.globals[arena.index];
    if (!global || global.type !== "i32" || !global.mutable) {
      error(parsed.diagnostics, "export-signature", "export 'arena_top' must be a mutable i32 global");
    }
  }

  if (mode === "defined") {
    const memory = byName.get("memory")?.[0];
    if (!memory) {
      error(parsed.diagnostics, "missing-export", "defined-memory contracts must export 'memory'");
    } else if (memory.kind !== "memory") {
      error(parsed.diagnostics, "export-kind", `export 'memory' is ${memory.kind}; expected memory`);
    } else if (parsed.memories[memory.index]?.source !== "defined") {
      error(parsed.diagnostics, "memory-export", "export 'memory' does not refer to the defined contract memory");
    }
  }
}

function asUint8Array(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/**
 * Inspect a module against the production Lite Wasm ABI and the JS+WAMR
 * portability profile.  No imports are invoked and no module is instantiated.
 */
export function inspectLiteWasmModule(
  input: Uint8Array | ArrayBuffer,
  options: LiteWasmInspectionOptions = {},
): LiteWasmInspection {
  const bytes = asUint8Array(input);
  const parsed = emptyParsed();
  try {
    parseModule(bytes, parsed);
  } catch (caught) {
    const offset = caught instanceof WasmParseError ? caught.offset : undefined;
    const message = caught instanceof Error ? caught.message : String(caught);
    error(parsed.diagnostics, "malformed-module", message, offset);
    for (const feature of [...parsed.features].sort()) {
      if (PORTABLE_FEATURES.has(feature)) continue;
      error(parsed.diagnostics, "unsupported-feature", `unsupported Wasm feature: ${feature}`);
    }
    return {
      ok: false,
      diagnostics: parsed.diagnostics,
      imports: parsed.imports,
      exports: parsed.exports,
      memories: parsed.memories,
      memoryMode: classifyMemory(parsed.memories),
      features: [...parsed.features].sort(),
    };
  }

  // JS validation catches index/type/control-flow errors outside this structural parser.
  try {
    if (typeof WebAssembly !== "undefined" && !WebAssembly.validate(bytes as unknown as BufferSource)) {
      error(parsed.diagnostics, "js-validation", "JavaScript WebAssembly.validate rejected the module");
    }
  } catch (caught) {
    error(parsed.diagnostics, "js-validation", `JavaScript Wasm validation failed: ${caught instanceof Error ? caught.message : String(caught)}`);
  }

  validateImports(parsed);
  const memoryMode = classifyMemory(parsed.memories);
  if (parsed.memories.length !== 1) {
    error(parsed.diagnostics, "memory-count", `expected exactly one wasm32 memory; found ${parsed.memories.length}`);
  }
  const expectedMode = options.memoryMode ?? "defined";
  if (expectedMode !== "either" && memoryMode !== expectedMode) {
    error(parsed.diagnostics, "memory-mode", `expected ${expectedMode} memory; module uses ${memoryMode} memory`);
  }
  validateExports(parsed, memoryMode);

  for (const feature of [...parsed.features].sort()) {
    if (PORTABLE_FEATURES.has(feature)) continue;
    error(parsed.diagnostics, "unsupported-feature", `unsupported Wasm feature: ${feature}`);
  }

  return {
    ok: parsed.diagnostics.length === 0,
    diagnostics: parsed.diagnostics,
    imports: parsed.imports,
    exports: parsed.exports,
    memories: parsed.memories,
    memoryMode,
    features: [...parsed.features].sort(),
  };
}
