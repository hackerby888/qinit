import * as vscode from "vscode";
import { Lexer, TokenKind } from "@qinit/compiler/analyzer";
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
        if (!isEntryReference(doc, wordRange) || namesAnotherContractsEntry(doc, wordRange)) {
            return undefined;
        }

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

// A bare word match answers on prose, string literals and field declarations too, so the word must be an
// identifier token whose predecessor is not one — only a declarator follows a bare identifier.
function isEntryReference(doc: vscode.TextDocument, wordRange: vscode.Range): boolean {
    const offset = doc.offsetAt(wordRange.start);
    try {
        const tokens = new Lexer(doc.getText()).tokenize();
        const index = tokens.findIndex((token) => token.span.start === offset);
        if (index < 0 || tokens[index].kind !== TokenKind.IDENTIFIER) return false;
        return tokens[index - 1]?.kind !== TokenKind.IDENTIFIER;
    } catch {
        // A half-typed buffer that will not tokenize should not silently lose its hovers.
        return true;
    }
}

// `CALL_OTHER_CONTRACT_FUNCTION(Feed, Read, …)`: the second argument is Feed's entry, and this provider
// holds only the edited file's IDL — answering would hand over another contract's index.
const FOREIGN_CALL = /\b(?:CALL_OTHER_CONTRACT_FUNCTION|INVOKE_OTHER_CONTRACT_PROCEDURE)(?:_E)?\s*\(\s*\w+\s*,\s*$/;

function namesAnotherContractsEntry(doc: vscode.TextDocument, wordRange: vscode.Range): boolean {
    const before = doc.getText(new vscode.Range(wordRange.start.with({ character: 0 }), wordRange.start));
    return FOREIGN_CALL.test(before);
}

function hoverFor(kind: "function" | "procedure", entry: HoverEntry): vscode.Hover {
    const md = new vscode.MarkdownString();
    md.appendMarkdown(`**QPI ${kind}** \`${entry.name}\` · index **${entry.inputType}**\n\n`);
    // A procedure carries an output struct exactly as a function does; hiding it showed half the payload.
    md.appendCodeblock(`input  : ${entry.input.format || "(empty)"}\noutput : ${entry.output.format || "(empty)"}`, "text");
    return new vscode.Hover(md);
}
