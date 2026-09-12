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

// The provider matches a bare word against the IDL, so the name of an entry mentioned in prose, in a
// string literal, or declared as a field used to answer as though it were a reference to the entry. A
// token pass settles both: hover is a user gesture, not a keystroke, so the cost is affordable.
//
// Two adjacent identifiers are a declaration in C++ — `uint64 Bump;` declares a field, it does not refer
// to the procedure `Bump`. Every way of *referring* to a name puts something else in front of it: `.`,
// `(`, `,`, an operator, or a keyword such as `return`. A declarator whose type is a template
// (`Array<Note, 4> Bump;`) follows `>` instead, which a comparison also does, so that one is left alone
// rather than risk silencing a real reference.
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

// `CALL_OTHER_CONTRACT_FUNCTION(Feed, Read, …)`: the second argument is an entry of Feed, and this
// provider only holds the IDL of the file being edited. Answering from that IDL hands the developer
// another contract's index for the call in front of them, so the entry argument of a cross-contract
// call is left alone.
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
