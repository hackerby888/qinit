import * as vscode from "vscode";
import type { QpiDiagnostics } from "./diagnostics";

interface HoverEntry {
  name: string;
  inputType: number;
  input: {
    format: string;
  };
  output: {
    format: string;
  };
}

export class IdlHover implements vscode.HoverProvider {
  constructor(private readonly diagnostics: QpiDiagnostics) {}

  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    const idl = this.diagnostics.analysisFor(doc)?.idl;
    if (!idl) {
      return undefined;
    }

    const wordRange = doc.getWordRangeAtPosition(pos, /\w+/);
    if (!wordRange) {
      return undefined;
    }

    const word = doc.getText(wordRange);

    const fn = idl.functions.find((entry) => entry.name === word);
    if (fn) {
      return hoverFor("function", fn);
    }

    const procedure = idl.procedures.find((entry) => entry.name === word);
    if (procedure) {
      return hoverFor("procedure", procedure);
    }

    return undefined;
  }
}

function hoverFor(
  kind: "function" | "procedure",
  entry: HoverEntry,
): vscode.Hover {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(
    `**QPI ${kind}** \`${entry.name}\` · index **${entry.inputType}**\n\n`,
  );
  md.appendCodeblock(
    `input  : ${entry.input.format || "(empty)"}` +
      (kind === "function"
        ? `\noutput : ${entry.output.format || "(empty)"}`
        : ""),
    "text",
  );
  return new vscode.Hover(md);
}
