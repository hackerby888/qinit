// Publish debounced Tier-A and IDL diagnostics for contract documents.
import * as vscode from "vscode";
import { scanQpi, scanLocals, scanLocalsForm, type QpiFinding } from "./lint/qpi-rules";
import { idlChecks } from "./lint/idl-checks";
import { findProjectRoot, isContractDoc } from "./project-util";

const SEVERITY: Record<QpiFinding["severity"], vscode.DiagnosticSeverity> = {
  warn: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function toDiagnostic(doc: vscode.TextDocument, f: QpiFinding): vscode.Diagnostic {
  const range = new vscode.Range(doc.positionAt(f.offset), doc.positionAt(f.offset + f.length));
  const d = new vscode.Diagnostic(range, f.message, SEVERITY[f.severity]);
  d.source = "qpi";
  d.code = f.rule;
  return d;
}

export class QpiDiagnostics implements vscode.Disposable {
  private readonly coll = vscode.languages.createDiagnosticCollection("qpi");
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  // Only lint contract documents that live inside a qinit project (avoids touching arbitrary C++).
  private applies(doc: vscode.TextDocument): boolean {
    return isContractDoc(doc) && !!findProjectRoot(doc.fileName);
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
      return;
    }
    const text = doc.getText();
    const findings = [
      ...scanQpi(text),
      ...scanLocals(text),
      ...scanLocalsForm(text),
      ...idlChecks(text),
    ];
    this.coll.set(
      doc.uri,
      findings.map((f) => toDiagnostic(doc, f)),
    );
  }

  clear(uri: vscode.Uri): void {
    this.coll.delete(uri);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.coll.dispose();
  }
}
