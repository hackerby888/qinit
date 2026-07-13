import type { Declaration } from "../ast";
import { generateWasmModule, type GeneratedContractMetadata } from "../codegen";
import { findContractStruct } from "../codegen/module";
import type { StructDecl } from "../ast";
import { Sema } from "../sema";
import { getQpiContext } from "./qpi-context";
import { parseToAst } from "./parse-ast";
import type { CompileOpts, GtestCompileResult, GtestDiagnostic, GtestProgram } from "./types";

interface TestBlock {
  name: string;
  body: string;
  start: number;
  end: number;
  line: number;
}

const RUNNER_SLOT = 65534;

const EMPTY_IDL = (opts: CompileOpts) => ({
  name: opts.name,
  slot: opts.slot,
  functions: [],
  procedures: [],
  stateSize: 0,
  sysprocMask: 0,
});

function diagnostic(message: string, line = 1, col = 1): GtestDiagnostic {
  return { severity: "error", message, span: { start: 0, end: 0, line, col } };
}

function matchingBrace(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split("\n").length;
}

// TEST is a source macro boundary, not a second C++ language. We only locate its balanced body here;
// every statement and expression inside the body is parsed and lowered by the normal compiler frontend.
function extractTests(source: string): TestBlock[] {
  const tests: TestBlock[] = [];
  const re = /\bTEST\s*\(\s*([A-Za-z_]\w*)\s*,\s*([A-Za-z_]\w*)\s*\)\s*\{/g;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    const open = source.indexOf("{", match.index);
    const close = matchingBrace(source, open);
    if (close < 0) break;
    tests.push({
      name: `${match[1]}.${match[2]}`,
      body: source.slice(open + 1, close),
      start: match.index,
      end: close + 1,
      line: lineAt(source, match.index),
    });
    re.lastIndex = close + 1;
  }
  return tests;
}

function withoutTests(source: string, tests: TestBlock[]): string {
  const chars = [...source];
  for (const test of tests) {
    for (let i = test.start; i < test.end; i++) if (chars[i] !== "\n") chars[i] = " ";
  }
  return chars.join("");
}

function sanitize(name: string, index: number): string {
  return `__qtest_${index}_${name.replace(/\W/g, "_")}`;
}

function stripAssertionStreams(source: string): string {
  const chars = [...source];
  const re = /\b(?:EXPECT|ASSERT)_(?:EQ|NE|LT|LE|GT|GE|TRUE|FALSE)\s*\(/g;
  for (let match = re.exec(source); match; match = re.exec(source)) {
    const open = source.indexOf("(", match.index);
    let depth = 0;
    let quote = "";
    let close = -1;
    for (let i = open; i < source.length; i++) {
      const ch = source[i];
      if (quote) {
        if (ch === "\\") i++;
        else if (ch === quote) quote = "";
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === "(") depth++;
      else if (ch === ")" && --depth === 0) {
        close = i;
        break;
      }
    }
    if (close < 0) continue;
    let tail = close + 1;
    while (/\s/.test(source[tail] ?? "")) tail++;
    if (source.slice(tail, tail + 2) !== "<<") continue;
    let end = tail + 2;
    quote = "";
    for (; end < source.length; end++) {
      const ch = source[end];
      if (quote) {
        if (ch === "\\") end++;
        else if (ch === quote) quote = "";
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === ";") break;
    }
    for (let i = close + 1; i < end; i++) if (chars[i] !== "\n") chars[i] = " ";
    re.lastIndex = end;
  }
  return chars.join("");
}

function assertionMacros(): string {
  const lines: string[] = ["#define INIT_CONTRACT(x) __qtest_noop()", "#define INITIALIZE 0"];
  for (const family of ["EXPECT", "ASSERT"] as const) {
    for (const op of ["EQ", "NE", "LT", "LE", "GT", "GE"] as const) {
      lines.push(
        `#define ${family}_${op}(a,b) __qtest_${family.toLowerCase()}_${op.toLowerCase()}((a),(b))`,
      );
    }
    lines.push(`#define ${family}_TRUE(a) __qtest_${family.toLowerCase()}_true((a))`);
    lines.push(`#define ${family}_FALSE(a) __qtest_${family.toLowerCase()}_false((a))`);
  }
  return lines.join("\n");
}

function testSourceForCompiler(
  opts: CompileOpts & { testSource: string },
  tests: TestBlock[],
  stateSize: number,
): string {
  const escapedName = opts.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const transform = (source: string) =>
    stripAssertionStreams(source)
      .replace(new RegExp(`\\b${escapedName}_CONTRACT_INDEX\\b`, "g"), String(opts.slot))
      .replace(/contractStates\s*\[([^\]]+)\]/g, `__qtest_state($1, ${stateSize})`);
  const support = withoutTests(opts.testSource, tests).replace(/^\s*#\s*include[^\n]*$/gm, "");
  const transformedSupport = transform(support);
  const members = tests
    .map((test, index) => {
      const method = sanitize(test.name, index);
      return `
  struct ${method}_input {};
  struct ${method}_output {};
  PUBLIC_PROCEDURE(${method}) {
${transform(test.body)}
  }`;
    })
    .join("\n");
  const registrations = tests
    .map(
      (test, index) => `    REGISTER_USER_PROCEDURE(${sanitize(test.name, index)}, ${index + 1});`,
    )
    .join("\n");

  return `${assertionMacros()}
class ContractTesting {};
${transformedSupport}

struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {};
${members}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
${registrations}
  }
};`;
}

async function assemble(wat: string): Promise<Uint8Array> {
  const wabt = await import("wabt");
  const module = await wabt.default();
  const parsed = module.parseWat("gtest.wat", wat);
  parsed.validate();
  const wasm = new Uint8Array(parsed.toBinary({}).buffer);
  if (!WebAssembly.validate(wasm))
    throw new Error("generated gtest module failed WebAssembly validation");
  return wasm;
}

export async function compileCoreGtest(
  opts: CompileOpts & { testSource: string },
): Promise<GtestCompileResult> {
  const diagnostics: GtestDiagnostic[] = [];
  const idl = EMPTY_IDL(opts);
  if (/\bContractTest\b|lite_test\.h/.test(opts.testSource)) {
    diagnostics.push(
      diagnostic(
        "legacy ContractTest/lite_test.h tests are not supported; use core-lite contract_testing.h and ContractTesting",
      ),
    );
    return { diagnostics, idl };
  }
  if (!/contract_testing\.h|\bContractTesting\b/.test(opts.testSource)) {
    diagnostics.push(
      diagnostic("gtest source must use core-lite contract_testing.h / ContractTesting"),
    );
    return { diagnostics, idl };
  }

  const tests = extractTests(opts.testSource);
  if (!tests.length) {
    diagnostics.push(diagnostic("no TEST(Suite, Name) cases found"));
    return { diagnostics, idl };
  }

  if (opts.qpiHeader === undefined)
    throw new Error("internal gtest compiler requires a QPI header snapshot");
  const qpiHeader = opts.qpiHeader;
  const target = parseToAst({ source: opts.source, qpiHeader, name: opts.name, slot: opts.slot });
  diagnostics.push(...target.diagnostics);
  const qpi = getQpiContext(qpiHeader);
  const targetSema = new Sema();
  const targetMetadata: GeneratedContractMetadata = { stateSize: 0, entries: [], sysprocMask: 0 };
  try {
    generateWasmModule(
      target.ast,
      targetSema,
      opts.name,
      opts.slot,
      opts.arenaSz ?? 16 * 1024 * 1024,
      qpi.lib,
      undefined,
      undefined,
      undefined,
      undefined,
      targetMetadata,
    );
  } catch (error) {
    diagnostics.push(
      diagnostic(
        `Contract codegen failed while compiling gtest: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  diagnostics.push(...targetSema.getDiagnostics());
  const runnerName = "QinitGtestRunner";
  const runnerSource = testSourceForCompiler(opts, tests, targetMetadata.stateSize);
  if ((globalThis as any).process?.env?.QINIT_DUMP_GTEST_SOURCE) {
    const fs = await import("node:fs");
    fs.writeFileSync((globalThis as any).process.env.QINIT_DUMP_GTEST_SOURCE, runnerSource);
  }
  const runner = parseToAst({
    source: runnerSource,
    qpiHeader,
    name: runnerName,
    slot: RUNNER_SLOT,
  });
  diagnostics.push(...runner.diagnostics);
  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics, idl };

  // Runner declarations come first so findContractStruct selects it. The target contract AST is still present
  // as a normal global struct, providing the authoritative nested input/output/state layouts used by fixtures.
  const declarations: Declaration[] = [...runner.ast.declarations, ...target.ast.declarations];
  const targetStruct = findContractStruct(target.ast);
  const targetTypes = new Map<string, StructDecl>();
  for (const member of targetStruct?.members ?? []) {
    if (member.kind === "struct")
      targetTypes.set(`${opts.name}::${member.name}`, member as StructDecl);
  }
  const sema = new Sema();
  const metadata: GeneratedContractMetadata = { stateSize: 0, entries: [], sysprocMask: 0 };
  let wat: string;
  try {
    wat = generateWasmModule(
      { declarations },
      sema,
      runnerName,
      RUNNER_SLOT,
      opts.arenaSz ?? 16 * 1024 * 1024,
      qpi.lib,
      undefined,
      targetTypes,
      [{ name: opts.name, decls: target.ast.declarations }],
      undefined,
      metadata,
      true,
    );
  } catch (error) {
    diagnostics.push(
      diagnostic(`Gtest codegen failed: ${error instanceof Error ? error.message : String(error)}`),
    );
    return { diagnostics, idl };
  }

  if ((globalThis as any).process?.env?.QINIT_DUMP_WAT) {
    const fs = await import("node:fs");
    fs.writeFileSync((globalThis as any).process.env.QINIT_DUMP_WAT, wat);
  }

  diagnostics.push(...sema.getDiagnostics());
  if (opts.strict !== false) {
    for (const item of diagnostics) if (item.category === "fidelity") item.severity = "error";
  }
  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics, idl };

  try {
    const wasm = await assemble(wat);
    const program: GtestProgram = {
      version: 2,
      contract: opts.name,
      mainSlot: opts.slot,
      runnerSlot: RUNNER_SLOT,
      mainConstructionEpoch: opts.constructionEpoch ?? 0,
      tests: tests.map((test, index) => ({ name: test.name, inputType: index + 1 })),
    };
    return { wasm, program, diagnostics, idl };
  } catch (error) {
    diagnostics.push(
      diagnostic(
        `Gtest WAT assembly failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
    return { diagnostics, idl };
  }
}
