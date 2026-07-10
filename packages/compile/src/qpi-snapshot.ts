// QPI header snapshot assembly — the single source of the header text the compiler parses.
// Node/Bun only (reads a core-lite checkout); browsers consume the pre-generated snapshot via
// @qinit/compile/browser. Shared by loadQpiHeader, the local dev preparation step, and release CI
// (tools/gen-qpi-snapshot.ts), so all three produce byte-identical content.
//
// Bump GENERATOR_VERSION whenever the assembly below changes shape (file list, prelude, inlining
// rules) — it invalidates cached snapshots and is verified against core-snapshot.json in CI.
import { QPI_PRELUDE } from "./qpi-prelude";

export const GENERATOR_VERSION = 1;

export const IMPL_BOUNDARY = "//__QINIT_IMPL_BOUNDARY__";

// The core files a snapshot is assembled from, relative to <core>/src. Missing optional files are
// skipped (matching historical loadQpiHeader behavior, so output stays byte-identical); a missing
// contracts/qpi.h means the path is not a core checkout and assembly throws.
const HEADER_FILES = [
  "contract_core/pre_qpi_def.h",
  "contracts/qpi.h",
  "contract_core/qpi_proposal_voting.h",
  "oracle_core/oracle_interfaces_def.h",
];

// Template method-body implementations — parsed SEPARATELY (after the IMPL boundary) so qpi.h's
// bulk doesn't interfere with capturing the out-of-class definitions, then instantiated per type.
const IMPL_FILES = [
  "contract_core/qpi_hash_map_impl.h",
  "contract_core/qpi_collection_impl.h",
  "contract_core/qpi_linked_list_impl.h",
  "contract_core/qpi_trivial_impl.h",
];

// Every file assembly may read, for content-hash caching and watch mode. oracle_interfaces/*.h are
// discovered dynamically (they're inlined into oracle_interfaces_def.h).
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

  // Contract slot registry: contracts reference each other's indices (QX_CONTRACT_INDEX in
  // Logger events, share-management filters, inter-contract transfers). Native gets these from
  // contract_def.h; only its object-like index defines are extracted — the full header also
  // #includes every contract, which is not parseable here and not needed.
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
    // The oracle def header pulls each interface (OI::Price, …) in via #include, which the
    // preprocessor treats as a no-op — inline the interface headers so the OI structs exist.
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
    // Strip #include lines — impl chunks are parsed standalone for their method/free-fn bodies; the
    // headers they pull in (four_q.h / kangaroo_twelve.h) aren't needed to parse and blow up the lexer.
    if (existsSync(fp)) content += `\n${IMPL_BOUNDARY}\n` + readFileSync(fp, "utf8").replace(/^[ \t]*#include[ \t].*$/gm, "") + "\n";
  }

  return content;
}
