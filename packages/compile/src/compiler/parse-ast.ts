import type { TranslationUnit } from "../ast";
import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import { makeUserDiagnosticRemapper, scanUnterminatedSource, sourceWithoutLeadingBom, USER_BOUNDARY } from "./diagnostics";
import { getQpiMacros } from "./qpi-macros";

export interface ParseAstResult {
  ast: TranslationUnit;
  diagnostics: ParserDiagnostic[];
}

export function parseToAst(options: {
  source: string;
  qpiHeader?: string;
  name?: string;
  slot?: number;
}): ParseAstResult {
  if (options.qpiHeader === undefined)
    throw new Error("internal parser requires a QPI header snapshot");
  const macros = getQpiMacros(options.qpiHeader);
  const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(options.source)}`;
  const preprocessedSource = new Preprocessor().preprocess({
    source,
    qpiHeader: "",
    contractName: options.name ?? "Contract",
    contractIndex: options.slot ?? 0,
    seedMacros: macros,
  });
  const boundaryIndex = preprocessedSource.indexOf(USER_BOUNDARY);
  const boundaryLine = boundaryIndex >= 0 ? preprocessedSource.slice(0, boundaryIndex).split("\n").length : 0;
  const remap = makeUserDiagnosticRemapper(options.source, preprocessedSource, boundaryLine);
  const parser = new Parser(new Lexer(preprocessedSource).tokenize());
  const unit = parser.parseTranslationUnit();
  const declarations = unit.declarations.filter(
    (declaration) =>
      (declaration.span?.line ?? 0) > boundaryLine &&
      (declaration as { name?: string }).name !== USER_BOUNDARY,
  );
  const diagnostics = [
    ...scanUnterminatedSource(options.source),
    ...parser
      .getDiagnostics()
      .filter((diagnostic) => diagnostic.span.line > boundaryLine)
      .map(remap),
  ].sort((argument, templateBindings) => argument.span.start - templateBindings.span.start || argument.span.end - templateBindings.span.end);
  return { ast: { ...unit, declarations }, diagnostics };
}
