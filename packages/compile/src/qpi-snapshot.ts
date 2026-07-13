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

// Every file assembly may read, for content-hash caching and watch mode. oracle_interfaces/*.h are
export function snapshotInputFiles(corePath: string): string[] {
  const { existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const base = `${corePath}/src`;
  const files = [
    `${base}/contract_core/contract_def.h`,
    `${base}/extensions/lite_wasm_tu.h`,
    `${base}/extensions/lite_wasm_target.h`,
    `${base}/extensions/lite_abi_metadata.h`,
    `${base}/extensions/lite_dyn_abi.h`,
    ...HEADER_FILES.map((HEADER_FILESItem) => `${base}/${HEADER_FILESItem}`),
    ...IMPL_FILES.map((IMPL_FILESItem) => `${base}/${IMPL_FILESItem}`),
  ];
  const oracleDir = `${base}/oracle_interfaces`;
  if (existsSync(oracleDir)) {
    for (const itemItem of readdirSync(oracleDir)) {
      if (itemItem.endsWith(".h")) files.push(`${oracleDir}/${itemItem}`);
    }
  }
  return files;
}

export function assembleQpiHeader(corePath: string): string {
  const { readFileSync, existsSync } = require("node:fs") as typeof import("node:fs");
  const base = `${corePath}/src`;
  if (!existsSync(`${base}/contracts/qpi.h`)) {
    throw new Error(`${corePath} is not a core checkout — ${base}/contracts/qpi.h not found`);
  }

  let content = QPI_PRELUDE + "\n";
  const liteAbi = parseLiteAbiSource(
    readFileSync(`${base}/extensions/lite_abi_metadata.h`, "utf8"),
    readFileSync(`${base}/extensions/lite_dyn_abi.h`, "utf8"),
  );
  content += `${LITE_ABI_MARKER}${JSON.stringify(liteAbi)}\n`;

  // Contract slot registry: contracts reference each other's indices (QX_CONTRACT_INDEX in Logger events, share-management filters, inter-contract transfers). Native gets
  const defPath = `${base}/contract_core/contract_def.h`;
  if (existsSync(defPath)) {
    const indexDefines = readFileSync(defPath, "utf8")
      .split("\n")
      .filter((text) => /^#define \w+_CONTRACT_INDEX \d+\s*$/.test(text));
    content += indexDefines.join("\n") + "\n";
  }

  for (const HEADER_FILESItem of HEADER_FILES) {
    const fp = `${base}/${HEADER_FILESItem}`;
    if (!existsSync(fp)) continue;
    let text = readFileSync(fp, "utf8");
    // The oracle def header pulls each interface (OI::Price, …) in via #include, which the preprocessor treats as a
    if (HEADER_FILESItem.endsWith("oracle_interfaces_def.h")) {
      text = text.replace(
        /^[ \t]*#include[ \t]+"(oracle_interfaces\/\w+\.h)"[ \t]*$/gm,
        (line, rel) => {
          const ip = `${base}/${rel}`;
          return existsSync(ip) ? readFileSync(ip, "utf8") : line;
        },
      );
    }
    content += text + "\n";
  }

  const wasmTuPath = `${base}/extensions/lite_wasm_tu.h`;
  const wasmTu = existsSync(wasmTuPath) ? readFileSync(wasmTuPath, "utf8") : "";
  const contextBuffer = /\bg_wasmCtxBuf\s*\[\s*(\d+)\s*\]/.exec(wasmTu);
  if (!contextBuffer) throw new Error(`${wasmTuPath} does not declare g_wasmCtxBuf capacity`);
  content += `\nstatic constexpr unsigned long long __qinit_qpi_context_buffer_size = ${contextBuffer[1]};\n`;

  for (const IMPL_FILESItem of IMPL_FILES) {
    const fp = `${base}/${IMPL_FILESItem}`;
    // Strip #include lines — impl chunks are parsed standalone for their method/free-fn bodies; the headers they pull in
    if (existsSync(fp))
      content +=
        `\n${IMPL_BOUNDARY}\n` +
        readFileSync(fp, "utf8").replace(/^[ \t]*#include[ \t].*$/gm, "") +
        "\n";
  }

  // Parse the real contract-side import declarations and QPI wrapper bodies. Normalize imported symbol
  // names to their canonical host name so the frontend can derive the Wasm ABI from C++ types without a
  // second handwritten mapping (several C symbols intentionally differ from their import name).
  const importStart = wasmTu.indexOf('extern "C" {');
  const importEndMarker = '} // extern "C"';
  const importEnd = wasmTu.indexOf(importEndMarker, importStart);
  const wrapperStart = wasmTu.indexOf("// ---- QpiContext method forwarders");
  const wrapperEnd = wasmTu.indexOf("// ---- registration capture", wrapperStart);
  if (importStart < 0 || importEnd < 0 || wrapperStart < 0 || wrapperEnd < 0) {
    throw new Error(`${wasmTuPath} does not expose the expected import/wrapper source boundaries`);
  }
  const importSource = wasmTu.slice(importStart, importEnd + importEndMarker.length);
  const wrapperBody = wasmTu.slice(wrapperStart, wrapperEnd);
  const importedSymbols = new Map<string, string>();
  const declarations = new Map<string, string>();
  for (const match of importSource.matchAll(
    /LH_IMPORT\((\w+)\)\s+[^;\n]*?\b(\w+)\s*\([^;\n]*\)\s*;/g,
  )) {
    importedSymbols.set(match[2], match[1]);
    declarations.set(match[1], match[0]);
  }
  if (!importedSymbols.size) throw new Error(`${wasmTuPath} declares no LH_IMPORT functions`);
  const canonicalNames = liteAbi.lhost.map((row) => row.name);
  const missing = canonicalNames.filter((name) => !declarations.has(name));
  const extra = [...declarations.keys()].filter((name) => !canonicalNames.includes(name));
  if (missing.length || extra.length) {
    throw new Error(
      `${wasmTuPath} LH_IMPORT declarations differ from canonical metadata (missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"})`,
    );
  }
  const normalizeSymbols = (source: string): string => {
    let normalized = source.replace(/LH_IMPORT\(\w+\)\s*/g, "");
    for (const [symbol, hostName] of importedSymbols) {
      normalized = normalized.replace(new RegExp(`\\b${symbol}\\b`, "g"), `__lhost_${hostName}`);
    }
    return normalized;
  };
  const orderedImports = canonicalNames
    .map((name) => normalizeSymbols(declarations.get(name)!))
    .join("\n");
  const wrapperSource = `extern "C" {\n${orderedImports}\n} // extern "C"\n${normalizeSymbols(wrapperBody)}`;
  content += `\n${IMPL_BOUNDARY}\n${wrapperSource}\n`;

  return content;
}
