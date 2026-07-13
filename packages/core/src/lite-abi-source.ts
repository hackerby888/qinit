export type LiteAbiValueType = "i32" | "i64";

export interface LiteAbiSource {
  abiVersion: number;
  lhost: Array<{ name: string; params: LiteAbiValueType[]; results: LiteAbiValueType[] }>;
  systemProcedures: Array<{ id: number; name: string; method: string }>;
  records: {
    LiteAssetEntry: {
      size: number;
      capacity: number;
      fields: Record<string, { offset: number; size: number }>;
    };
  };
}

function parseWamrSignature(signature: string): { params: LiteAbiValueType[]; results: LiteAbiValueType[] } {
  const match = /^\(([iI]*)\)([iI]?)$/.exec(signature);
  if (!match) throw new Error(`unsupported WAMR signature '${signature}'`);
  const convert = (value: string): LiteAbiValueType => value === "i" ? "i32" : "i64";
  return { params: [...match[1]].map(convert), results: match[2] ? [convert(match[2])] : [] };
}

function parseAssetRecord(source: string): LiteAbiSource["records"]["LiteAssetEntry"] {
  const body = /struct\s+LiteAssetEntry\s*\{([\s\S]*?)\};/.exec(source)?.[1];
  if (!body) throw new Error("core ABI metadata does not declare LiteAssetEntry");
  const typeSize: Record<string, number> = {
    "unsigned char": 1,
    "unsigned short": 2,
    "unsigned int": 4,
    "long long": 8,
    "unsigned long long": 8,
  };
  const fields: Record<string, { offset: number; size: number }> = {};
  let offset = 0;
  let structAlignment = 1;
  for (const declaration of body.split(";")) {
    const match = /^\s*(unsigned\s+(?:char|short|int|long\s+long)|long\s+long)\s+(\w+)\s*(?:\[\s*(\d+)\s*\])?\s*$/.exec(declaration);
    if (!match) {
      if (declaration.trim()) throw new Error(`unsupported LiteAssetEntry field '${declaration.trim()}'`);
      continue;
    }
    const elementSize = typeSize[match[1].replace(/\s+/g, " ")];
    if (!elementSize) throw new Error(`unsupported LiteAssetEntry type '${match[1]}'`);
    const alignment = elementSize;
    offset = Math.ceil(offset / alignment) * alignment;
    const size = elementSize * Number(match[3] ?? 1);
    fields[match[2]] = { offset, size };
    offset += size;
    structAlignment = Math.max(structAlignment, alignment);
  }
  const capacityMatch = /#define\s+LITE_ASSET_ENTRY_CAPACITY\s+(\d+)u?\b/.exec(source);
  if (!capacityMatch) throw new Error("core ABI metadata does not declare LITE_ASSET_ENTRY_CAPACITY");
  return { size: Math.ceil(offset / structAlignment) * structAlignment, capacity: Number(capacityMatch[1]), fields };
}

export function parseLiteAbiSource(metadataSource: string, sharedAbiSource: string): LiteAbiSource {
  const versionMatch = /#define\s+LITE_DYN_ABI_VERSION\s+(\d+)u?\b/.exec(metadataSource);
  if (!versionMatch) throw new Error("core ABI metadata does not declare LITE_DYN_ABI_VERSION");

  const lhost: LiteAbiSource["lhost"] = [];
  for (const line of metadataSource.split(/\r?\n/)) {
    const match = /^\s*(?:GQ|GI|HQ|HI)\(\s*"([^"]+)"[\s\S]*"(\([iI]*\)[iI]?)"\s*\)\s*\\?\s*$/.exec(line);
    if (!match) continue;
    lhost.push({ name: match[1], ...parseWamrSignature(match[2]) });
  }
  if (!lhost.length) throw new Error("core ABI metadata contains no LHOST rows");
  const duplicateImport = lhost.find((row, index) => lhost.findIndex((other) => other.name === row.name) !== index);
  if (duplicateImport) throw new Error(`duplicate LHOST import '${duplicateImport.name}'`);

  const systemProcedures: LiteAbiSource["systemProcedures"] = [];
  for (const line of metadataSource.split(/\r?\n/)) {
    const match = /^\s*X\(\s*([A-Z0-9_]+)\s*,\s*(\d+)\s*,\s*(\w+)\s*,/.exec(line);
    if (match) systemProcedures.push({ name: match[1], id: Number(match[2]), method: match[3] });
  }
  if (!systemProcedures.length) throw new Error("core ABI metadata contains no system-procedure rows");
  for (let index = 0; index < systemProcedures.length; index++) {
    if (systemProcedures[index].id !== index) {
      throw new Error(`ambiguous system-procedure order: ${systemProcedures[index].name} has id ${systemProcedures[index].id}, expected ${index}`);
    }
  }

  return {
    abiVersion: Number(versionMatch[1]),
    lhost,
    systemProcedures,
    records: { LiteAssetEntry: parseAssetRecord(sharedAbiSource) },
  };
}
