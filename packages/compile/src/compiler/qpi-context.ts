import { Lexer } from "../lexer";
import { Parser } from "../parser";
import { Preprocessor, type MacroDef } from "../preprocess";
import { indexLibraryDeclarations, type LibrarySymbolIndex } from "../codegen";
import { embeddedWasmAbi, IMPL_BOUNDARY } from "../qpi-snapshot-format";

export interface QpiContext {
  macros: Map<string, MacroDef>;
  lib: LibrarySymbolIndex;
}

const qpiCache = new Map<string, QpiContext>();
const qpiPreludeCache = new Map<string, { preprocessedSource: string; macros: Map<string, MacroDef> }>();

function getQpiPrelude(headers: string): { preprocessedSource: string; macros: Map<string, MacroDef> } {
  const [mainHeaders] = headers.split(IMPL_BOUNDARY);
  const cached = qpiPreludeCache.get(mainHeaders);
  if (cached) return cached;

  const preprocessor = new Preprocessor();
  const preprocessedSource = preprocessor.preprocess({
    source: "",
    qpiHeader: mainHeaders,
    contractName: "__lib__",
    contractIndex: 0,
  });
  const prelude = { preprocessedSource, macros: preprocessor.getDefines() };
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
  const { preprocessedSource: libSource, macros } = getQpiPrelude(mainHeaders);
  const coreHeaderTu = new Parser(new Lexer(libSource).tokenize()).parseTranslationUnit();
  const coreLibrary = indexLibraryDeclarations(coreHeaderTu.declarations);
  const wasmAbi = embeddedWasmAbi(headers);
  coreLibrary.wasmAbi = wasmAbi;

  for (const implChunk of implChunks) {
    const implText = new Preprocessor().preprocess({
      source: implChunk,
      qpiHeader: "",
      contractName: "__impl__",
      contractIndex: 0,
      seedMacros: macros,
    });
    const implHeaderTu = new Parser(new Lexer(implText).tokenize()).parseTranslationUnit();
    const implLibrary = indexLibraryDeclarations(implHeaderTu.declarations, coreLibrary.namespaceUsings);
    const hasSourceBackedHostWrappers = implLibrary.importedFunctions.size > 0;
    for (const [name, definition] of implLibrary.globalStructs)
      if (!coreLibrary.globalStructs.has(name)) coreLibrary.globalStructs.set(name, definition);
    for (const [name, definition] of implLibrary.typedefs)
      if (!coreLibrary.typedefs.has(name)) coreLibrary.typedefs.set(name, definition);
    for (const [name, expression] of implLibrary.constexprInit)
      if (!coreLibrary.constexprInit.has(name)) coreLibrary.constexprInit.set(name, expression);
    for (const [name, type] of implLibrary.constexprType)
      if (!coreLibrary.constexprType.has(name)) coreLibrary.constexprType.set(name, type);
    for (const [name, value] of implLibrary.enumConst)
      if (!coreLibrary.enumConst.has(name)) coreLibrary.enumConst.set(name, value);
    for (const [name, size] of implLibrary.enumSize)
      if (!coreLibrary.enumSize.has(name)) coreLibrary.enumSize.set(name, size);
    for (const [name, type] of implLibrary.enumUnderlying)
      if (!coreLibrary.enumUnderlying.has(name)) coreLibrary.enumUnderlying.set(name, type);
    for (const [name, type] of implLibrary.enumConstType)
      if (!coreLibrary.enumConstType.has(name)) coreLibrary.enumConstType.set(name, type);
    for (const name of implLibrary.enumNames) coreLibrary.enumNames.add(name);
    for (const [cls, methods] of implLibrary.templateMethods) {
      if (!coreLibrary.templateMethods.has(cls)) coreLibrary.templateMethods.set(cls, new Map());
      for (const [name, definition] of methods) {
        if (hasSourceBackedHostWrappers && cls.startsWith("QpiContext")) {
          const baseName = name.includes("/") ? name.slice(0, name.indexOf("/")) : name;
          const declared = coreLibrary.globalStructs
            .get(cls)
            ?.members.find(
              (member) =>
                member.kind === "function" &&
                member.name === baseName &&
                member.params.length === (definition.functionParameters ?? []).length,
            );
          const merged =
            declared?.kind === "function"
            ? {
                  ...definition,
                  functionParameters: (definition.functionParameters ?? []).map((param, index) => ({
                    ...param,
                    defaultValue: param.defaultValue ?? declared.params[index]?.defaultValue,
                  })),
                }
              : definition;
          coreLibrary.templateMethods.get(cls)!.set(name, merged);
        } else if (!coreLibrary.templateMethods.get(cls)!.has(name))
          coreLibrary.templateMethods.get(cls)!.set(name, definition);
      }
    }
    for (const [name, definition] of implLibrary.libFns)
      if (!coreLibrary.libFns.has(name)) coreLibrary.libFns.set(name, definition);
    for (const [name, definitions] of implLibrary.libFnOverloads) {
      const current = coreLibrary.libFnOverloads.get(name);
      if (current) current.push(...definitions);
      else coreLibrary.libFnOverloads.set(name, [...definitions]);
    }
    for (const [name, definitions] of implLibrary.libFnTemplates) {
      const current = coreLibrary.libFnTemplates.get(name);
      if (current) current.push(...definitions);
      else coreLibrary.libFnTemplates.set(name, definitions);
    }
    for (const [scope, namespaces] of implLibrary.namespaceUsings) {
      const current = coreLibrary.namespaceUsings.get(scope) ?? [];
      for (const namespace of namespaces) if (!current.includes(namespace)) current.push(namespace);
      coreLibrary.namespaceUsings.set(scope, current);
    }
    for (const [declaration, context] of implLibrary.namespaceContexts)
      coreLibrary.namespaceContexts.set(declaration, context);
    for (const [name, definition] of implLibrary.importedFunctions) {
      const previous = coreLibrary.importedFunctions.get(name);
      if (previous) throw new Error(`duplicate imported function '${name}' in core QPI sources`);
      coreLibrary.importedFunctions.set(name, definition);
    }
  }

  const orderedImports = new Map<
    string,
    typeof coreLibrary.importedFunctions extends Map<string, infer V> ? V : never
  >();
  for (const row of wasmAbi.lhost) {
    const symbol = `__lhost_${row.name}`;
    const declaration = coreLibrary.importedFunctions.get(symbol);
    if (!declaration)
      throw new Error(`canonical LHOST import '${row.name}' has no LH_IMPORT declaration`);
    orderedImports.set(symbol, declaration);
  }
  const extraImports = [...coreLibrary.importedFunctions.keys()].filter(
    (name) => !orderedImports.has(name),
  );
  if (extraImports.length)
    throw new Error(
      `LH_IMPORT declarations missing from canonical metadata: ${extraImports.join(", ")}`,
    );
  coreLibrary.importedFunctions.clear();
  for (const [name, declaration] of orderedImports) coreLibrary.importedFunctions.set(name, declaration);

  const context = { macros, lib: coreLibrary };
  qpiCache.set(headers, context);
  return context;
}
