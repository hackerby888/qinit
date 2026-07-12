// Quick-fix provider for Tier-A findings: `T[N]` -> `Array<T, N>` (qpi/no-brackets), `a / b` -> `div(a,
// b)` / `a % b` -> `mod(a, b)` (qpi/no-division, qpi/no-modulo). Each is offered only when the source
import * as vscode from "vscode";
import { arrayFixForLine, divModFixForLine, moveLocalToWithLocalsEdits } from "./codefix";
import { isContractDoc } from "./project-util";

export class QpiCodeActions implements vscode.CodeActionProvider {
  static readonly metadata: vscode.CodeActionProviderMetadata = {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    if (!isContractDoc(doc)) return [];
    const actions: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== "qpi") continue;
      const lineNum = d.range.start.line;
      const line = doc.lineAt(lineNum).text;

      if (d.code === "qpi/no-brackets") {
        const fixed = arrayFixForLine(line);
        if (fixed && fixed !== line) actions.push(replaceAction(doc, d, doc.lineAt(lineNum).range, fixed, "Convert to Array<T, N>"));
      } else if (d.code === "qpi/no-division" || d.code === "qpi/no-modulo") {
        const op = d.code === "qpi/no-division" ? "/" : "%";
        const fix = divModFixForLine(line, d.range.start.character, op);
        if (fix) {
          const range = new vscode.Range(lineNum, fix.start, lineNum, fix.end);
          actions.push(replaceAction(doc, d, range, fix.text, `Convert to ${op === "/" ? "div" : "mod"}(a, b)`));
        }
      } else if (d.code === "qpi/stack-local") {
        const nameOffset = doc.offsetAt(d.range.start);
        const edits = moveLocalToWithLocalsEdits(doc.getText(), nameOffset, doc.offsetAt(d.range.end) - nameOffset);
        if (edits && edits.length) {
          const a = new vscode.CodeAction("Move into <fn>_locals struct (use *_WITH_LOCALS)", vscode.CodeActionKind.QuickFix);
          a.edit = new vscode.WorkspaceEdit();
          for (const e of edits) {
            const pos = doc.positionAt(e.start);
            if (e.start === e.end) a.edit.insert(doc.uri, pos, e.newText);
            else a.edit.replace(doc.uri, new vscode.Range(pos, doc.positionAt(e.end)), e.newText);
          }
          a.diagnostics = [d];
          actions.push(a);
        }
      }
    }
    return actions;
  }
}

function replaceAction(doc: vscode.TextDocument, d: vscode.Diagnostic, range: vscode.Range, newText: string, title: string): vscode.CodeAction {
  const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
  a.edit = new vscode.WorkspaceEdit();
  a.edit.replace(doc.uri, range, newText);
  a.diagnostics = [d];
  a.isPreferred = true;
  return a;
}
