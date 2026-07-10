// @qinit/compile shared entrypoint for browser IDE + qinit CLI.

import type { Span } from "./ast";
import type { TranslationUnit } from "./ast";
import { Lexer } from "./lexer";
import { Preprocessor, type PreprocessOpts, type MacroDef } from "./preprocess";
import { Parser } from "./parser";
import type { Diagnostic as ParserDiagnostic } from "./parser";
import { Sema } from "./sema";
import { validateAndDesugar } from "./validate";
import { generateWasmModule, buildLibTypes, type LibTypes, type GeneratedContractMetadata } from "./codegen";
import { QPI_STUB } from "./qpi-stub";
import { SCAFFOLD_MACROS } from "./qpi-scaffold";

export { QPI_STUB };

export type { Span, TypeSpec, Expression, Statement, Declaration, TranslationUnit } from "./ast";
export { Lexer } from "./lexer";
export type { Token, TokenKind } from "./lexer";
export { Preprocessor } from "./preprocess";
export type { PreprocessOpts } from "./preprocess";
export { Parser } from "./parser";
export { formatAst } from "./ast-print";
export { emitFramework, emitModule } from "./framework";
export type { FrameworkOpts, UserEntry, SysProcInfo, ModuleSpec } from "./framework";

// ---- Public API types ----

export interface CalleeIdl {
  name: string;
  index: number;
  functions: Record<string, { inputType: number; inSize: number; outSize: number }>;
  procedures: Record<string, { inputType: number; inSize: number; outSize: number }>;
}

export interface CompileOpts {
  source: string;
  name: string;
  slot: number;
  arenaSz?: number;
  callees?: CalleeIdl[];
  // Callee contracts' SOURCE, so the compiler can register their nested struct layouts (`QX::Fees_output`) for a caller that reads
  calleeSources?: Array<{ name: string; source: string }>;
  testSource?: string;
  testPath?: string;
  qpiHeader?: string;
  sharedMemBase?: number; // shared-memory gtest mode: import env.memory and place the layout at this offset
  // Fired at the start of each pipeline stage (preprocess/parse/analyze/codegen/assemble) so a caller can show live progress. When set,
  onPhase?: (phase: string) => void | Promise<void>;
  // Fidelity gate (default true): escalate "fidelity" diagnostics — constructs lowered to placeholders like (i64.const 0) instead of faithful
  strict?: boolean;
}

export interface ContractIdl {
  name: string;
  slot: number;
  functions: Array<{ name: string; inputType: number; inSize: number; outSize: number }>;
  procedures: Array<{ name: string; inputType: number; inSize: number; outSize: number }>;
  stateSize: number;
  sysprocMask: number;
}

export interface CompileResult {
  wasm: Uint8Array;
  diagnostics: ParserDiagnostic[];
  idl: ContractIdl;
  timings?: Record<string, number>; // per-phase wall time (ms), keyed by phase name; excludes UI yields
}

export interface Diagnostic {
  severity: "error" | "warning";
  message: string;
  file?: string;
  span: Span;
  // "fidelity": the construct was dropped or lowered to a placeholder (see CompileOpts.strict).
  category?: "fidelity";
}

// ---- qpi.h library context (parsed once, cached) ----

interface QpiContext {
  macros: Map<string, MacroDef>;
  lib: LibTypes;
}

// Marker separating the main qpi.h headers from the template-method-body impl chunks.
import { IMPL_BOUNDARY, assembleQpiHeader } from "./qpi-snapshot";

const _qpiCache = new Map<string, QpiContext>();

// Build (or fetch from cache) the qpi.h symbol table + macro table from the given headers.
function getQpiContext(headers: string): QpiContext {
  // Header snapshots can have the same length and prefix while defining different layouts.
  const key = headers;
  const cached = _qpiCache.get(key);
  if (cached) return cached;

  // Split off the impl chunks (template method bodies) — parsed separately so qpi.h's bulk doesn't derail capturing the
  const [mainHeaders, ...implChunks] = headers.split(IMPL_BOUNDARY);

  const pp = new Preprocessor();
  const libText = pp.preprocess({ source: "", qpiHeader: mainHeaders, contractName: "__lib__", contractIndex: 0 });
  const macros = pp.getDefines();

  const libTu = new Parser(new Lexer(libText).tokenize()).parseTranslationUnit();
  const lib = buildLibTypes(libTu.declarations);

  // Parse each impl chunk on its own and merge the captured template methods into the library.
  for (const chunk of implChunks) {
    const implText = new Preprocessor().preprocess({ source: chunk, qpiHeader: "", contractName: "__impl__", contractIndex: 0, seedMacros: macros });
    const implTu = new Parser(new Lexer(implText).tokenize()).parseTranslationUnit();
    const implLib = buildLibTypes(implTu.declarations);
    for (const [cls, methods] of implLib.templateMethods) {
      if (!lib.templateMethods.has(cls)) lib.templateMethods.set(cls, new Map());
      for (const [m, def] of methods) if (!lib.templateMethods.get(cls)!.has(m)) lib.templateMethods.get(cls)!.set(m, def);
    }
    // Free functions whose bodies live in the impl chunk (isArraySortedWithoutDuplicates) — merge so a contract call resolves them;
    for (const [k, v] of implLib.libFns) if (!lib.libFns.has(k)) lib.libFns.set(k, v);
    for (const [k, v] of implLib.libFnTemplates) {
      const cur = lib.libFnTemplates.get(k);
      if (cur) cur.push(...v);
      else lib.libFnTemplates.set(k, v);
    }
  }

  const ctx: QpiContext = { macros, lib };
  _qpiCache.set(key, ctx);
  return ctx;
}

const USER_BOUNDARY = "__QINIT_USER_BOUNDARY__";

// ---- Main entry point ----

export interface ParseAstResult {
  ast: TranslationUnit;
  diagnostics: ParserDiagnostic[];
}

function remapUserDiagnostic(d: ParserDiagnostic, boundaryLine: number): ParserDiagnostic {
  return {
    ...d,
    span: d.span.line > 0
      ? { ...d.span, line: Math.max(1, d.span.line - boundaryLine) }
      : d.span,
  };
}

// Parse-only mode: preprocess+lex+parse only, no sema/codegen/wasm.
export function parseToAst(opts: { source: string; qpiHeader?: string; name?: string; slot?: number }): ParseAstResult {
  const headers = opts.qpiHeader ?? QPI_STUB;
  const qpi = getQpiContext(headers);

  const userSource = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${opts.source}`;
  const preprocessed = new Preprocessor().preprocess({
    source: userSource,
    qpiHeader: "",
    contractName: opts.name ?? "Contract",
    contractIndex: opts.slot ?? 0,
    seedMacros: qpi.macros,
  });

  const boundaryIdx = preprocessed.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIdx >= 0 ? preprocessed.slice(0, boundaryIdx).split("\n").length : 0;

  const parser = new Parser(new Lexer(preprocessed).tokenize());
  const tu = parser.parseTranslationUnit();

  const userDecls = tu.declarations.filter(
    (d) => (d.span?.line ?? 0) >= boundaryLine && (d as { name?: string }).name !== USER_BOUNDARY,
  );
  const diagnostics = parser.getDiagnostics().filter((d) => d.span.line >= boundaryLine)
    .map((d) => remapUserDiagnostic(d, boundaryLine));

  return { ast: { ...tu, declarations: userDecls }, diagnostics };
}

export async function compileContract(opts: CompileOpts): Promise<CompileResult> {
  const diagnostics: ParserDiagnostic[] = [];
  const headers = opts.qpiHeader ?? QPI_STUB;

  // Per-phase wall time (ms). Measured around each stage's real work, excluding the UI yield below, so the
  const timings: Record<string, number> = {};
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  let lastName = "";
  let lastStart = now();
  const phase = async (name: string): Promise<void> => {
    const t = now();
    if (lastName) timings[lastName] = t - lastStart;
    if (opts.onPhase) {
      await opts.onPhase(name);
      await new Promise((r) => setTimeout(r, 0)); // yield so a live UI can paint (not counted in timings)
    }
    lastName = name;
    lastStart = now();
  };
  const closePhase = () => {
    if (lastName) {
      timings[lastName] = now() - lastStart;
      lastName = "";
    }
  };

  // Phase 1 — parse qpi.h once into a type + macro table (cached across compiles).
  await phase("loading qpi.h");
  const qpi = getQpiContext(headers);

  // Phase 2 — preprocess + parse the USER source alone, seeded with qpi.h's macros and our simplified function-scaffolding
  await phase("preprocessing");
  const userSource = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${opts.source}`;
  const pp = new Preprocessor();
  const preprocessed = pp.preprocess({
    source: userSource,
    qpiHeader: "",
    contractName: opts.name,
    contractIndex: opts.slot,
    seedMacros: qpi.macros,
  });

  const boundaryIdx = preprocessed.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIdx >= 0 ? preprocessed.slice(0, boundaryIdx).split("\n").length : 0;

  await phase("parsing");
  const parser = new Parser(new Lexer(preprocessed).tokenize());
  const tu = parser.parseTranslationUnit();
  // Only diagnostics at/after the user boundary are the user's; earlier ones are seeded-library noise.
  const userDiags = parser.getDiagnostics().filter((d) => d.span.line >= boundaryLine)
    .map((d) => remapUserDiagnostic(d, boundaryLine));
  diagnostics.push(...userDiags);

  if (diagnostics.some((d) => d.severity === "error")) {
    return {
      wasm: new Uint8Array(0),
      diagnostics,
      idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
    };
  }

  // Semantic validation (+ default-argument desugar). Diagnostics before the user boundary are
  await phase("validating");
  const vdiags = validateAndDesugar(tu).filter((d) => d.span.line >= boundaryLine)
    .map((d) => remapUserDiagnostic(d, boundaryLine));
  diagnostics.push(...vdiags);
  if (diagnostics.some((d) => d.severity === "error")) {
    return {
      wasm: new Uint8Array(0),
      diagnostics,
      idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
    };
  }

  await phase("analyzing");
  const sema = new Sema();

  // Parse each callee's source and register its contract struct's nested structs under their qualified name (`QX::Fees_output`), so a
  const calleeStructs = new Map<string, any>();
  const calleeTus: Array<{ name: string; decls: any[] }> = [];
  for (const cs of opts.calleeSources ?? []) {
    const cpp = new Preprocessor();
    const ctext = cpp.preprocess({ source: `${SCAFFOLD_MACROS}\n${cs.source}`, qpiHeader: "", contractName: cs.name, contractIndex: 0, seedMacros: qpi.macros });
    const ctu = new Parser(new Lexer(ctext).tokenize()).parseTranslationUnit();
    calleeTus.push({ name: cs.name, decls: ctu.declarations });
    for (const d of ctu.declarations) {
      if (d.kind !== "struct") continue;
      const s = d as any;
      const isContract = s.bases?.some((b: any) => b.kind === "name" && b.name === "ContractBase") || s.name === "CONTRACT_STATE_TYPE";
      if (!isContract) continue;
      for (const m of s.members ?? []) {
        if (m.kind === "struct" && m.name) calleeStructs.set(`${cs.name}::${m.name}`, m);
      }
    }
  }

  // Codegen → WAT (seeded with the qpi.h library type table)
  await phase("generating wasm");
  let wat: string;
  const generatedMetadata: GeneratedContractMetadata = { stateSize: 0, entries: [], sysprocMask: 0 };
  try {
    wat = generateWasmModule(tu, sema, opts.name, opts.slot, opts.arenaSz ?? 1024 * 1024 * 1024, qpi.lib, opts.callees, calleeStructs, calleeTus, opts.sharedMemBase, generatedMetadata);
  } catch (e: any) {
    diagnostics.push({
      severity: "error",
      message: `Codegen failed: ${e.message}`,
      span: { start: 0, end: 0, line: 0, col: 0 },
    });
    return {
      wasm: new Uint8Array(0),
      diagnostics,
      idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
    };
  }

  // Surface codegen diagnostics (e.g. unsupported constructs lowered to stubs) as warnings so they
  diagnostics.push(...sema.getDiagnostics().map((d) => d.span.line >= boundaryLine ? remapUserDiagnostic(d, boundaryLine) : d));

  // Opt-in WAT dump for codegen debugging.
  if ((globalThis as any).process?.env?.QINIT_DUMP_WAT) {
    const fs = await import("node:fs");
    fs.writeFileSync((globalThis as any).process.env.QINIT_DUMP_WAT, wat);
  }

  // Fidelity gate (strict, default on): any construct lowered to a placeholder makes the module a silent divergence from
  if (opts.strict !== false) {
    for (const d of diagnostics) {
      if (d.category === "fidelity") d.severity = "error";
    }
  }
  if (diagnostics.some((d) => d.severity === "error")) {
    closePhase();
    return {
      wasm: new Uint8Array(0),
      diagnostics,
      idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
      timings,
    };
  }

  // 6. WAT → WASM (via wabt)
  await phase("assembling wasm");
  let wasm: Uint8Array;
  try {
    const wabt = await import("wabt");
    const wabtModule = await wabt.default();
    const mod = wabtModule.parseWat("contract.wat", wat);
    const binResult = mod.toBinary({});
    // wabt returns { buffer: Uint8Array, log: string } — copy into a fresh standalone Uint8Array
    wasm = new Uint8Array(binResult.buffer);
  } catch (e: any) {
    diagnostics.push({
      severity: "error",
      message: `WAT→WASM encode failed: ${e.message}`,
      span: { start: 0, end: 0, line: 0, col: 0 },
    });
    return {
      wasm: new Uint8Array(0),
      diagnostics,
      idl: { name: opts.name, slot: opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
    };
  }

  closePhase();

  // 7. Extract IDL
  const idl = extractIdl(tu, opts, generatedMetadata);

  return { wasm, diagnostics, idl, timings };
}

export function compileGtest(_opts: CompileOpts & { testSource: string }): CompileResult {
  return {
    wasm: new Uint8Array(0),
    diagnostics: [{ severity: "error", message: "gtest local compilation not yet supported — use backend", span: { start: 0, end: 0, line: 0, col: 0 } }],
    idl: { name: _opts.name, slot: _opts.slot, functions: [], procedures: [], stateSize: 0, sysprocMask: 0 },
  };
}

// ---- IDL extraction ----

function extractIdl(tu: TranslationUnit, opts: CompileOpts, generated?: GeneratedContractMetadata): ContractIdl {
  if (generated) {
    return {
      name: opts.name,
      slot: opts.slot,
      functions: generated.entries.filter((entry) => entry.kind === 0).map(({ name, inputType, inSize, outSize }) => ({ name, inputType, inSize, outSize })),
      procedures: generated.entries.filter((entry) => entry.kind !== 0).map(({ name, inputType, inSize, outSize }) => ({ name, inputType, inSize, outSize })),
      stateSize: generated.stateSize,
      sysprocMask: generated.sysprocMask,
    };
  }
  const parser = new Parser([]);
  const raw = parser.extractIdl(tu);

  const functions: ContractIdl["functions"] = [];
  const procedures: ContractIdl["procedures"] = [];

  for (const [name, info] of Object.entries(raw)) {
    const entry = { name, inputType: info.inputType, inSize: info.inSize, outSize: info.outSize };
    if (info.kind === 0) functions.push(entry);
    else procedures.push(entry);
  }

  return {
    name: opts.name,
    slot: opts.slot,
    functions,
    procedures,
    stateSize: 0,
    sysprocMask: 0,
  };
}

// ---- Convenience: load qpi.h header content (CLI / Bun only — browser fetches from the backend) ----

import { QPI_PRELUDE } from "./qpi-prelude";

export function loadQpiHeader(corePath?: string): string {
  if (typeof process !== "undefined" && (process.versions?.bun || process.versions?.node)) {
    try {
      return assembleQpiHeader(corePath ?? "/home/kali/Projects/core-lite");
    } catch {
      return QPI_PRELUDE + "\n" + QPI_STUB;
    }
  }
  return QPI_PRELUDE + "\n" + QPI_STUB;
}

// Wrap raw qpi.h headers (e.g. fetched from the backend) with the parse prelude.
export function withPrelude(headers: string): string {
  return QPI_PRELUDE + "\n" + headers;
}
