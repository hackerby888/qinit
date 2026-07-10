import type { TranslationUnit } from "../ast";
import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { Sema } from "../sema";
import { validateAndDesugar } from "../validate";
import { generateWasmModule, type GeneratedContractMetadata } from "../codegen";
import { QPI_STUB } from "../qpi-stub";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import { buildCalleeContext } from "./callees";
import {
  makeUserDiagnosticRemapper,
  scanUnterminatedSource,
  sourceWithoutLeadingBom,
  USER_BOUNDARY,
} from "./diagnostics";
import { extractIdl } from "./idl";
import { validateCompileOpts } from "./options";
import { getQpiContext } from "./qpi-context";
import type { CompileOpts, CompileResult } from "./types";

export interface ParseAstResult {
  ast: TranslationUnit;
  diagnostics: ParserDiagnostic[];
}

function emptyResult(opts: CompileOpts, diagnostics: ParserDiagnostic[], timings?: Record<string, number>): CompileResult {
  return {
    wasm: new Uint8Array(0),
    diagnostics,
    idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
    ...(timings ? { timings } : {}),
  };
}

export function parseToAst(opts: { source: string; qpiHeader?: string; name?: string; slot?: number }): ParseAstResult {
  const qpi = getQpiContext(opts.qpiHeader ?? QPI_STUB);
  const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(opts.source)}`;
  const text = new Preprocessor().preprocess({
    source,
    qpiHeader: "",
    contractName: opts.name ?? "Contract",
    contractIndex: opts.slot ?? 0,
    seedMacros: qpi.macros,
  });
  const boundaryIndex = text.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIndex >= 0 ? text.slice(0, boundaryIndex).split("\n").length : 0;
  const remap = makeUserDiagnosticRemapper(opts.source, text, boundaryLine);
  const parser = new Parser(new Lexer(text).tokenize());
  const unit = parser.parseTranslationUnit();
  const declarations = unit.declarations.filter(
    (declaration) => (declaration.span?.line ?? 0) > boundaryLine && (declaration as { name?: string }).name !== USER_BOUNDARY,
  );
  const diagnostics = [
    ...scanUnterminatedSource(opts.source),
    ...parser.getDiagnostics().filter((diagnostic) => diagnostic.span.line > boundaryLine).map(remap),
  ].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  return { ast: { ...unit, declarations }, diagnostics };
}

export async function compileContract(opts: CompileOpts): Promise<CompileResult> {
  const diagnostics: ParserDiagnostic[] = [
    ...validateCompileOpts(opts),
    ...(typeof opts.source === "string" ? scanUnterminatedSource(opts.source) : []),
  ];
  if (diagnostics.length > 0) return emptyResult(opts, diagnostics);

  const timings: Record<string, number> = {};
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let lastName = "";
  let lastStart = now();
  const phase = async (name: string): Promise<void> => {
    const time = now();
    if (lastName) timings[lastName] = time - lastStart;
    if (opts.onPhase) {
      await opts.onPhase(name);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    lastName = name;
    lastStart = now();
  };
  const closePhase = () => {
    if (lastName) timings[lastName] = now() - lastStart;
    lastName = "";
  };

  await phase("loading qpi.h");
  const qpi = getQpiContext(opts.qpiHeader ?? QPI_STUB);

  await phase("preprocessing");
  const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(opts.source)}`;
  const text = new Preprocessor().preprocess({
    source,
    qpiHeader: "",
    contractName: opts.name,
    contractIndex: opts.slot,
    seedMacros: qpi.macros,
  });
  const boundaryIndex = text.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIndex >= 0 ? text.slice(0, boundaryIndex).split("\n").length : 0;
  const remap = makeUserDiagnosticRemapper(opts.source, text, boundaryLine);

  await phase("parsing");
  const parser = new Parser(new Lexer(text).tokenize());
  const unit = parser.parseTranslationUnit();
  diagnostics.push(...parser.getDiagnostics().filter((diagnostic) => diagnostic.span.line > boundaryLine).map(remap));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return emptyResult(opts, diagnostics);

  await phase("validating");
  diagnostics.push(...validateAndDesugar(unit).filter((diagnostic) => diagnostic.span.line > boundaryLine).map(remap));
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return emptyResult(opts, diagnostics);

  await phase("analyzing");
  const sema = new Sema();
  const callees = buildCalleeContext(opts, qpi);
  diagnostics.push(...callees.diagnostics);
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    closePhase();
    return emptyResult(opts, diagnostics, timings);
  }

  await phase("generating wasm");
  let wat: string;
  const metadata: GeneratedContractMetadata = { stateSize: 0, entries: [], sysprocMask: 0 };
  try {
    wat = generateWasmModule(
      unit,
      sema,
      opts.name,
      opts.slot,
      opts.arenaSz ?? 1024 * 1024 * 1024,
      qpi.lib,
      opts.callees,
      callees.structs,
      callees.translationUnits,
      opts.sharedMemBase,
      metadata,
    );
  } catch (error: any) {
    diagnostics.push({
      severity: "error",
      message: `Codegen failed: ${error.message}`,
      span: { start: 0, end: 0, line: 0, col: 0 },
    });
    return emptyResult(opts, diagnostics);
  }

  diagnostics.push(...sema.getDiagnostics().map((diagnostic) => diagnostic.span.line > boundaryLine ? remap(diagnostic) : diagnostic));

  if ((globalThis as any).process?.env?.QINIT_DUMP_WAT) {
    const fs = await import("node:fs");
    fs.writeFileSync((globalThis as any).process.env.QINIT_DUMP_WAT, wat);
  }

  if (opts.strict !== false) {
    for (const diagnostic of diagnostics) if (diagnostic.category === "fidelity") diagnostic.severity = "error";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    closePhase();
    return emptyResult(opts, diagnostics, timings);
  }

  await phase("assembling wasm");
  let wasm: Uint8Array;
  try {
    const wabt = await import("wabt");
    const module = await wabt.default();
    const parsed = module.parseWat("contract.wat", wat);
    wasm = new Uint8Array(parsed.toBinary({}).buffer);
  } catch (error: any) {
    diagnostics.push({
      severity: "error",
      message: `WAT→WASM encode failed: ${error.message}`,
      span: { start: 0, end: 0, line: 0, col: 0 },
    });
    return emptyResult(opts, diagnostics);
  }

  closePhase();
  return { wasm, diagnostics, idl: extractIdl(unit, opts, metadata), timings };
}

export function compileGtest(opts: CompileOpts & { testSource: string }): CompileResult {
  return {
    wasm: new Uint8Array(0),
    diagnostics: [{
      severity: "error",
      message: "gtest local compilation not yet supported — use backend",
      span: { start: 0, end: 0, line: 0, col: 0 },
    }],
    idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
  };
}
