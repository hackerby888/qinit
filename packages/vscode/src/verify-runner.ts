// Run authoritative contractverify diagnostics through the same CLI path used elsewhere.
import * as vscode from "vscode";
import { execFile } from "node:child_process";
import { findProjectRoot, isContractDoc } from "./project-util";
import { parseVerifyJson, verifyErrors } from "./verify-parse";

export class VerifyRunner implements vscode.Disposable {
  private readonly coll = vscode.languages.createDiagnosticCollection("qpi-verify");

  private qinit(): string {
    return vscode.workspace.getConfiguration("qpi").get<string>("qinitPath") || "qinit";
  }

  run(doc: vscode.TextDocument): void {
    const root = findProjectRoot(doc.fileName);
    if (!isContractDoc(doc) || !root) return;
    const uri = doc.uri;
    execFile(
      this.qinit(),
      ["verify", doc.fileName, "--json"],
      { cwd: root, timeout: 30_000, windowsHide: true },
      (_err, stdout) => {
        // qinit verify exits 1 on violations (execFile yields an error) — read stdout regardless.
        const errs = verifyErrors(parseVerifyJson(String(stdout)));
        if (!errs.length) {
          this.coll.delete(uri);
          return;
        }
        const at = new vscode.Range(0, 0, 0, 1);
        this.coll.set(
          uri,
          errs.map((m) => {
            const d = new vscode.Diagnostic(at, m, vscode.DiagnosticSeverity.Error);
            d.source = "contractverify";
            return d;
          }),
        );
      },
    );
  }

  clear(uri: vscode.Uri): void {
    this.coll.delete(uri);
  }
  dispose(): void {
    this.coll.dispose();
  }
}
