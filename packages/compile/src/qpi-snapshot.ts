// Assembles the exact header text consumed by compiler pipeline.
import { QPI_PRELUDE } from "./qpi-prelude";
import { parseLiteAbiSource } from "@qinit/core/lite-abi-source";
import { GENERATOR_VERSION, IMPL_BOUNDARY, LITE_ABI_MARKER } from "./qpi-snapshot-format";

export {
  embeddedLiteAbi,
  GENERATOR_VERSION,
  IMPL_BOUNDARY,
  LITE_ABI_MARKER,
} from "./qpi-snapshot-format";

// Core snapshot inputs are resolved relative to `<core>/src`.
const HEADER_FILES = [
  "contract_core/pre_qpi_def.h",
  "contracts/qpi.h",
  "contract_core/qpi_proposal_voting.h",
  "oracle_core/oracle_interfaces_def.h",
];

// Template method-body implementations — parsed SEPARATELY (after the IMPL boundary) so qpi.h's bulk doesn't interfere with capturing the
const IMPL_FILES = [
  "platform/m256.h",
  "platform/random.h",
  "platform/uint128.h",
  "contract_core/qpi_hash_map_impl.h",
  "contract_core/qpi_collection_impl.h",
  "contract_core/qpi_linked_list_impl.h",
  "contracts/math_lib.h",
  "contract_core/qpi_trivial_impl.h",
];

type NodeFileSystem = typeof import("node:fs");
type LiteAbi = ReturnType<typeof parseLiteAbiSource>;

interface WasmSourceSections {
  importDeclarations: string;
  contextWrappers: string;
}

interface HostImportDeclarations {
  symbolsBySourceName: Map<string, string>;
  declarationsByHostName: Map<string, string>;
}

function loadNodeFileSystem(): NodeFileSystem {
  return require("node:fs") as NodeFileSystem;
}

function requireCoreSourceDirectory(corePath: string, fileSystem: NodeFileSystem): string {
  const sourceDirectory = `${corePath}/src`;
  const qpiHeaderPath = `${sourceDirectory}/contracts/qpi.h`;

  if (!fileSystem.existsSync(qpiHeaderPath)) {
    throw new Error(`${corePath} is not a core checkout — ${qpiHeaderPath} not found`);
  }

  return sourceDirectory;
}

function readLiteAbi(fileSystem: NodeFileSystem, sourceDirectory: string): LiteAbi {
  return parseLiteAbiSource(
    fileSystem.readFileSync(`${sourceDirectory}/extensions/wasm/lite_abi_metadata.h`, "utf8"),
    fileSystem.readFileSync(`${sourceDirectory}/extensions/wasm/lite_dyn_abi.h`, "utf8"),
  );
}

function serializeLiteAbi(liteAbi: LiteAbi): string {
  return `${LITE_ABI_MARKER}${JSON.stringify(liteAbi)}\n`;
}

function assembleContractIndexDefinitions(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
): string {
  const contractDefinitionsPath = `${sourceDirectory}/contract_core/contract_def.h`;

  if (!fileSystem.existsSync(contractDefinitionsPath)) {
    return "";
  }

  const indexDefinitions = fileSystem
    .readFileSync(contractDefinitionsPath, "utf8")
    .split("\n")
    .filter((line) => /^#define \w+_CONTRACT_INDEX \d+\s*$/.test(line));

  return `${indexDefinitions.join("\n")}\n`;
}

function assembleHeaderDeclarations(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
): string {
  let declarations = "";

  for (const headerFile of HEADER_FILES) {
    const headerPath = `${sourceDirectory}/${headerFile}`;

    if (!fileSystem.existsSync(headerPath)) {
      continue;
    }

    const headerSource = fileSystem.readFileSync(headerPath, "utf8");
    declarations +=
      inlineOracleInterfaceHeaders(fileSystem, sourceDirectory, headerFile, headerSource) + "\n";
  }

  return declarations;
}

function inlineOracleInterfaceHeaders(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
  headerFile: string,
  headerSource: string,
): string {
  if (!headerFile.endsWith("oracle_interfaces_def.h")) {
    return headerSource;
  }

  return headerSource.replace(
    /^[ \t]*#include[ \t]+"(oracle_interfaces\/\w+\.h)"[ \t]*$/gm,
    (includeLine: string, relativePath: string) => {
      const includedHeaderPath = `${sourceDirectory}/${relativePath}`;

      return fileSystem.existsSync(includedHeaderPath)
        ? fileSystem.readFileSync(includedHeaderPath, "utf8")
        : includeLine;
    },
  );
}

function readWasmTranslationUnit(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
): { path: string; source: string } {
  const path = `${sourceDirectory}/extensions/wasm/lite_wasm_tu.h`;
  const source = fileSystem.existsSync(path) ? fileSystem.readFileSync(path, "utf8") : "";

  return { path, source };
}

function assembleContextBufferDeclaration(wasmSource: string, wasmSourcePath: string): string {
  const contextBuffer = /\bg_wasmCtxBuf\s*\[\s*(\d+)\s*\]/.exec(wasmSource);

  if (!contextBuffer) {
    throw new Error(`${wasmSourcePath} does not declare g_wasmCtxBuf capacity`);
  }

  return `\nstatic constexpr unsigned long long __qinit_qpi_context_buffer_size = ${contextBuffer[1]};\n`;
}

function assembleImplementationChunks(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
): string {
  let implementationChunks = "";

  for (const implementationFile of IMPL_FILES) {
    const implementationPath = `${sourceDirectory}/${implementationFile}`;

    if (!fileSystem.existsSync(implementationPath)) {
      continue;
    }

    const implementationSource = fileSystem
      .readFileSync(implementationPath, "utf8")
      .replace(/^[ \t]*#include[ \t].*$/gm, "");

    implementationChunks += `\n${IMPL_BOUNDARY}\n${implementationSource}\n`;
  }

  return implementationChunks;
}

function extractWasmSourceSections(
  wasmSource: string,
  wasmSourcePath: string,
): WasmSourceSections {
  const importBlockStart = wasmSource.indexOf('extern "C" {');
  const importBlockEndMarker = '} // extern "C"';
  const importBlockEnd = wasmSource.indexOf(importBlockEndMarker, importBlockStart);
  const wrapperBlockStart = wasmSource.indexOf("// ---- QpiContext method forwarders");
  const wrapperBlockEnd = wasmSource.indexOf("// ---- registration capture", wrapperBlockStart);

  if (
    importBlockStart < 0 ||
    importBlockEnd < 0 ||
    wrapperBlockStart < 0 ||
    wrapperBlockEnd < 0
  ) {
    throw new Error(`${wasmSourcePath} does not expose the expected import/wrapper source boundaries`);
  }

  return {
    importDeclarations: wasmSource.slice(
      importBlockStart,
      importBlockEnd + importBlockEndMarker.length,
    ),
    contextWrappers: wasmSource.slice(wrapperBlockStart, wrapperBlockEnd),
  };
}

function parseHostImportDeclarations(importSource: string): HostImportDeclarations {
  const symbolsBySourceName = new Map<string, string>();
  const declarationsByHostName = new Map<string, string>();

  for (const match of importSource.matchAll(
    /LH_IMPORT\((\w+)\)\s+[^;\n]*?\b(\w+)\s*\([^;\n]*\)\s*;/g,
  )) {
    const hostName = match[1];
    const sourceName = match[2];

    symbolsBySourceName.set(sourceName, hostName);
    declarationsByHostName.set(hostName, match[0]);
  }

  return { symbolsBySourceName, declarationsByHostName };
}

function validateHostImportDeclarations(
  declarationsByHostName: Map<string, string>,
  canonicalHostNames: string[],
  wasmSourcePath: string,
): void {
  if (declarationsByHostName.size === 0) {
    throw new Error(`${wasmSourcePath} declares no LH_IMPORT functions`);
  }

  const missingHostNames = canonicalHostNames.filter(
    (hostName) => !declarationsByHostName.has(hostName),
  );
  const extraHostNames = [...declarationsByHostName.keys()].filter(
    (hostName) => !canonicalHostNames.includes(hostName),
  );

  if (missingHostNames.length === 0 && extraHostNames.length === 0) {
    return;
  }

  throw new Error(
    `${wasmSourcePath} LH_IMPORT declarations differ from canonical metadata ` +
      `(missing: ${missingHostNames.join(", ") || "none"}; ` +
      `extra: ${extraHostNames.join(", ") || "none"})`,
  );
}

function normalizeImportedSymbolNames(
  source: string,
  symbolsBySourceName: Map<string, string>,
): string {
  let normalizedSource = source.replace(/LH_IMPORT\(\w+\)\s*/g, "");

  for (const [sourceName, hostName] of symbolsBySourceName) {
    normalizedSource = normalizedSource.replace(
      new RegExp(`\\b${sourceName}\\b`, "g"),
      `__lhost_${hostName}`,
    );
  }

  return normalizedSource;
}

function assembleHostWrapperChunk(
  wasmSource: string,
  wasmSourcePath: string,
  liteAbi: LiteAbi,
): string {
  const sections = extractWasmSourceSections(wasmSource, wasmSourcePath);
  const { symbolsBySourceName, declarationsByHostName } = parseHostImportDeclarations(
    sections.importDeclarations,
  );
  const canonicalHostNames = liteAbi.lhost.map((row) => row.name);

  validateHostImportDeclarations(declarationsByHostName, canonicalHostNames, wasmSourcePath);

  const orderedImportDeclarations = canonicalHostNames
    .map((hostName) => {
      return normalizeImportedSymbolNames(
        declarationsByHostName.get(hostName)!,
        symbolsBySourceName,
      );
    })
    .join("\n");
  const normalizedContextWrappers = normalizeImportedSymbolNames(
    sections.contextWrappers,
    symbolsBySourceName,
  );
  const wrapperSource =
    `extern "C" {\n${orderedImportDeclarations}\n} // extern "C"\n` +
    normalizedContextWrappers;

  return `\n${IMPL_BOUNDARY}\n${wrapperSource}\n`;
}

// Every file assembly may read, for content-hash caching and watch mode. oracle_interfaces/*.h are
export function snapshotInputFiles(corePath: string): string[] {
  const { existsSync, readdirSync } = loadNodeFileSystem();
  const base = `${corePath}/src`;
  const files = [
    `${base}/contract_core/contract_def.h`,
    `${base}/extensions/wasm/lite_wasm_tu.h`,
    `${base}/extensions/wasm/lite_wasm_target.h`,
    `${base}/extensions/wasm/lite_abi_metadata.h`,
    `${base}/extensions/wasm/lite_dyn_abi.h`,
    ...HEADER_FILES.map((HEADER_FILESItem) => `${base}/${HEADER_FILESItem}`),
    ...IMPL_FILES.map((IMPL_FILESItem) => `${base}/${IMPL_FILESItem}`),
  ];
  const oracleDir = `${base}/oracle_interfaces`;
  if (existsSync(oracleDir)) {
    for (const entryName of readdirSync(oracleDir)) {
      if (entryName.endsWith(".h")) files.push(`${oracleDir}/${entryName}`);
    }
  }
  return files;
}

export function assembleQpiHeader(corePath: string): string {
  const fileSystem = loadNodeFileSystem();
  const sourceDirectory = requireCoreSourceDirectory(corePath, fileSystem);
  const liteAbi = readLiteAbi(fileSystem, sourceDirectory);
  const contractIndexDefinitions = assembleContractIndexDefinitions(fileSystem, sourceDirectory);
  const headerDeclarations = assembleHeaderDeclarations(fileSystem, sourceDirectory);
  const wasmTranslationUnit = readWasmTranslationUnit(fileSystem, sourceDirectory);
  const contextBufferDeclaration = assembleContextBufferDeclaration(
    wasmTranslationUnit.source,
    wasmTranslationUnit.path,
  );
  const implementationChunks = assembleImplementationChunks(fileSystem, sourceDirectory);
  const hostWrapperChunk = assembleHostWrapperChunk(
    wasmTranslationUnit.source,
    wasmTranslationUnit.path,
    liteAbi,
  );

  return [
    `${QPI_PRELUDE}\n`,
    serializeLiteAbi(liteAbi),
    contractIndexDefinitions,
    headerDeclarations,
    contextBufferDeclaration,
    implementationChunks,
    hostWrapperChunk,
  ].join("");
}
