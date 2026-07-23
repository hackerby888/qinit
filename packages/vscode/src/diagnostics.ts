import * as vscode from "vscode";
import {
  analyzeContract,
  type SourceAnalysisDiagnostic,
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
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  information: vscode.DiagnosticSeverity.Information,
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
    item.origin === "qpi"
      ? "qpi"
      : "qinit-compiler";
  diagnostic.code = item.code;
  return diagnostic;
}

export class QpiDiagnostics implements vscode.Disposable {
  private readonly coll = vscode.languages.createDiagnosticCollection("qpi");
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
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
    if (!this.applies(doc)) return;
    const key = doc.uri.toString();
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc);
      }, delay),
    );
  }

  refresh(doc: vscode.TextDocument): void {
    if (!this.applies(doc)) {
      this.coll.delete(doc.uri);
      this.fixes.delete(doc.uri.toString());
      return;
    }
    const text = doc.getText();
    const identity = configuredContractIdentity(doc.fileName);
    const findings = analyzeContract({
      source: text,
      name: identity.name,
      slot: identity.slot,
    }).diagnostics;
    const fixes = new Map<string, SourceFix[]>();
    const diagnostics = findings.map((item) => {
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
    this.coll.delete(uri);
    this.fixes.delete(uri.toString());
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
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
