import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import type { Declaration, StructDecl } from "../ast";
import type { CompileOptions } from "./types";
import type { QpiContext } from "./qpi-context";
import {
  makeUserDiagnosticRemapper,
  scanUnterminatedSource,
  sourceWithoutLeadingBom,
  USER_BOUNDARY,
} from "./diagnostics";

export interface CalleeContext {
  contractStructs: Map<string, StructDecl>;
  calleeTranslationUnits: Array<{ contractName: string; declarations: Declaration[] }>;
  diagnostics: ParserDiagnostic[];
}

export function collectCalleeContext(options: CompileOptions, qpi: QpiContext): CalleeContext {
  const contractStructs = new Map<string, StructDecl>();
  const calleeTranslationUnits: Array<{ contractName: string; declarations: Declaration[] }> = [];
  const diagnostics: ParserDiagnostic[] = [];

  for (const callee of options.calleeSources ?? []) {
    const early = scanUnterminatedSource(callee.source).map((diagnostic) => ({
      ...diagnostic,
      message: `Callee '${callee.name}': ${diagnostic.message}`,
    }));
    diagnostics.push(...early);
    if (early.some((diagnostic) => diagnostic.severity === "error")) continue;

    const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(callee.source)}`;
    const preprocessedSource = new Preprocessor().preprocess({
      source,
      qpiHeader: "",
      contractName: callee.name,
      contractIndex: 0,
      seedMacros: qpi.macros,
    });
    const boundaryIndex = preprocessedSource.indexOf(USER_BOUNDARY);
    const boundaryLine = boundaryIndex >= 0 ? preprocessedSource.slice(0, boundaryIndex).split("\n").length : 0;
    const remap = makeUserDiagnosticRemapper(callee.source, preprocessedSource, boundaryLine);
    const parser = new Parser(new Lexer(preprocessedSource).tokenize());
    const unit = parser.parseTranslationUnit();
    const parsed = parser
      .getDiagnostics()
      .filter((diagnostic) => diagnostic.span.line > boundaryLine)
      .map((diagnostic) => ({
        ...remap(diagnostic),
        message: `Callee '${callee.name}': ${diagnostic.message}`,
      }));
    diagnostics.push(...parsed);
    if (parsed.some((diagnostic) => diagnostic.severity === "error")) continue;

    calleeTranslationUnits.push({ contractName: callee.name, declarations: unit.declarations });
    for (const declaration of unit.declarations) {
      if (declaration.kind !== "struct") continue;
      const struct = declaration;
      const isContract =
        struct.bases?.some((base) => base.kind === "name" && base.name === "ContractBase") ||
        struct.name === "CONTRACT_STATE_TYPE";
      if (!isContract) continue;
      for (const member of struct.members ?? []) {
        if (member.kind === "struct" && member.name)
          contractStructs.set(`${callee.name}::${member.name}`, member);
      }
    }
  }

  return { contractStructs, calleeTranslationUnits, diagnostics };
}
