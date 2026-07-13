import { resolveExpressionAddress, emitAddress, allocateScratchSlot, narrowCast, argAddr } from "../address-resolution";
import { emitHelperFunction } from "../statement-emitter";
import { CodeGenerationContext } from "../code-generation-context";
import {
  lowerValueExpression,
  isUnsignedExpr,
  emitValue,
  promoteInfo,
  scalarTypeInfo,
  unsignedScalar,
  isU128Expr,
} from "../expression-lowering";
import { FunctionEmissionContext, CompiledHelperMetadata, TemplateBindings, EMPTY_TEMPLATE_BINDINGS } from "../types";
import {
  MATH_INTRINSIC_NAMES,
  SCALAR_SIZE,
  isAuthoritativeSymbol,
  symbolBaseName,
} from "../tables";
import type {
  TypeSpec,
  Expression,
  Statement,
  Declaration,
  StructDecl,
  FunctionDecl,
  FunctionTemplateDecl,
  VariableDecl,
  TemplateParam,
  ParamDecl,
} from "../../ast";
import * as watIr from "../../wat-ir";

// Call to a contract value helper (toReturnCode(...)): scalar args by value, aggregate args by address. valueWanted → returns
export function compileLibraryFunction(
  codeGenerationContext: CodeGenerationContext,
  name: string,
  definition?: FunctionDecl,
  cacheKey = name,
): CompiledHelperMetadata | null {
  const cached = codeGenerationContext.helpers.get(cacheKey);
  if (cached) return cached;
  // Resolve via namespace candidates (using-directives + lexical source). libFns are keyed by full namespace path.
  let resolvedKey = name;
  let fn = definition;
  if (!fn) {
    for (const key of codeGenerationContext.namespaceCandidates(name)) {
      const hit = codeGenerationContext.libFns.get(key);
      if (hit) {
        fn = hit;
        resolvedKey = key;
        break;
      }
    }
  }
  if (!fn || !fn.body) return null;
  const params = fn.params.map((parameter) => {
    // A NON-const scalar reference (RL::makeDateStamp's `uint32& res`) is an out-param and must travel by address for the write
    const isConstRef = parameter.type.kind === "reference" && parameter.type.referentType?.kind === "const";
    const isPtrRef = (parameter.type.kind === "reference" && !isConstRef) || parameter.type.kind === "pointer";
    const isAddr = isPtrRef || codeGenerationContext.isAggregateType(parameter.type);
    const byValAgg = isAddr && parameter.type.kind !== "reference" && parameter.type.kind !== "pointer";
    return {
      name: parameter.name,
      wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
      isAddr,
      type: codeGenerationContext.derefType(parameter.type),
      byValAgg,
    };
  });
  const retAgg =
    !codeGenerationContext.isVoidType(fn.returnType) && codeGenerationContext.isAggregateType(fn.returnType)
      ? codeGenerationContext.sizeOfType(fn.returnType)
      : undefined;
  const retIsValue = !codeGenerationContext.isVoidType(fn.returnType) && !retAgg;
  const nameSep = resolvedKey.lastIndexOf("::");
  const authoritative = isAuthoritativeSymbol(resolvedKey);
  const lookup = codeGenerationContext.namespaceContextOf(fn);
  const info: CompiledHelperMetadata = {
    label: `$lib${codeGenerationContext.helpers.size}_${resolvedKey.replace(/[^a-zA-Z0-9]/g, "_")}`,
    params,
    retIsValue,
    retAgg,
    retType: codeGenerationContext.derefType(fn.returnType),
    sourceNamespace: nameSep >= 0 ? resolvedKey.slice(0, nameSep) : undefined,
    usingNamespaces: lookup.usingNamespaces,
  };
  codeGenerationContext.helpers.set(cacheKey, info); // register before emit so recursion/sibling calls resolve
  try {
    const warningBase = codeGenerationContext.warnings.length;
    const errorBase = codeGenerationContext.errors.length;
    const wat = emitHelperFunction(codeGenerationContext, info, fn, { size: 0, align: 1, fields: new Map() });
    if (authoritative && (codeGenerationContext.warnings.length !== warningBase || codeGenerationContext.errors.length !== errorBase)) {
      const diagnostic =
        codeGenerationContext.errors[errorBase]?.message ??
        codeGenerationContext.warnings[warningBase]?.message ??
        "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    codeGenerationContext.emittedMethodOrder.push(wat);
  } catch (entry: any) {
    codeGenerationContext.warn(`failed to compile lib fn ${resolvedKey}: ${entry.message}`, fn.span?.line ?? 0);
    codeGenerationContext.helpers.delete(cacheKey);
    if (authoritative) throw entry;
    return null;
  }
  return info;
}

// Deduce template bindings (T→sint64, L→4) for a free function template from the concrete types of its call-site arguments:
export function deduceLibraryFunctionBindings(
  context: FunctionEmissionContext,
  def: FunctionTemplateDecl,
  callArguments: Expression[],
  explicit: TypeSpec[] = [],
): TemplateBindings {
  const types = new Map<string, TypeSpec>();
  const values = new Map<string, bigint>();
  const typeParams = new Set(def.params.filter((parameter) => parameter.kind === "type").map((type) => type.name));
  const valueParams = new Set(def.params.filter((parameter) => parameter.kind !== "type").map((type) => type.name));
  const fps = def.functionParameters ?? [];

  def.params.forEach((param, index) => {
    const argument = explicit[index];
    if (!argument) return;
    if (param.kind === "type") {
      types.set(param.name, context.thisBind ? context.codeGenerationContext.substInBindings(argument, context.thisBind) : argument);
    } else {
      values.set(param.name, context.codeGenerationContext.valueOfTypeArg(argument, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
    }
  });

  const argType = (expression: Expression): TypeSpec | null => {
    let type = resolveExpressionAddress(context, expression)?.type ?? null;
    if (!type) {
      // A computed uint128 rvalue has no lvalue address until call lowering materializes it,
      // but template deduction still sees its class type (`div(a * b, c)` in GGWP/Qswap).
      if (isU128Expr(context, expression)) return { kind: "name", name: "uint128_t" };
      const scalar = scalarTypeInfo(context, expression);
      if (!scalar) return null;
      const name =
        scalar.width <= 4
          ? scalar.unsigned
            ? "uint32"
            : "sint32"
          : scalar.unsigned
            ? "uint64"
            : "sint64";
      return { kind: "name", name };
    }
    type = context.codeGenerationContext.derefType(type);
    // Resolve through the caller's template bindings so the deduced type is concrete (ProposalDataType → ProposalDataV1<false>), not a symbolic
    if (context.thisBind) type = context.codeGenerationContext.derefType(context.codeGenerationContext.substInBindings(type, context.thisBind));
    for (let index = 0; index < 8 && type.kind === "name"; index++) {
      const td = context.codeGenerationContext.typedefs.get(type.name);
      if (!td) break;
      type = context.codeGenerationContext.derefType(td);
    }
    return type;
  };

  for (let fpIndex = 0; fpIndex < fps.length; fpIndex++) {
    const argument = callArguments[fpIndex];
    if (!argument) continue;
    const pt = context.codeGenerationContext.derefType(fps[fpIndex].type);
    if (pt.kind === "template_instance") {
      const at = argType(argument);
      if (at?.kind !== "template_instance" || at.name !== pt.name) continue;
      for (let nestedIndex = 0; nestedIndex < pt.callArguments.length && nestedIndex < at.callArguments.length; nestedIndex++) {
        const pa = pt.callArguments[nestedIndex];
        if (pa.kind !== "name") continue;
        if (typeParams.has(pa.name) && !types.has(pa.name)) types.set(pa.name, at.callArguments[nestedIndex]);
        else if (valueParams.has(pa.name) && !values.has(pa.name))
          values.set(pa.name, context.codeGenerationContext.valueOfTypeArg(at.callArguments[nestedIndex]));
      }
    } else if (pt.kind === "name" && typeParams.has(pt.name) && !types.has(pt.name)) {
      const at = argType(argument);
      if (at) types.set(pt.name, at);
    }
  }
  return { types, values, structs: new Map() };
}

// Pick the overload whose parameter patterns best match the concrete argument types. A concrete name
export function selectLibraryFunctionOverload(
  context: FunctionEmissionContext,
  defs: FunctionTemplateDecl[],
  callArguments: Expression[],
): FunctionTemplateDecl {
  if (defs.length === 1) return defs[0];

  const argTypeOf = (expression: Expression): TypeSpec | null => {
    let type = resolveExpressionAddress(context, expression)?.type ?? null;
    if (!type) return null;
    type = context.codeGenerationContext.derefType(type);
    if (context.thisBind) type = context.codeGenerationContext.derefType(context.codeGenerationContext.substInBindings(type, context.thisBind));
    return type;
  };
  const argTypes = callArguments.map(argTypeOf);

  const score = (def: FunctionTemplateDecl): number => {
    const fps = def.functionParameters ?? [];
    if (callArguments.length > fps.length) return -1;
    const tparams = new Set(def.params.map((parameter) => parameter.name));

    let size = 0;
    for (let index = 0; index < fps.length && index < callArguments.length; index++) {
      const pat = context.codeGenerationContext.derefType(fps[index].type);
      const at = argTypes[index];
      if (!at) continue;
      if (pat.kind === "name") {
        if (tparams.has(pat.name)) size += 1;
        else if (at.kind === "name" && at.name === pat.name) size += 2;
        continue;
      }
      if (pat.kind === "template_instance" && at.kind === "template_instance") {
        if (pat.name !== at.name) return -1;
        for (let nestedIndex = 0; nestedIndex < pat.callArguments.length && nestedIndex < at.callArguments.length; nestedIndex++) {
          const pa = pat.callArguments[nestedIndex];
          if (pa.kind !== "name") continue;
          if (tparams.has(pa.name)) {
            size += 1;
          } else {
            const aa = at.callArguments[nestedIndex];
            if (aa.kind === "name" && aa.name === pa.name) size += 2;
            else if (aa.kind === "template_instance" && aa.name === pa.name) size += 2;
            else return -1;
          }
        }
      }
    }
    return size;
  };

  let best = defs[0];
  let bestScore = score(defs[0]);
  for (let definitionIndex = 1; definitionIndex < defs.length; definitionIndex++) {
    const size = score(defs[definitionIndex]);
    if (size > bestScore) {
      best = defs[definitionIndex];
      bestScore = size;
    }
  }
  return best;
}

// Instantiate a free function template for the concrete types at a call site, emitting its wasm function.
export function compileLibraryFunctionInstance(
  context: FunctionEmissionContext,
  def: FunctionTemplateDecl,
  callArguments: Expression[],
  explicit: TypeSpec[] = [],
  authoritative = false,
  sourceKey = def.name,
): CompiledHelperMetadata | null {
  const codeGenerationContext = context.codeGenerationContext;
  const bind = deduceLibraryFunctionBindings(context, def, callArguments, explicit);
  const keyArgs = def.params
    .map((parameter) =>
      parameter.kind === "type"
        ? codeGenerationContext.typeKeyOf(bind.types.get(parameter.name) ?? { kind: "name", name: parameter.name })
        : (bind.values.get(parameter.name)?.toString() ?? parameter.name),
    )
    .join(",");
  // The overload's source line disambiguates same-name defs whose deduced args coincide.
  const key = `${def.name}@${def.span?.line ?? 0}<${keyArgs}>`;
  const cached = codeGenerationContext.helpers.get(key);
  if (cached) return cached;

  const params = (def.functionParameters ?? []).map((parameter) => {
    const concrete = codeGenerationContext.substInBindings(codeGenerationContext.derefType(parameter.type), bind);
    const aggregate = codeGenerationContext.isAggregateType(concrete);
    const constScalarRef =
      parameter.type.kind === "reference" && parameter.type.referentType.kind === "const" && !aggregate;
    const isPtrRef = parameter.type.kind === "pointer" || (parameter.type.kind === "reference" && !constScalarRef);
    const isAddr = isPtrRef || aggregate;
    const byValAgg = isAddr && !isPtrRef && aggregate;
    return {
      name: parameter.name,
      wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
      isAddr,
      type: concrete,
      byValAgg,
    };
  });
  const retT = codeGenerationContext.substInBindings(codeGenerationContext.derefType(def.returnType), bind);
  const retAgg =
    !codeGenerationContext.isVoidType(def.returnType) && codeGenerationContext.isAggregateType(retT)
      ? codeGenerationContext.sizeOfType(retT, bind)
      : undefined;
  const retIsValue = !codeGenerationContext.isVoidType(def.returnType) && !retAgg;
  const sourceSep = sourceKey.lastIndexOf("::");
  const lookup = codeGenerationContext.namespaceContextOf(def);
  const info: CompiledHelperMetadata = {
    label: `$lib${codeGenerationContext.helpers.size}_${key.replace(/[^a-zA-Z0-9]/g, "_")}`,
    params,
    retIsValue,
    retAgg,
    retType: retT,
    sourceNamespace: sourceSep >= 0 ? sourceKey.slice(0, sourceSep) : undefined,
    usingNamespaces: lookup.usingNamespaces,
  };
  codeGenerationContext.helpers.set(key, info); // register before emit so recursive/sibling calls resolve
  try {
    const warningBase = codeGenerationContext.warnings.length;
    const errorBase = codeGenerationContext.errors.length;
    const wat = emitHelperFunction(codeGenerationContext, info, def, { size: 0, align: 1, fields: new Map() }, bind);
    if (authoritative && (codeGenerationContext.warnings.length !== warningBase || codeGenerationContext.errors.length !== errorBase)) {
      const diagnostic =
        codeGenerationContext.errors[errorBase]?.message ??
        codeGenerationContext.warnings[warningBase]?.message ??
        "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    codeGenerationContext.emittedMethodOrder.push(wat);
  } catch (entry: any) {
    codeGenerationContext.warn(`failed to instantiate lib fn ${key}: ${entry.message}`, def.span?.line ?? 0);
    codeGenerationContext.helpers.delete(key);
    if (authoritative) throw entry;
    return null;
  }
  return info;
}

// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
export function helperCallOps(context: FunctionEmissionContext, info: CompiledHelperMetadata, callArguments: Expression[]): string {
  return info.params
    .map((parameter, parameterIndex) => {
      const argument = callArguments[parameterIndex];
      if (!argument)
        throw new Error(
          `${info.sourceNamespace ?? info.label} is missing required argument ${parameterIndex + 1}`,
        );
      if (parameter.isAddr) {
        return argAddr(
          context,
          argument,
          context.codeGenerationContext.sizeOfType(parameter.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
          parameter.type,
          false,
          true,
        );
      }
      const declared = context.codeGenerationContext.derefType(parameter.type);
      const value = narrowCast(
        emitValue(context, argument),
        declared.kind === "name" ? declared.name : undefined,
      );
      return parameter.wasmType === "i32" ? `(i32.wrap_i64 ${value})` : value;
    })
    .join(" ");
}

// Aggregate-returning helpers allocate destination first, then pass it as the leading $ret arg.
export function emitAggHelperCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  info: CompiledHelperMetadata,
): string {
  const scratchAddress = allocateScratchSlot(context, info.retAgg!);
  const helperArgumentOperands = helperCallOps(context, info, expression.callArguments);
  context.lines.push(`    (call ${info.label} ${scratchAddress}${helperArgumentOperands ? " " + helperArgumentOperands : ""})`);
  return scratchAddress;
}

// Scalar width/signedness of a declared parameter or return type, or null for aggregates/unknowns.
function scalarDeclInfo(context: FunctionEmissionContext, type: TypeSpec): { width: number; unsigned: boolean } | null {
  const dereferencedType = context.codeGenerationContext.derefType(type);
  const name =
    dereferencedType.kind === "name" && dereferencedType.name.includes("::")
      ? dereferencedType.name.slice(dereferencedType.name.lastIndexOf("::") + 2)
      : dereferencedType.kind === "name"
        ? dereferencedType.name
        : "";
  // The parser keeps a plain C `int` as `int`, while QPI's corresponding
  // typedef is spelled `sint32`. Treat the C spelling as its canonical signed
  const canonical =
    name === "int" || name === "signed"
      ? "signed int"
      : name === "unsigned"
        ? "unsigned int"
        : name;
  const normalized: TypeSpec = dereferencedType.kind === "name" ? { ...dereferencedType, name: canonical } : dereferencedType;
  const byteWidth = normalized.kind === "name" ? SCALAR_SIZE[normalized.name] : undefined;
  if (byteWidth === undefined || byteWidth > 8) return null;
  return { width: byteWidth, unsigned: unsignedScalar(normalized) };
}

// Rank a member-helper overload set against the call's argument types, mirroring C++ overload resolution over the scalar subset:
export function pickHelperOverload(context: FunctionEmissionContext, set: CompiledHelperMetadata[], callArguments: Expression[]): CompiledHelperMetadata {
  if (set.length === 1) return set[0];

  const argInfos = callArguments.map((argument) => scalarTypeInfo(context, argument));
  const rank = (cand: CompiledHelperMetadata): number => {
    if (cand.params.length !== callArguments.length) return -1;
    let size = 0;
    for (let argumentIndex = 0; argumentIndex < callArguments.length; argumentIndex++) {
      const pi = scalarDeclInfo(context, cand.params[argumentIndex].type);
      const ai = argInfos[argumentIndex];
      if (!pi || !ai) continue;
      if (pi.width === ai.width && pi.unsigned === ai.unsigned) size += 2;
      else if (pi.width === ai.width) size += 1;
    }
    return size;
  };

  let best = set[0];
  let bestScore = rank(set[0]);
  for (let setItemIndex = 1; setItemIndex < set.length; setItemIndex++) {
    const size = rank(set[setItemIndex]);
    if (size > bestScore) {
      best = set[setItemIndex];
      bestScore = size;
    }
  }
  return best;
}

// Resolve a helper / lib-fn name to its (possibly just-compiled) info, or null.
export function lookupHelper(context: FunctionEmissionContext, expression: Expression & { kind: "call" }): CompiledHelperMetadata | null {
  if (expression.callee.kind !== "identifier") return null;
  // Match the intrinsics by base name — a qualified QPI::div would otherwise slip past this guard, get instantiated
  const name = expression.callee.name;
  const base = symbolBaseName(name);
  const sourceKeys = context.codeGenerationContext.namespaceCandidates(name, context.sourceNamespace, context.usingNamespaces);
  const set = context.codeGenerationContext.helperOverloads.get(expression.callee.name);
  let info: CompiledHelperMetadata | null | undefined = set?.length
    ? pickHelperOverload(context, set, expression.callArguments)
    : sourceKeys.map((key) => context.codeGenerationContext.helpers.get(key)).find((candidate) => candidate !== undefined);
  if (!info) {
    for (const sourceKey of sourceKeys) {
      const defs = context.codeGenerationContext.libFnOverloads.get(sourceKey);
      if (!defs?.length) continue;
      const compiled = defs
        .map((definition, index) =>
          compileLibraryFunction(
            context.codeGenerationContext,
            sourceKey,
            definition,
            `${sourceKey}@${definition.span?.line ?? index}`,
          ),
        )
        .filter((candidate): candidate is CompiledHelperMetadata => candidate !== null);
      if (compiled.length) info = pickHelperOverload(context, compiled, expression.callArguments);
      if (info) break;
    }
  }
  if (!info && !MATH_INTRINSIC_NAMES.has(base)) {
    info = compileLibraryFunction(context.codeGenerationContext, expression.callee.name);
  }
  if (!info) {
    // A namespace free function template (isArraySortedWithoutDuplicates<T,L>): instantiate for this call, picking the overload whose parameter patterns match the
    const templateKey = sourceKeys.find((key) => context.codeGenerationContext.libFnTemplates.has(key));
    const tdefs = templateKey ? context.codeGenerationContext.libFnTemplates.get(templateKey) : undefined;
    if (tdefs?.length)
      info = compileLibraryFunctionInstance(
        context,
        selectLibraryFunctionOverload(context, tdefs, expression.callArguments),
        expression.callArguments,
        (expression as Expression & { templateArguments?: TypeSpec[] }).templateArguments ?? [],
        isAuthoritativeSymbol(templateKey!),
        templateKey!,
      );
  }
  if (!info && name.includes("::")) {
    // Qualified static member calls resolve by flattened namespace members; structByName strips qualifiers.
    const segs = name.split("::");
    const method = segs[segs.length - 1];
    const ownerName = segs.slice(0, -1).join("::");
    const boundOwner =
      context.thisBind?.types.get(ownerName) ?? context.thisBind?.types.get(ownerName.split("::").pop()!);
    const sd = boundOwner
      ? (context.codeGenerationContext.structOf(boundOwner, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) ?? undefined)
      : context.codeGenerationContext.structByName(ownerName, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    const fn = sd?.members.find(
      (member): member is Declaration & { kind: "function" } =>
        member.kind === "function" && member.name === method && member.isStatic && !!member.body,
    );
    if (sd && fn) {
      // Param/return types spelled in the owner's scope (const OracleReply&) name its nested structs — substitute them inline so
      const nestedOf = new Map(
        sd.members
          .filter((member): member is StructDecl => member.kind === "struct" && !!member.name)
          .map((structDeclaration) => [structDeclaration.name, structDeclaration]),
      );
      const qual = (tp: TypeSpec): TypeSpec => {
        if (tp.kind === "const") return { ...tp, valueType: qual(tp.valueType) };
        if (tp.kind === "reference") return { ...tp, referentType: qual(tp.referentType) };
        if (tp.kind === "name" && nestedOf.has(tp.name))
          return { kind: "inline_struct", struct: nestedOf.get(tp.name)!, span: tp.span };
        return tp;
      };
      const def: FunctionTemplateDecl = {
        kind: "function_template",
        name: `${sd.name}::${method}`,
        params: [],
        functionParameters: fn.params.map((parameter) => ({ ...parameter, type: qual(parameter.type) })),
        returnType: qual(fn.returnType),
        body: fn.body,
        isConstexpr: fn.isConstexpr,
        span: fn.span,
      };
      info = compileLibraryFunctionInstance(context, def, expression.callArguments);
    }
  }
  return info ?? null;
}

export function emitHelperCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  const info = lookupHelper(context, expression);
  if (!info) return null;

  // An aggregate-returning helper flows as an address — materialize into a slot. In value context return 0
  if (info.retAgg) {
    const addr = emitAggHelperCall(context, expression, info);
    return valueWanted ? "(i64.const 0)" : (void addr, "");
  }

  const helperArgumentOperands = helperCallOps(context, info, expression.callArguments);
  const call = `(call ${info.label}${helperArgumentOperands ? " " + helperArgumentOperands : ""})`;

  if (valueWanted) {
    if (!info.retIsValue) return "(i64.const 0)";
    if (info.retWasmType === "i32") {
      const unsigned = info.retType ? unsignedScalar(context.codeGenerationContext.derefType(info.retType)) : true;
      return `(${unsigned ? "i64.extend_i32_u" : "i64.extend_i32_s"} ${call})`;
    }
    return call;
  }
  context.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
  return "";
}
