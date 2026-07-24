import type { Span } from "./ast";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import type { Diagnostic as CompilerDiagnostic } from "./parser";
import {
  AnalysisPhase,
  DiagnosticCategory,
  DiagnosticSeverity,
  QpiContextKind,
  SourceAnalysisOrigin,
} from "./enums";
import { QPI_SNAPSHOT } from "./generated/qpi-snapshot";
import {
  parseContractSource,
  preprocessContractSource,
  remapAnalysisDiagnostics,
  validateContractSource,
} from "./compiler/contract-frontend";
import { scanUnterminatedSource } from "./compiler/diagnostics";
import { getQpiMacros } from "./compiler/qpi-macros";
import type { CompileOptions } from "./compiler/types";
import { collectCalleeContext } from "./compiler/callees";
import {
  collectSourceContractCalls,
  type SourceContractCall,
} from "./compiler/semantic-calls";
import { getQpiContext } from "./compiler/qpi-context";
import { Sema } from "./sema";
import { prepareContractModule } from "./backend/wasm/module/module-analysis";
import type { ContractRegistration } from "./backend/wasm/module/registrations";
import { publishProgramDiagnostics } from "./backend/wasm/module/module-output";
import { buildContractIdl } from "./backend/wasm/module/contract-idl";
import {
  analyzeQpiPolicy,
  detectQpiContractName,
} from "./source-policy";

export { Lexer, TokenKind } from "./lexer";
export type { Token } from "./lexer";
export {
  AnalysisPhase,
  DiagnosticCategory,
  DiagnosticSeverity,
  QpiContextKind,
  SourceAnalysisOrigin,
};
export type { SourceContractCall };

export interface AnalyzeContractOptions {
  source: string;
  name?: string;
  slot?: number;
  qpiHeader?: string;
  callees?: ContractIdl[];
  calleeSources?: Array<{
    name: string;
    source: string;
    slot?: number;
  }>;
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
  origin: SourceAnalysisOrigin;
  code: string;
  severity:
    | DiagnosticSeverity.ERROR
    | DiagnosticSeverity.WARNING
    | DiagnosticSeverity.INFORMATION;
  message: string;
  span: Span;
  fixes?: SourceFix[];
}

export interface SourceAnalysisResult {
  diagnostics: SourceAnalysisDiagnostic[];
  calls: SourceContractCall[];
  idl?: ContractIdl;
}

export function analyzeContract(
  options: AnalyzeContractOptions,
): SourceAnalysisResult {
  const qpiHeader = options.qpiHeader ?? QPI_SNAPSHOT;
  const name =
    options.name ??
    detectQpiContractName(options.source) ??
    "Contract";
  const calls = collectSourceContractCalls(
    options.source,
    name,
    options.slot ?? 0,
    getQpiMacros(qpiHeader),
  );
  const compilerResult = analyzeCompiler(options, calls);
  const diagnostics = compilerResult.diagnostics;

  try {
    diagnostics.push(
      ...analyzeQpiPolicy(
        options.source,
        compilerResult.registrations,
        compilerResult.idl,
      ),
    );
  } catch (error: any) {
    diagnostics.push(internalDiagnostic(error));
  }

  const seen = new Set<string>();
  return {
    calls,
    idl: compilerResult.idl,
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
  calls: SourceContractCall[],
): {
  diagnostics: SourceAnalysisDiagnostic[];
  idl?: ContractIdl;
  registrations?: ContractRegistration[];
} {
  const earlyDiagnostics = scanUnterminatedSource(options.source);
  if (hasErrors(earlyDiagnostics)) {
    return {
      diagnostics: earlyDiagnostics.map((item) =>
        compilerDiagnostic(item, AnalysisPhase.SYNTAX),
      ),
    };
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
      callees: options.callees,
      calleeSources: options.calleeSources,
    };
    const qpiContext = getQpiContext(qpiHeader);
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
      compilerDiagnostic(item, AnalysisPhase.SYNTAX),
    );

    if (hasErrors(parserDiagnostics)) {
      return { diagnostics };
    }

    const validationDiagnostics: CompilerDiagnostic[] = [];
    validateContractSource(
      translationUnit,
      preprocessed,
      validationDiagnostics,
    );
    diagnostics.push(
      ...validationDiagnostics.map((item) =>
        compilerDiagnostic(item, AnalysisPhase.SEMANTIC),
      ),
    );

    if (hasErrors(validationDiagnostics)) {
      return { diagnostics };
    }

    const semanticAnalysis = new Sema();
    const calleeContext = collectCalleeContext(
      compileOptions,
      qpiContext,
    );
    diagnostics.push(
      ...calleeContext.diagnostics.map((item) =>
        compilerDiagnostic(item, AnalysisPhase.SYNTAX),
      ),
    );

    if (hasErrors(calleeContext.diagnostics)) {
      return { diagnostics };
    }

    const prepared = prepareContractModule({
      translationUnit,
      semanticAnalysis,
      contractSlot: compileOptions.slot,
      libraryIndex: qpiContext.lib,
      callees: compileOptions.callees,
      calleeStructs: calleeContext.contractStructs,
      calleeTranslationUnits: calleeContext.calleeTranslationUnits,
      gtestMode: false,
    });
    const idl = buildContractIdl(prepared, {
      name: compileOptions.name,
      slot: compileOptions.slot,
      dependencies: calls.map((call) => call.callee),
    });
    publishProgramDiagnostics(prepared.programAnalysis, semanticAnalysis);
    diagnostics.push(
      ...remapAnalysisDiagnostics(
        semanticAnalysis.getDiagnostics(),
        preprocessed,
      ).map((item) =>
        compilerDiagnostic(item, AnalysisPhase.SEMANTIC),
      ),
    );

    if (diagnostics.some(
      (item) => item.severity === DiagnosticSeverity.ERROR,
    )) {
      return {
        diagnostics,
        registrations: prepared.registrations,
      };
    }

    return {
      diagnostics,
      idl,
      registrations: prepared.registrations,
    };
  } catch (error: any) {
    return {
      diagnostics: [internalDiagnostic(error)],
    };
  }
}

function compilerDiagnostic(
  item: CompilerDiagnostic,
  phase: AnalysisPhase,
): SourceAnalysisDiagnostic {
  return {
    origin: SourceAnalysisOrigin.COMPILER,
    code:
      item.category === DiagnosticCategory.FIDELITY
        ? "compiler/fidelity"
        : `compiler/${phase}`,
    severity: item.severity,
    message: item.message,
    span: item.span,
  };
}

function internalDiagnostic(error: any): SourceAnalysisDiagnostic {
  return {
    origin: SourceAnalysisOrigin.COMPILER,
    code: "compiler/internal",
    severity: DiagnosticSeverity.ERROR,
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
  return diagnostics.some(
    (item) => item.severity === DiagnosticSeverity.ERROR,
  );
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
