// Assembles the exact header text consumed by compiler pipeline.
import { QPI_PRELUDE } from "./qpi-prelude";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import { parseWasmAbiSource } from "@qinit/core/wasm-abi-source";
import { GENERATOR_VERSION, IMPL_BOUNDARY, WASM_ABI_MARKER } from "./qpi-snapshot-format";

export {
  embeddedWasmAbi,
  GENERATOR_VERSION,
  IMPL_BOUNDARY,
  WASM_ABI_MARKER,
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
type WasmAbi = ReturnType<typeof parseWasmAbiSource>;

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

function readWasmAbi(fileSystem: NodeFileSystem, sourceDirectory: string): WasmAbi {
  return parseWasmAbiSource(
    fileSystem.readFileSync(
      `${sourceDirectory}/${CORE_WASM_HEADERS.shared.abiMetadata}`,
      "utf8",
    ),
    fileSystem.readFileSync(`${sourceDirectory}/${CORE_WASM_HEADERS.shared.abiTypes}`, "utf8"),
  );
}

function serializeWasmAbi(wasmAbi: WasmAbi): string {
  return `${WASM_ABI_MARKER}${JSON.stringify(wasmAbi)}\n`;
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

function readWasmSdkHeader(
  fileSystem: NodeFileSystem,
  sourceDirectory: string,
  relativePath: string,
): { path: string; source: string } {
  const path = `${sourceDirectory}/${relativePath}`;
  if (!fileSystem.existsSync(path)) {
    throw new Error(`${path} not found`);
  }

  return { path, source: fileSystem.readFileSync(path, "utf8") };
}

function assembleContextBufferDeclaration(moduleStorageSource: string, sourcePath: string): string {
  const contextBuffer = /\bmoduleContextStorage\s*\[\s*(\d+)\s*\]/.exec(moduleStorageSource);

  if (!contextBuffer) {
    throw new Error(`${sourcePath} does not declare moduleContextStorage capacity`);
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

function stripSdkHeaderScaffolding(source: string): string {
  return source
    .replace(/^[ \t]*#pragma once[ \t]*\r?\n/gm, "")
    .replace(/^[ \t]*#include[ \t]+.*\r?\n/gm, "")
    .replace(/^[ \t]*#ifdef[ \t]+LITE_WASM_TU_BUILD[ \t]*\r?\n/gm, "")
    .replace(/^[ \t]*#endif[ \t]*(?:\/\/.*)?\r?\n?/gm, "")
    .trim();
}

function assembleHostWrapperChunk(
  importSource: string,
  importSourcePath: string,
  forwarderSource: string,
  wasmAbi: WasmAbi,
): string {
  const { symbolsBySourceName, declarationsByHostName } = parseHostImportDeclarations(
    importSource,
  );
  const canonicalHostNames = wasmAbi.lhost.map((row) => row.name);

  validateHostImportDeclarations(declarationsByHostName, canonicalHostNames, importSourcePath);

  const orderedImportDeclarations = canonicalHostNames
    .map((hostName) => {
      return normalizeImportedSymbolNames(
        declarationsByHostName.get(hostName)!,
        symbolsBySourceName,
      );
    })
    .join("\n");
  const normalizedContextWrappers = normalizeImportedSymbolNames(
    stripSdkHeaderScaffolding(forwarderSource),
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
    `${base}/${CORE_WASM_HEADERS.shared.abiMetadata}`,
    `${base}/${CORE_WASM_HEADERS.shared.abiTypes}`,
    `${base}/${CORE_WASM_HEADERS.sdk.lhostImports}`,
    `${base}/${CORE_WASM_HEADERS.sdk.qpiForwarders}`,
    `${base}/${CORE_WASM_HEADERS.sdk.moduleStorage}`,
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
  const wasmAbi = readWasmAbi(fileSystem, sourceDirectory);
  const contractIndexDefinitions = assembleContractIndexDefinitions(fileSystem, sourceDirectory);
  const headerDeclarations = assembleHeaderDeclarations(fileSystem, sourceDirectory);
  const lhostImports = readWasmSdkHeader(
    fileSystem,
    sourceDirectory,
    CORE_WASM_HEADERS.sdk.lhostImports,
  );
  const qpiForwarders = readWasmSdkHeader(
    fileSystem,
    sourceDirectory,
    CORE_WASM_HEADERS.sdk.qpiForwarders,
  );
  const moduleStorage = readWasmSdkHeader(
    fileSystem,
    sourceDirectory,
    CORE_WASM_HEADERS.sdk.moduleStorage,
  );
  const contextBufferDeclaration = assembleContextBufferDeclaration(
    moduleStorage.source,
    moduleStorage.path,
  );
  const implementationChunks = assembleImplementationChunks(fileSystem, sourceDirectory);
  const hostWrapperChunk = assembleHostWrapperChunk(
    lhostImports.source,
    lhostImports.path,
    qpiForwarders.source,
    wasmAbi,
  );

  return [
    `${QPI_PRELUDE}\n`,
    serializeWasmAbi(wasmAbi),
    contractIndexDefinitions,
    headerDeclarations,
    contextBufferDeclaration,
    implementationChunks,
    hostWrapperChunk,
  ].join("");
}
