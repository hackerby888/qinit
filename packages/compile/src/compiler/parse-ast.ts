import type { TranslationUnit } from "../ast";
import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import { makeUserDiagnosticRemapper, scanUnterminatedSource, sourceWithoutLeadingBom, USER_BOUNDARY } from "./diagnostics";
import { loadQpiHeader } from "./header";
import { getQpiContext } from "./qpi-context";

export interface ParseAstResult {
  ast: TranslationUnit;
  diagnostics: ParserDiagnostic[];
}

export function parseToAst(opts: { source: string; qpiHeader?: string; name?: string; slot?: number }): ParseAstResult {
  const qpi = getQpiContext(opts.qpiHeader ?? loadQpiHeader());
  const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(opts.source)}`;
  const text = new Preprocessor().preprocess({
    source,
    qpiHeader: "",
    contractName: opts.name ?? "Contract",
    contractIndex: opts.slot ?? 0,
    seedMacros: qpi.macros,
  });
  const boundaryIndex = text.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIndex >= 0 ? text.slice(0, boundaryIndex).split("\n").length : 0;
  const remap = makeUserDiagnosticRemapper(opts.source, text, boundaryLine);
  const parser = new Parser(new Lexer(text).tokenize());
  const unit = parser.parseTranslationUnit();
  const declarations = unit.declarations.filter(
    (declaration) => (declaration.span?.line ?? 0) > boundaryLine && (declaration as { name?: string }).name !== USER_BOUNDARY,
  );
  const diagnostics = [
    ...scanUnterminatedSource(opts.source),
    ...parser.getDiagnostics().filter((diagnostic) => diagnostic.span.line > boundaryLine).map(remap),
  ].sort((a, b) => a.span.start - b.span.start || a.span.end - b.span.end);
  return { ast: { ...unit, declarations }, diagnostics };
}
