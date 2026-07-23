import type { Span } from "./ast";
import type { Diagnostic as CompilerDiagnostic } from "./parser";
import { QPI_SNAPSHOT } from "./generated/qpi-snapshot";
import {
  parseContractSource,
  preprocessContractSource,
  validateContractSource,
} from "./compiler/contract-frontend";
import { scanUnterminatedSource } from "./compiler/diagnostics";
import { getQpiMacros } from "./compiler/qpi-macros";
import type { CompileOptions } from "./compiler/types";
import {
  analyzeQpiPolicy,
  detectQpiContractName,
} from "./source-policy";

export { Lexer } from "./lexer";
export type { Token, TokenKind } from "./lexer";

export interface AnalyzeContractOptions {
  source: string;
  name?: string;
  slot?: number;
  qpiHeader?: string;
}

export interface SourceEdit {
  span: Span;
  newText: string;
}

export interface SourceFix {
  title: string;
  preferred?: boolean;
  edits: SourceEdit[];
}

export interface SourceAnalysisDiagnostic {
  origin: "compiler" | "qpi";
  code: string;
  severity: "error" | "warning" | "information";
  message: string;
  span: Span;
  fixes?: SourceFix[];
}

export interface SourceAnalysisResult {
  diagnostics: SourceAnalysisDiagnostic[];
}

export function analyzeContract(
  options: AnalyzeContractOptions,
): SourceAnalysisResult {
  const diagnostics = analyzeCompiler(options);

  try {
    diagnostics.push(...analyzeQpiPolicy(options.source));
  } catch (error: any) {
    diagnostics.push(internalDiagnostic(error));
  }

  const seen = new Set<string>();
  return {
    diagnostics: diagnostics
      .filter((item) => {
        const key = [
          item.origin,
          item.code,
          item.span.start,
          item.span.end,
          item.message,
        ].join(":");
        if (seen.has(key)) {
          return false;
        }
        seen.add(key);
        return true;
      })
      .sort(compareDiagnostics),
  };
}

export function detectContractName(source: string): string | undefined {
  return detectQpiContractName(source);
}

function analyzeCompiler(
  options: AnalyzeContractOptions,
): SourceAnalysisDiagnostic[] {
  const earlyDiagnostics = scanUnterminatedSource(options.source);
  if (hasErrors(earlyDiagnostics)) {
    return earlyDiagnostics.map((item) => compilerDiagnostic(item, "syntax"));
  }

  try {
    const qpiHeader = options.qpiHeader ?? QPI_SNAPSHOT;
    const compileOptions: CompileOptions = {
      source: options.source,
      name:
        options.name ??
        detectQpiContractName(options.source) ??
        "Contract",
      slot: options.slot ?? 0,
      qpiHeader,
    };
    const preprocessed = preprocessContractSource(
      compileOptions,
      getQpiMacros(qpiHeader),
    );
    const parserDiagnostics: CompilerDiagnostic[] = [];
    const translationUnit = parseContractSource(
      preprocessed,
      parserDiagnostics,
    );
    const diagnostics = parserDiagnostics.map((item) =>
      compilerDiagnostic(item, "syntax"),
    );

    if (hasErrors(parserDiagnostics)) {
      return diagnostics;
    }

    const validationDiagnostics: CompilerDiagnostic[] = [];
    validateContractSource(
      translationUnit,
      preprocessed,
      validationDiagnostics,
    );
    diagnostics.push(
      ...validationDiagnostics.map((item) =>
        compilerDiagnostic(item, "semantic"),
      ),
    );
    return diagnostics;
  } catch (error: any) {
    return [internalDiagnostic(error)];
  }
}

function compilerDiagnostic(
  item: CompilerDiagnostic,
  phase: "syntax" | "semantic",
): SourceAnalysisDiagnostic {
  return {
    origin: "compiler",
    code:
      item.category === "fidelity"
        ? "compiler/fidelity"
        : `compiler/${phase}`,
    severity: item.severity,
    message: item.message,
    span: item.span,
  };
}

function internalDiagnostic(error: any): SourceAnalysisDiagnostic {
  return {
    origin: "compiler",
    code: "compiler/internal",
    severity: "error",
    message: `Source analysis failed: ${String(error?.message ?? error)}`,
    span: {
      start: 0,
      end: 0,
      line: 1,
      column: 1,
    },
  };
}

function hasErrors(diagnostics: CompilerDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === "error");
}

function compareDiagnostics(
  left: SourceAnalysisDiagnostic,
  right: SourceAnalysisDiagnostic,
): number {
  return (
    left.span.start - right.span.start ||
    left.span.end - right.span.end ||
    left.origin.localeCompare(right.origin) ||
    left.code.localeCompare(right.code) ||
    left.message.localeCompare(right.message)
  );
}
