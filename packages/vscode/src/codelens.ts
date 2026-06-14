// CodeLens provider: surfaces build/deploy/gen on the contract struct and a "call <fn>" lens on each
// registered function/procedure. Lenses invoke the existing qpi.* palette commands (which shell qinit).
import * as vscode from "vscode";
import { computeLenses } from "./lens";
import { isContractDoc, findProjectRoot } from "./project-util";

export class QpiCodeLens implements vscode.CodeLensProvider {
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!isContractDoc(doc) || !findProjectRoot(doc.fileName)) return [];
    return computeLenses(doc.getText()).map(
      (s) => new vscode.CodeLens(new vscode.Range(s.line, 0, s.line, 0), { title: s.title, command: s.command }),
    );
  }
}
