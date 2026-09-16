import * as vscode from "vscode";
import { analyzeContract, Lexer, TokenKind, type AnalyzeContractOptions } from "@qinit/compiler/analyzer";
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

/** A document that exercises a contract without being one — a gtest, and the header it tests. */
export interface TestedContract {
    path: string;
    source: string;
    options: Omit<AnalyzeContractOptions, "source">;
}

export class IdlHover implements vscode.HoverProvider {
    // One entry, replaced when the contract's text changes: a gtest hovers the same contract over and over.
    private testedIdl?: { path: string; source: string; idl: unknown };

    constructor(
        private readonly diagnostics: QpiDiagnostics,
        private readonly testedContract?: (doc: vscode.TextDocument) => TestedContract | undefined,
    ) {}

    provideHover(doc: vscode.TextDocument, pos: vscode.Position): vscode.Hover | undefined {
        const own = this.diagnostics.analysisFor(doc)?.idl;
        const idl: any = own ?? this.testedContractIdl(doc);
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

        // A gtest names an entry through its payload — `Desk::Read_input` — where the contract names it
        // directly. The suffix is stripped only on that path, so a contract's own hovers are unchanged.
        const names = own ? [word] : [word, ...payloadEntryName(word)];

        for (const name of names) {
            const fn = idl.functions.find((entry: HoverEntry) => entry.name === name);
            if (fn) {
                return hoverFor("function", fn);
            }

            const procedure = idl.procedures.find((entry: HoverEntry) => entry.name === name);
            if (procedure) {
                return hoverFor("procedure", procedure);
            }
        }

        return undefined;
    }

    /** The IDL of the contract this document tests, analysed once per revision of that contract. */
    private testedContractIdl(doc: vscode.TextDocument): unknown {
        const tested = this.testedContract?.(doc);
        if (!tested) {
            return undefined;
        }

        const cached = this.testedIdl;
        if (cached && cached.path === tested.path && cached.source === tested.source) {
            return cached.idl;
        }

        let idl: unknown;
        try {
            idl = analyzeContract({ ...tested.options, source: tested.source }).idl;
        } catch {
            // A contract mid-edit is expected not to analyse; the hover simply has nothing to say yet.
            idl = undefined;
        }

        this.testedIdl = { path: tested.path, source: tested.source, idl };
        return idl;
    }
}

/** `Read_input` and `Read_output` both name the entry `Read`; anything else names no entry. */
function payloadEntryName(word: string): string[] {
    const match = /^(\w+)_(input|output)$/.exec(word);
    return match ? [match[1]!] : [];
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
