import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import {
  analyzeContract,
  DiagnosticSeverity,
  type AnalyzeContractOptions,
} from "@qinit/compile/analyzer";
import { loadQpiHeader } from "@qinit/compile";

export interface CalleeDef {
  type: string;
  index: number;
  include: string;
}

export function parseContractDef(corePath: string): Map<string, CalleeDef> {
  const source = readFileSync(
    join(corePath, "src/contract_core/contract_def.h"),
    "utf8",
  );
  const indexes = new Map<string, number>();

  for (const match of source.matchAll(
    /#define\s+(\w+)_CONTRACT_INDEX\s+(\d+)/g,
  )) {
    indexes.set(match[1], Number(match[2]));
  }

  const definitions = new Map<string, CalleeDef>();
  const blockPattern =
    /#define\s+CONTRACT_INDEX\s+(\w+)_CONTRACT_INDEX\s*\n\s*#define\s+CONTRACT_STATE_TYPE\s+(\w+)\s*\n\s*#define\s+CONTRACT_STATE2_TYPE\s+\w+\s*\n(?:\s*#ifdef\s+\w+\s*\n\s*#include\s+"[^"]+"\s*\n\s*#else\s*\n)?\s*#include\s+"([^"]+)"/g;

  for (const match of source.matchAll(blockPattern)) {
    const index = indexes.get(match[1]);
    if (index !== undefined) {
      definitions.set(match[2], {
        type: match[2],
        index,
        include: match[3],
      });
    }
  }

  return definitions;
}

type SourceOptions = Pick<AnalyzeContractOptions, "name" | "slot" | "qpiHeader">;

export function scanCallees(
  source: string,
  options: SourceOptions = {},
): Set<string> {
  const analysis = analyzeContract({ source, ...options });
  return new Set(analysis.calls.map((call) => call.callee));
}

export function parseRegisters(
  source: string,
  options: SourceOptions = {},
): { fn: string; n: number }[] {
  const analysis = analyzeContract({ source, ...options });

  if (!analysis.idl) {
    const message = analysis.diagnostics
      .filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)
      .map((diagnostic) => diagnostic.message)
      .join("; ");
    throw new Error(message || "compiler did not produce contract IDL");
  }
  return [...analysis.idl.functions, ...analysis.idl.procedures].map((entry) => ({
    fn: entry.name,
    n: entry.inputType,
  }));
}

export type DynCallees = Record<string, { header: string; index: number }>;

export function contractIndexDefines(corePath: string): string {
  let source: string;

  try {
    source = readFileSync(
      join(corePath, "src/contract_core/contract_def.h"),
      "utf8",
    );
  } catch {
    return "";
  }

  let output =
    "// ---- all contract indices (contract_def.h) so a directly-#included sibling resolves ----\n";
  for (const match of source.matchAll(
    /#define\s+(\w+)_CONTRACT_INDEX\s+(\d+)/g,
  )) {
    output += `#ifndef ${match[1]}_CONTRACT_INDEX\n#define ${match[1]}_CONTRACT_INDEX ${match[2]}\n#endif\n`;
  }

  return output;
}

export function buildCalleePrelude(
  corePath: string,
  contractSource: string,
  dynamicCallees: DynCallees = {},
  selfType?: string,
): string {
  const indexBlock = contractIndexDefines(corePath);
  let definitions: Map<string, CalleeDef>;

  try {
    definitions = parseContractDef(corePath);
  } catch {
    definitions = new Map();
  }

  let wanted = scanCallees(contractSource, { name: selfType });
  for (const type of new Set([
    ...definitions.keys(),
    ...Object.keys(dynamicCallees),
  ])) {
    if (
      type !== selfType &&
      new RegExp(`\\b${type}(?:::|_[A-Z])`).test(contractSource)
    ) {
      wanted.add(type);
    }
  }

  if (wanted.size === 0) {
    return indexBlock;
  }

  let qpiHeader: string | undefined;

  try {
    qpiHeader = loadQpiHeader(corePath);
  } catch (error) {
    if (![...wanted].every((type) => dynamicCallees[type])) {
      throw error;
    }
  }

  const sourceOptions = {
    name: selfType,
    qpiHeader,
  };
  wanted = scanCallees(contractSource, sourceOptions);

  for (const type of new Set([
    ...definitions.keys(),
    ...Object.keys(dynamicCallees),
  ])) {
    if (
      type !== selfType &&
      new RegExp(`\\b${type}(?:::|_[A-Z])`).test(contractSource)
    ) {
      wanted.add(type);
    }
  }

  interface ResolvedCallee {
    type: string;
    index: number;
    include: string;
    src: string;
  }

  const resolved = new Map<string, ResolvedCallee>();
  const resolveCallee = (type: string) => {
    if (resolved.has(type)) {
      return;
    }

    let callee: ResolvedCallee;

    if (dynamicCallees[type]) {
      callee = {
        type,
        index: dynamicCallees[type].index,
        include: dynamicCallees[type].header,
        src: readFileSync(dynamicCallees[type].header, "utf8"),
      };
    } else if (definitions.has(type)) {
      const definition = definitions.get(type)!;
      callee = {
        type,
        index: definition.index,
        include: definition.include,
        src: readFileSync(join(corePath, "src", definition.include), "utf8"),
      };
    } else {
      throw new Error(
        `inter-contract: unknown callee '${type}' (not in contract_def.h, not a declared dynamic callee)`,
      );
    }

    resolved.set(type, callee);

    const nestedCallees = scanCallees(callee.src, {
      name: type,
      slot: callee.index,
      qpiHeader,
    });
    for (const nestedType of nestedCallees) {
      resolveCallee(nestedType);
    }
  };

  for (const calleeType of wanted) {
    resolveCallee(calleeType);
  }

  const callees = [...resolved.values()].sort(
    (left, right) => left.index - right.index,
  );
  let output =
    "// ---- inter-contract callees (auto-derived from contract_def.h) ----\n";

  for (const callee of callees) {
    output += `#define CONTRACT_STATE2_TYPE ${callee.type}2\n#define CONTRACT_STATE_TYPE ${callee.type}\n#define CONTRACT_INDEX ${callee.index}\n`;
    output += `#include "${callee.include}"\n`;
    output += `#undef CONTRACT_INDEX\n#undef CONTRACT_STATE_TYPE\n#undef CONTRACT_STATE2_TYPE\n`;
  }

  output += "// ---- callee <Type>_CONTRACT_INDEX constants ----\n";
  for (const callee of callees) {
    output += `#ifndef ${callee.type}_CONTRACT_INDEX\n#define ${callee.type}_CONTRACT_INDEX ${callee.index}\n#endif\n`;
  }

  output += "// ---- generated <Type>_<fn>_inputType constants ----\n";
  for (const callee of callees) {
    const registrations = parseRegisters(callee.src, {
      name: callee.type,
      slot: callee.index,
      qpiHeader,
    });
    for (const registration of registrations) {
      output += `static constexpr unsigned short ${callee.type}_${registration.fn}_inputType = ${registration.n};\n`;
    }
  }

  output += `#include "${CORE_WASM_HEADERS.sdk.intercontractCalls}"\n`;
  return indexBlock + output;
}
