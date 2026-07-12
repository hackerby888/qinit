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
    const implLib = buildLibTypes(implTu.declarations, lib.namespaceUsings);
    for (const [name, definition] of implLib.globalStructs) if (!lib.globalStructs.has(name)) lib.globalStructs.set(name, definition);
    for (const [name, definition] of implLib.typedefs) if (!lib.typedefs.has(name)) lib.typedefs.set(name, definition);
    for (const [name, expression] of implLib.constexprInit) if (!lib.constexprInit.has(name)) lib.constexprInit.set(name, expression);
    for (const [name, type] of implLib.constexprType) if (!lib.constexprType.has(name)) lib.constexprType.set(name, type);
    for (const [name, value] of implLib.enumConst) if (!lib.enumConst.has(name)) lib.enumConst.set(name, value);
    for (const [name, size] of implLib.enumSize) if (!lib.enumSize.has(name)) lib.enumSize.set(name, size);
    for (const [name, type] of implLib.enumUnderlying) if (!lib.enumUnderlying.has(name)) lib.enumUnderlying.set(name, type);
    for (const [name, type] of implLib.enumConstType) if (!lib.enumConstType.has(name)) lib.enumConstType.set(name, type);
    for (const name of implLib.enumNames) lib.enumNames.add(name);
    for (const [cls, methods] of implLib.templateMethods) {
      if (!lib.templateMethods.has(cls)) lib.templateMethods.set(cls, new Map());
      for (const [name, definition] of methods) {
        if (!lib.templateMethods.get(cls)!.has(name)) lib.templateMethods.get(cls)!.set(name, definition);
      }
    }
    for (const [name, definition] of implLib.libFns) if (!lib.libFns.has(name)) lib.libFns.set(name, definition);
    for (const [name, definitions] of implLib.libFnOverloads) {
      const current = lib.libFnOverloads.get(name);
      if (current) current.push(...definitions);
      else lib.libFnOverloads.set(name, [...definitions]);
    }
    for (const [name, definitions] of implLib.libFnTemplates) {
      const current = lib.libFnTemplates.get(name);
      if (current) current.push(...definitions);
      else lib.libFnTemplates.set(name, definitions);
    }
    for (const [scope, namespaces] of implLib.namespaceUsings) {
      const current = lib.namespaceUsings.get(scope) ?? [];
      for (const namespace of namespaces) if (!current.includes(namespace)) current.push(namespace);
      lib.namespaceUsings.set(scope, current);
    }
    for (const [declaration, context] of implLib.namespaceContexts) lib.namespaceContexts.set(declaration, context);
  }

  const context = { macros, lib };
  qpiCache.set(headers, context);
  return context;
}
