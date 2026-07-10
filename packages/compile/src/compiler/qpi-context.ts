import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { Preprocessor, type MacroDef } from "../preprocess";
import { buildLibTypes, type LibTypes } from "../codegen";
import { IMPL_BOUNDARY } from "../qpi-snapshot";

export interface QpiContext {
  macros: Map<string, MacroDef>;
  lib: LibTypes;
}

const qpiCache = new Map<string, QpiContext>();

export function getQpiContext(headers: string): QpiContext {
  const cached = qpiCache.get(headers);
  if (cached) return cached;

  const [mainHeaders, ...implChunks] = headers.split(IMPL_BOUNDARY);
  const pp = new Preprocessor();
  const libText = pp.preprocess({ source: "", qpiHeader: mainHeaders, contractName: "__lib__", contractIndex: 0 });
  const macros = pp.getDefines();
  const libTu = new Parser(new Lexer(libText).tokenize()).parseTranslationUnit();
  const lib = buildLibTypes(libTu.declarations);

  for (const chunk of implChunks) {
    const implText = new Preprocessor().preprocess({
      source: chunk,
      qpiHeader: "",
      contractName: "__impl__",
      contractIndex: 0,
      seedMacros: macros,
    });
    const implTu = new Parser(new Lexer(implText).tokenize()).parseTranslationUnit();
    const implLib = buildLibTypes(implTu.declarations);
    for (const [cls, methods] of implLib.templateMethods) {
      if (!lib.templateMethods.has(cls)) lib.templateMethods.set(cls, new Map());
      for (const [name, definition] of methods) {
        if (!lib.templateMethods.get(cls)!.has(name)) lib.templateMethods.get(cls)!.set(name, definition);
      }
    }
    for (const [name, definition] of implLib.libFns) if (!lib.libFns.has(name)) lib.libFns.set(name, definition);
    for (const [name, definitions] of implLib.libFnTemplates) {
      const current = lib.libFnTemplates.get(name);
      if (current) current.push(...definitions);
      else lib.libFnTemplates.set(name, definitions);
    }
  }

  const context = { macros, lib };
  qpiCache.set(headers, context);
  return context;
}
