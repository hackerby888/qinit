// QPI semantic hover: hovering a registered function/procedure name shows its on-chain index, the
// input/output codec format, and how to call it — derived from the SAME extractIdl() the CLI uses, so
import * as vscode from "vscode";
import { extractIdl, type IdlEntry } from "@qinit/build/idl";
import { loadConfig } from "@qinit/core/project";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm-slot-layout";
import { join, basename } from "node:path";
import { findProjectRoot, isContractDoc, QINIT_JSON } from "./project-util";

export class IdlHover implements vscode.HoverProvider {
  provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
    if (!isContractDoc(doc)) return undefined;
    const root = findProjectRoot(doc.fileName);
    if (!root) return undefined;
    const wordRange = doc.getWordRangeAtPosition(pos, /\w+/);
    if (!wordRange) return undefined;
    const word = doc.getText(wordRange);

    const cfg = loadConfig(join(root, QINIT_JSON));
    const name = cfg.name ?? basename(doc.fileName).replace(/\.[^.]+$/, "");
    let idl;
    try {
      idl = extractIdl(doc.getText(), name);
    } catch {
      return undefined;
    }

    const slot = cfg.slot ?? DEFAULT_WASM_SLOT_LAYOUT.slotBase;
    const fn = Object.entries(idl.functions).find(([, e]) => e.name === word);
    if (fn) return hoverFor("function", fn[0], fn[1], slot);
    const pr = Object.entries(idl.procedures).find(([, e]) => e.name === word);
    if (pr) return hoverFor("procedure", pr[0], pr[1], slot);
    return undefined;
  }
}

function hoverFor(
  kind: "function" | "procedure",
  index: string,
  e: IdlEntry,
  slot: number,
): vscode.Hover {
  const md = new vscode.MarkdownString();
  md.appendMarkdown(`**QPI ${kind}** \`${e.name}\` · index **${index}**\n\n`);
  md.appendCodeblock(
    `input  : ${e.in || "(empty)"}` +
      (kind === "function" ? `\noutput : ${e.out || "(empty)"}` : ""),
    "text",
  );
  md.appendMarkdown(`\ncall: \`qinit call ${e.name}\` · contract \`id(${slot},0,0,0)\``);
  return new vscode.Hover(md);
}
