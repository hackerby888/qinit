interface FunctionType {
  params: number[];
  results: number[];
}

class WasmReader {
  offset: number;

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0,
    private readonly end = bytes.length,
  ) {
    this.offset = offset;
  }

  byte(): number {
    if (this.offset >= this.end) throw new Error("unexpected end of module");
    return this.bytes[this.offset++];
  }

  varUint(): number {
    let value = 0;
    let scale = 1;
    for (let index = 0; index < 10; index++) {
      const byte = this.byte();
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(value)) throw new Error("integer is too large");
        return value;
      }
      scale *= 128;
    }
    throw new Error("invalid unsigned LEB128 integer");
  }

  name(): string {
    const length = this.varUint();
    const start = this.offset;
    this.skip(length);
    return new TextDecoder().decode(this.bytes.subarray(start, this.offset));
  }

  skip(length: number): void {
    if (length < 0 || this.offset + length > this.end) {
      throw new Error("unexpected end of module");
    }
    this.offset += length;
  }

  section(length: number): WasmReader {
    if (length < 0 || this.offset + length > this.end) {
      throw new Error("invalid section size");
    }
    const reader = new WasmReader(this.bytes, this.offset, this.offset + length);
    this.offset += length;
    return reader;
  }

  done(): boolean {
    return this.offset === this.end;
  }
}

function readLimits(reader: WasmReader): void {
  const flags = reader.varUint();
  reader.varUint();
  if ((flags & 1) !== 0) reader.varUint();
}

function readTypes(reader: WasmReader, types: FunctionType[]): void {
  const count = reader.varUint();
  for (let index = 0; index < count; index++) {
    if (reader.byte() !== 0x60) throw new Error("unsupported Wasm function type");
    const params = Array.from({ length: reader.varUint() }, () => reader.byte());
    const results = Array.from({ length: reader.varUint() }, () => reader.byte());
    types.push({ params, results });
  }
}

function readImports(reader: WasmReader, functionTypes: number[]): void {
  const count = reader.varUint();
  for (let index = 0; index < count; index++) {
    reader.name();
    reader.name();
    const kind = reader.byte();
    if (kind === 0) {
      functionTypes.push(reader.varUint());
    } else if (kind === 1) {
      reader.byte();
      readLimits(reader);
    } else if (kind === 2) {
      readLimits(reader);
    } else if (kind === 3) {
      reader.byte();
      reader.byte();
    } else if (kind === 4) {
      reader.byte();
      reader.varUint();
    } else {
      throw new Error(`unsupported Wasm import kind ${kind}`);
    }
  }
}

/** Validate contract_index's exact () -> i32 signature without instantiating the module. */
export function validateContractIndexSignature(bytes: Uint8Array): void {
  const reader = new WasmReader(bytes);
  const magic = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  for (const expected of magic) {
    if (reader.byte() !== expected) throw new Error("invalid Wasm module header");
  }

  const types: FunctionType[] = [];
  const importedFunctionTypes: number[] = [];
  const definedFunctionTypes: number[] = [];
  let contractIndexExport: { kind: number; index: number } | undefined;

  while (!reader.done()) {
    const sectionId = reader.byte();
    const section = reader.section(reader.varUint());
    if (sectionId === 1) {
      readTypes(section, types);
    } else if (sectionId === 2) {
      readImports(section, importedFunctionTypes);
    } else if (sectionId === 3) {
      const count = section.varUint();
      for (let index = 0; index < count; index++) {
        definedFunctionTypes.push(section.varUint());
      }
    } else if (sectionId === 7) {
      const count = section.varUint();
      for (let index = 0; index < count; index++) {
        const name = section.name();
        const exported = { kind: section.byte(), index: section.varUint() };
        if (name === "contract_index") {
          if (contractIndexExport) throw new Error("duplicate contract_index export");
          contractIndexExport = exported;
        }
      }
    }
  }

  if (!contractIndexExport) throw new Error("missing required contract_index export");
  if (contractIndexExport.kind !== 0) {
    throw new Error("contract_index export must be a function");
  }

  const functionTypes = [...importedFunctionTypes, ...definedFunctionTypes];
  const type = types[functionTypes[contractIndexExport.index]];
  if (!type || type.params.length !== 0 || type.results.length !== 1 || type.results[0] !== 0x7f) {
    throw new Error("contract_index export must have signature () -> i32");
  }
}
