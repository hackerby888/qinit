import * as vscode from "vscode";
import {
  analyzeContract,
  DiagnosticSeverity,
  SourceAnalysisOrigin,
  type SourceAnalysisDiagnostic,
  type SourceAnalysisResult,
  type SourceFix,
} from "@qinit/compile/analyzer";
import {
  configuredContractIdentity,
  isContractDoc,
} from "./project-util";

const SEVERITY: Record<
  SourceAnalysisDiagnostic["severity"],
  vscode.DiagnosticSeverity
> = {
  [DiagnosticSeverity.ERROR]: vscode.DiagnosticSeverity.Error,
  [DiagnosticSeverity.WARNING]: vscode.DiagnosticSeverity.Warning,
  [DiagnosticSeverity.INFORMATION]: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(
  doc: vscode.TextDocument,
  item: SourceAnalysisDiagnostic,
): vscode.Diagnostic {
  const range = new vscode.Range(
    doc.positionAt(item.span.start),
    doc.positionAt(item.span.end),
  );
  const diagnostic = new vscode.Diagnostic(
    range,
    item.message,
    SEVERITY[item.severity],
  );
  diagnostic.source =
    item.origin === SourceAnalysisOrigin.QPI
      ? "qpi"
      : "qinit-compiler";
  diagnostic.code = item.code;
  return diagnostic;
}

export class QpiDiagnostics implements vscode.Disposable {
  private readonly coll = vscode.languages.createDiagnosticCollection("qpi");
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly analyses = new Map<
    string,
    {
      version: number;
      name?: string;
      slot?: number;
      result: SourceAnalysisResult;
    }
  >();
  private readonly fixes = new Map<
    string,
    {
      version: number;
      items: Map<string, SourceFix[]>;
    }
  >();

  private applies(doc: vscode.TextDocument): boolean {
    return isContractDoc(doc);
  }

  schedule(doc: vscode.TextDocument, delay = 250): void {
    if (
      doc.uri.scheme !== "file" ||
      !/\.(h|hpp|hxx)$/i.test(doc.fileName)
    ) {
      return;
    }

    const key = doc.uri.toString();
    const prev = this.timers.get(key);
    if (prev) {
      clearTimeout(prev);
    }

    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc);
      }, delay),
    );
  }

  analysisFor(doc: vscode.TextDocument): SourceAnalysisResult | undefined {
    const key = doc.uri.toString();
    const identity = configuredContractIdentity(doc.fileName);
    const cached = this.analyses.get(key);
    if (
      cached?.version === doc.version &&
      cached.name === identity.name &&
      cached.slot === identity.slot
    ) {
      return cached.result;
    }
    if (!this.applies(doc)) {
      this.analyses.delete(key);
      return undefined;
    }

    const result = analyzeContract({
      source: doc.getText(),
      name: identity.name,
      slot: identity.slot,
    });
    this.fixes.delete(key);
    this.analyses.set(key, {
      version: doc.version,
      name: identity.name,
      slot: identity.slot,
      result,
    });
    return result;
  }

  refresh(doc: vscode.TextDocument): void {
    const result = this.analysisFor(doc);
    if (!result) {
      this.clear(doc.uri);
      return;
    }

    const fixes = new Map<string, SourceFix[]>();
    const diagnostics = result.diagnostics.map((item) => {
      const value = toDiagnostic(doc, item);
      if (item.fixes?.length) {
        fixes.set(diagnosticKey(value), item.fixes);
      }
      return value;
    });

    this.fixes.set(doc.uri.toString(), {
      version: doc.version,
      items: fixes,
    });
    this.coll.set(
      doc.uri,
      diagnostics,
    );
  }

  fixesFor(
    doc: vscode.TextDocument,
    diagnostic: vscode.Diagnostic,
  ): SourceFix[] {
    const cached = this.fixes.get(doc.uri.toString());
    if (!cached || cached.version !== doc.version) {
      return [];
    }
    return cached.items.get(diagnosticKey(diagnostic)) ?? [];
  }

  clear(uri: vscode.Uri): void {
    const key = uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
    }

    this.timers.delete(key);
    this.analyses.delete(key);
    this.coll.delete(uri);
    this.fixes.delete(key);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.analyses.clear();
    this.fixes.clear();
    this.coll.dispose();
  }
}

function diagnosticKey(diagnostic: vscode.Diagnostic): string {
  const code =
    typeof diagnostic.code === "object"
      ? diagnostic.code.value
      : diagnostic.code;
  return [
    code,
    diagnostic.range.start.line,
    diagnostic.range.start.character,
    diagnostic.range.end.line,
    diagnostic.range.end.character,
    diagnostic.message,
  ].join(":");
}
