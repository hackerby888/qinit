import { Lexer } from "../lexer";
import { Parser, type Diagnostic as ParserDiagnostic } from "../parser";
import { Preprocessor } from "../preprocess";
import { SCAFFOLD_MACROS } from "../qpi-scaffold";
import type { CompileOpts } from "./types";
import type { QpiContext } from "./qpi-context";
import {
  makeUserDiagnosticRemapper,
  scanUnterminatedSource,
  sourceWithoutLeadingBom,
  USER_BOUNDARY,
} from "./diagnostics";

export interface CalleeContext {
  structs: Map<string, any>;
  translationUnits: Array<{ name: string; decls: any[] }>;
  diagnostics: ParserDiagnostic[];
}

export function buildCalleeContext(opts: CompileOpts, qpi: QpiContext): CalleeContext {
  const structs = new Map<string, any>();
  const translationUnits: Array<{ name: string; decls: any[] }> = [];
  const diagnostics: ParserDiagnostic[] = [];

  for (const callee of opts.calleeSources ?? []) {
    const early = scanUnterminatedSource(callee.source).map((diagnostic) => ({
      ...diagnostic,
      message: `Callee '${callee.name}': ${diagnostic.message}`,
    }));
    diagnostics.push(...early);
    if (early.some((diagnostic) => diagnostic.severity === "error")) continue;

    const source = `${SCAFFOLD_MACROS}\nstruct ${USER_BOUNDARY} {};\n${sourceWithoutLeadingBom(callee.source)}`;
    const text = new Preprocessor().preprocess({
      source,
      qpiHeader: "",
      contractName: callee.name,
      contractIndex: 0,
      seedMacros: qpi.macros,
    });
    const boundaryIndex = text.indexOf(USER_BOUNDARY);
    const boundaryLine = boundaryIndex >= 0 ? text.slice(0, boundaryIndex).split("\n").length : 0;
    const remap = makeUserDiagnosticRemapper(callee.source, text, boundaryLine);
    const parser = new Parser(new Lexer(text).tokenize());
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

    translationUnits.push({ name: callee.name, decls: unit.declarations });
    for (const declaration of unit.declarations) {
      if (declaration.kind !== "struct") continue;
      const struct = declaration as any;
      const isContract =
        struct.bases?.some((base: any) => base.kind === "name" && base.name === "ContractBase") ||
        struct.name === "CONTRACT_STATE_TYPE";
      if (!isContract) continue;
      for (const member of struct.members ?? []) {
        if (member.kind === "struct" && member.name)
          structs.set(`${callee.name}::${member.name}`, member);
      }
    }
  }

  return { structs, translationUnits, diagnostics };
}
