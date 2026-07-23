import * as vscode from "vscode";
import type { SourceFix } from "@qinit/compile/analyzer";
import type { QpiDiagnostics } from "./diagnostics";
import { isContractDoc } from "./project-util";

export class QpiCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  constructor(private readonly diagnostics: QpiDiagnostics) {}

  provideCodeActions(
    doc: vscode.TextDocument,
    _range: vscode.Range,
    ctx: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    if (!isContractDoc(doc)) return [];
    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of ctx.diagnostics) {
      for (const fix of this.diagnostics.fixesFor(doc, diagnostic)) {
        actions.push(codeAction(doc, diagnostic, fix));
      }
    }
    return actions;
  }
}

function codeAction(
  doc: vscode.TextDocument,
  diagnostic: vscode.Diagnostic,
  fix: SourceFix,
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    fix.title,
    vscode.CodeActionKind.QuickFix,
  );
  action.edit = new vscode.WorkspaceEdit();
  for (const edit of fix.edits) {
    action.edit.replace(
      doc.uri,
      new vscode.Range(
        doc.positionAt(edit.span.start),
        doc.positionAt(edit.span.end),
      ),
      edit.newText,
    );
  }
  action.diagnostics = [diagnostic];
  action.isPreferred = fix.preferred;
  return action;
}
