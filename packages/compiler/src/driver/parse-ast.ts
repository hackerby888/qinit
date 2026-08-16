import type { TranslationUnit } from "../ast";
import type { ParserDiagnostic } from "../frontend/parser";
import { scanUnterminatedSource, USER_BOUNDARY } from "./diagnostics";
import { parseContractSource, preprocessContractSource } from "./contract-frontend";
import { getQpiMacros } from "./qpi-macros";

export interface ParseAstResult {
    ast: TranslationUnit;
    diagnostics: ParserDiagnostic[];
}

export function parseToAst(options: { source: string; qpiHeader?: string; contractName?: string; slot?: number }): ParseAstResult {
    if (options.qpiHeader === undefined) throw new Error("internal parser requires a QPI header snapshot");
    const preprocessed = preprocessContractSource(
        {
            source: options.source,
            contractName: options.contractName ?? "Contract",
            slot: options.slot ?? 0,
            qpiHeader: options.qpiHeader,
        },
        getQpiMacros(options.qpiHeader),
    );
    const parserDiagnostics: ParserDiagnostic[] = [];
    const unit = parseContractSource(preprocessed, parserDiagnostics);
    const declarations = unit.declarations.filter(
        (declaration) => (declaration.span?.line ?? 0) > preprocessed.userBoundaryLine && (declaration as { name?: string }).name !== USER_BOUNDARY,
    );
    const diagnostics = [...scanUnterminatedSource(options.source), ...parserDiagnostics].sort(
        (left, right) => left.span.start - right.span.start || left.span.end - right.span.end,
    );
    return { ast: { ...unit, declarations }, diagnostics };
}
