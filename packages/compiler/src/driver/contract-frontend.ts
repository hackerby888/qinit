import type { TranslationUnit } from "../ast";
import { Lexer } from "../frontend/lexer";
import { Parser, type ParserDiagnostic } from "../frontend/parser";
import { Preprocessor } from "../frontend/preprocessor";
import { validateAndDesugar } from "../frontend/validation";
import { SCAFFOLD_MACROS } from "./qpi/scaffold";
import { cheatMacros } from "./qpi/cheats";
import { CheatMode } from "../shared/enums";
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
    // `__LINE__` counts physical lines, directives included, so the base is measured from the real prefix; the block's length is independent of its number.
    const mode = options.cheats ?? CheatMode.ON;
    // The boundary marker has to be the last line before the user source: `userBoundaryLine` is the
    // constant every remap subtracts, so anything emitted between the marker and the user's line 1
    // shifts every diagnostic and every member query in the file.
    const boundary = `struct ${USER_BOUNDARY} {};`;
    // +1 because the preprocessor prepends its own newline before this source (preprocessor-core.ts).
    const prefixLines = [SCAFFOLD_MACROS, cheatMacros(mode, 0), boundary].join("\n").split("\n").length + 1;
    const source = [SCAFFOLD_MACROS, cheatMacros(mode, prefixLines), boundary, sourceWithoutLeadingBom(options.source)].join("\n");

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
