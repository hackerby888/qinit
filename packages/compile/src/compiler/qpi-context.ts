import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { Preprocessor, type MacroDef } from "../preprocess";
import { buildLibTypes, type LibTypes } from "../codegen";
import { embeddedLiteAbi, IMPL_BOUNDARY } from "../qpi-snapshot-format";

export interface QpiContext {
  macros: Map<string, MacroDef>;
  lib: LibTypes;
}

const qpiCache = new Map<string, QpiContext>();
const qpiPreludeCache = new Map<string, { text: string; macros: Map<string, MacroDef> }>();

function getQpiPrelude(headers: string): { text: string; macros: Map<string, MacroDef> } {
  const [mainHeaders] = headers.split(IMPL_BOUNDARY);
  const cached = qpiPreludeCache.get(mainHeaders);
  if (cached) return cached;

  const pp = new Preprocessor();
  const text = pp.preprocess({
    source: "",
    qpiHeader: mainHeaders,
    contractName: "__lib__",
    contractIndex: 0,
  });
  const prelude = { text, macros: pp.getDefines() };
  qpiPreludeCache.set(mainHeaders, prelude);
  return prelude;
}

export function getQpiMacros(headers: string): Map<string, MacroDef> {
  return getQpiPrelude(headers).macros;
}

export function getQpiContext(headers: string): QpiContext {
  const cached = qpiCache.get(headers);
  if (cached) return cached;

  const [mainHeaders, ...implChunks] = headers.split(IMPL_BOUNDARY);
  const { text: libText, macros } = getQpiPrelude(mainHeaders);
  const libTu = new Parser(new Lexer(libText).tokenize()).parseTranslationUnit();
  const lib = buildLibTypes(libTu.declarations);
  const liteAbi = embeddedLiteAbi(headers);
  lib.liteAbi = liteAbi;

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
    const sourceBackedHostWrappers = implLib.importedFunctions.size > 0;
    for (const [name, definition] of implLib.globalStructs)
      if (!lib.globalStructs.has(name)) lib.globalStructs.set(name, definition);
    for (const [name, definition] of implLib.typedefs)
      if (!lib.typedefs.has(name)) lib.typedefs.set(name, definition);
    for (const [name, expression] of implLib.constexprInit)
      if (!lib.constexprInit.has(name)) lib.constexprInit.set(name, expression);
    for (const [name, type] of implLib.constexprType)
      if (!lib.constexprType.has(name)) lib.constexprType.set(name, type);
    for (const [name, value] of implLib.enumConst)
      if (!lib.enumConst.has(name)) lib.enumConst.set(name, value);
    for (const [name, size] of implLib.enumSize)
      if (!lib.enumSize.has(name)) lib.enumSize.set(name, size);
    for (const [name, type] of implLib.enumUnderlying)
      if (!lib.enumUnderlying.has(name)) lib.enumUnderlying.set(name, type);
    for (const [name, type] of implLib.enumConstType)
      if (!lib.enumConstType.has(name)) lib.enumConstType.set(name, type);
    for (const name of implLib.enumNames) lib.enumNames.add(name);
    for (const [cls, methods] of implLib.templateMethods) {
      if (!lib.templateMethods.has(cls)) lib.templateMethods.set(cls, new Map());
      for (const [name, definition] of methods) {
        if (sourceBackedHostWrappers && cls.startsWith("QpiContext")) {
          const baseName = name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
          const declared = lib.globalStructs
            .get(cls)
            ?.members.find(
              (member) =>
                member.kind === "function" &&
                member.name === baseName &&
                member.params.length === (definition.fnParams ?? []).length,
            );
          const merged =
            declared?.kind === "function"
              ? {
                  ...definition,
                  fnParams: (definition.fnParams ?? []).map((param, index) => ({
                    ...param,
                    defaultValue: param.defaultValue ?? declared.params[index]?.defaultValue,
                  })),
                }
              : definition;
          lib.templateMethods.get(cls)!.set(name, merged);
        } else if (!lib.templateMethods.get(cls)!.has(name))
          lib.templateMethods.get(cls)!.set(name, definition);
      }
    }
    for (const [name, definition] of implLib.libFns)
      if (!lib.libFns.has(name)) lib.libFns.set(name, definition);
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
    for (const [declaration, context] of implLib.namespaceContexts)
      lib.namespaceContexts.set(declaration, context);
    for (const [name, definition] of implLib.importedFunctions) {
      const previous = lib.importedFunctions.get(name);
      if (previous) throw new Error(`duplicate imported function '${name}' in core QPI sources`);
      lib.importedFunctions.set(name, definition);
    }
  }

  const orderedImports = new Map<
    string,
    typeof lib.importedFunctions extends Map<string, infer V> ? V : never
  >();
  for (const row of liteAbi.lhost) {
    const symbol = `__lhost_${row.name}`;
    const declaration = lib.importedFunctions.get(symbol);
    if (!declaration)
      throw new Error(`canonical LHOST import '${row.name}' has no LH_IMPORT declaration`);
    orderedImports.set(symbol, declaration);
  }
  const extraImports = [...lib.importedFunctions.keys()].filter(
    (name) => !orderedImports.has(name),
  );
  if (extraImports.length)
    throw new Error(
      `LH_IMPORT declarations missing from canonical metadata: ${extraImports.join(", ")}`,
    );
  lib.importedFunctions.clear();
  for (const [name, declaration] of orderedImports) lib.importedFunctions.set(name, declaration);

  const context = { macros, lib };
  qpiCache.set(headers, context);
  return context;
}
