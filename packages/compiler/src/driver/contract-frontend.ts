import type { TranslationUnit } from "../ast";
import { Lexer } from "../frontend/lexer";
import { Parser, type ParserDiagnostic } from "../frontend/parser";
import { Preprocessor } from "../frontend/preprocessor";
import { validateAndDesugar } from "../frontend/validation";
import { SCAFFOLD_MACROS } from "./qpi/scaffold";
import { cheatMacros } from "./qpi/cheats";
import { makeUserDiagnosticRemapper, sourceWithoutLeadingBom, USER_BOUNDARY } from "./diagnostics";
import type { CompileOptions } from "./types";

type PreprocessorInput = Parameters<Preprocessor["preprocess"]>[0];
type DiagnosticRemapper = ReturnType<typeof makeUserDiagnosticRemapper>;

export interface PreprocessedContractSource {
    source: string;
    userBoundaryLine: number;
    remapDiagnostic: DiagnosticRemapper;
}

export function preprocessContractSource(options: CompileOptions, seedMacros: PreprocessorInput["seedMacros"]): PreprocessedContractSource {
    // `__LINE__` counts physical lines, directives included, so the base is measured from the real
    // prefix rather than assumed: the macro block shifts user code down by its own length too. The
    // block's line count does not depend on the number it carries, so one placeholder pass settles it.
    const prelude = [SCAFFOLD_MACROS, `struct ${USER_BOUNDARY} {};`].join("\n");
    const mode = options.cheats ?? "on";
    const prefixLines = [prelude, cheatMacros(mode, 0)].join("\n").split("\n").length;
    const source = [prelude, cheatMacros(mode, prefixLines), sourceWithoutLeadingBom(options.source)].join("\n");

    const preprocessedSource = new Preprocessor().preprocess({
        source,
        qpiHeader: "",
        contractName: options.contractName,
        contractIndex: options.slot,
        seedMacros,
    });

    const userBoundaryLine = findUserBoundaryLine(preprocessedSource);

    return {
        source: preprocessedSource,
        userBoundaryLine,
        remapDiagnostic: makeUserDiagnosticRemapper(options.source, preprocessedSource, userBoundaryLine),
    };
}

export function parseContractSource(preprocessed: PreprocessedContractSource, diagnostics: ParserDiagnostic[]): TranslationUnit {
    const parser = new Parser(new Lexer(preprocessed.source).tokenize());
    const translationUnit = parser.parseTranslationUnit();

    diagnostics.push(...userSourceDiagnostics(parser.getDiagnostics(), preprocessed));

    return translationUnit;
}

export function validateAndDesugarContractSource(
    translationUnit: TranslationUnit,
    preprocessed: PreprocessedContractSource,
    diagnostics: ParserDiagnostic[],
): void {
    diagnostics.push(...userSourceDiagnostics(validateAndDesugar(translationUnit), preprocessed));
}

export function remapAnalysisDiagnostics(diagnostics: ParserDiagnostic[], preprocessed: PreprocessedContractSource): ParserDiagnostic[] {
    return diagnostics.map((diagnostic) => {
        if (diagnostic.span.line <= preprocessed.userBoundaryLine) {
            return diagnostic;
        }

        return preprocessed.remapDiagnostic(diagnostic);
    });
}

function userSourceDiagnostics(diagnostics: ParserDiagnostic[], preprocessed: PreprocessedContractSource): ParserDiagnostic[] {
    return diagnostics
        .filter((diagnostic) => {
            return diagnostic.span.line > preprocessed.userBoundaryLine;
        })
        .map(preprocessed.remapDiagnostic);
}

function findUserBoundaryLine(source: string): number {
    const boundaryIndex = source.indexOf(USER_BOUNDARY);

    if (boundaryIndex < 0) {
        return 0;
    }

    return source.slice(0, boundaryIndex).split("\n").length;
}
