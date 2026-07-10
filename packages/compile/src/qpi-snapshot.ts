// Assembles the exact header text consumed by compiler pipeline.
import { QPI_PRELUDE } from "./qpi-prelude";

export const GENERATOR_VERSION = 1;

export const IMPL_BOUNDARY = "//__QINIT_IMPL_BOUNDARY__";

// Core snapshot inputs are resolved relative to `<core>/src`.
const HEADER_FILES = [
  "contract_core/pre_qpi_def.h",
  "contracts/qpi.h",
  "contract_core/qpi_proposal_voting.h",
  "oracle_core/oracle_interfaces_def.h",
];

// Template method-body implementations — parsed SEPARATELY (after the IMPL boundary) so qpi.h's bulk doesn't interfere with capturing the
const IMPL_FILES = [
  "contract_core/qpi_hash_map_impl.h",
  "contract_core/qpi_collection_impl.h",
  "contract_core/qpi_linked_list_impl.h",
  "contract_core/qpi_trivial_impl.h",
];

// Every file assembly may read, for content-hash caching and watch mode. oracle_interfaces/*.h are
export function snapshotInputFiles(corePath: string): string[] {
  const { existsSync, readdirSync } = require("node:fs") as typeof import("node:fs");
  const base = `${corePath}/src`;
  const files = [
    `${base}/contract_core/contract_def.h`,
    ...HEADER_FILES.map((f) => `${base}/${f}`),
    ...IMPL_FILES.map((f) => `${base}/${f}`),
  ];
  const oracleDir = `${base}/oracle_interfaces`;
  if (existsSync(oracleDir)) {
    for (const f of readdirSync(oracleDir)) {
      if (f.endsWith(".h")) files.push(`${oracleDir}/${f}`);
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

  // Contract slot registry: contracts reference each other's indices (QX_CONTRACT_INDEX in Logger events, share-management filters, inter-contract transfers). Native gets
  const defPath = `${base}/contract_core/contract_def.h`;
  if (existsSync(defPath)) {
    const indexDefines = readFileSync(defPath, "utf8")
      .split("\n")
      .filter((l) => /^#define \w+_CONTRACT_INDEX \d+\s*$/.test(l));
    content += indexDefines.join("\n") + "\n";
  }

  for (const f of HEADER_FILES) {
    const fp = `${base}/${f}`;
    if (!existsSync(fp)) continue;
    let text = readFileSync(fp, "utf8");
    // The oracle def header pulls each interface (OI::Price, …) in via #include, which the preprocessor treats as a
    if (f.endsWith("oracle_interfaces_def.h")) {
      text = text.replace(/^[ \t]*#include[ \t]+"(oracle_interfaces\/\w+\.h)"[ \t]*$/gm, (line, rel) => {
        const ip = `${base}/${rel}`;
        return existsSync(ip) ? readFileSync(ip, "utf8") : line;
      });
    }
    content += text + "\n";
  }

  for (const f of IMPL_FILES) {
    const fp = `${base}/${f}`;
    // Strip #include lines — impl chunks are parsed standalone for their method/free-fn bodies; the headers they pull in
    if (existsSync(fp)) content += `\n${IMPL_BOUNDARY}\n` + readFileSync(fp, "utf8").replace(/^[ \t]*#include[ \t].*$/gm, "") + "\n";
  }

  return content;
}
