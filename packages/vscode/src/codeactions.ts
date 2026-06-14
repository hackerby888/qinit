// Quick-fix provider for Tier-A findings. Currently: the headline `T[N]` -> `Array<T, N>` rewrite for
// qpi/no-brackets. Only offered when the line matches a safe shape (see codefix.ts).
import * as vscode from "vscode";
import { arrayFixForLine } from "./codefix";
import { isContractDoc } from "./project-util";

export class QpiCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    if (!isContractDoc(doc)) return [];
    const actions: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== "qpi" || d.code !== "qpi/no-brackets") continue;
      const line = doc.lineAt(d.range.start.line);
      const fixed = arrayFixForLine(line.text);
      if (fixed && fixed !== line.text) {
        const a = new vscode.CodeAction("Convert to Array<T, N>", vscode.CodeActionKind.QuickFix);
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, line.range, fixed);
        a.diagnostics = [d];
        a.isPreferred = true;
        actions.push(a);
      }
    }
    return actions;
  }
}
