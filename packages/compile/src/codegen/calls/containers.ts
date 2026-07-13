import { emitValue } from "../expression-lowering";
import {
  argAddr,
  resolveExpressionAddress,
  emitScalarLoad,
  emitAddress,
  addrIr,
  setLocal,
  allocateScratchSlotNode,
  isSignedScalarType,
} from "../address-resolution";
import { collectFunctionLocals, emitStatement, allocateTemporaryLocalName } from "../statement-emitter";
import { TemplateBindings, CompiledMethod, FieldLayout, FunctionEmissionContext } from "../types";
import { CodeGenerationContext } from "../code-generation-context";
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
import { materializeAssetAddress, materializeSelect } from "./qpi";

// ---- compiling instantiated container methods from the real qpi.h bodies ----

// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32), scalars pass by value (i64).
export function classifyMethodParam(
  codeGenerationContext: CodeGenerationContext,
  parameter: ParamDecl,
  bind: TemplateBindings,
): {
  name: string;
  wasmType: "i32" | "i64";
  isAddr: boolean;
  type: TypeSpec;
  concreteType: TypeSpec;
  defaultValue?: Expression;
  readOnlyRef?: boolean;
} {
  const type = parameter.type;
  const isPtrOrRef = type.kind === "reference" || type.kind === "pointer";
  const readOnlyRef = type.kind === "reference" && type.referentType.kind === "const";
  const deref = codeGenerationContext.derefType(type);
  const concrete = codeGenerationContext.substInBindings(deref, bind);
  const isAddr = isPtrOrRef || codeGenerationContext.isAggregateType(concrete);
  return {
    name: parameter.name,
    wasmType: isAddr ? "i32" : "i64",
    isAddr,
    type: type,
    concreteType: concrete,
    defaultValue: parameter.defaultValue,
    readOnlyRef,
  };
}

// Instantiate (or fetch from cache) a container method from its real qpi.h body, emitting a wasm function. Returns
export function compileContainerMethod(
  codeGenerationContext: CodeGenerationContext,
  type: TypeSpec & { kind: "template_instance" },
  methodName: string,
  argCount?: number,
  paramTypeKey?: string,
  methodArgTypes?: () => Array<TypeSpec | null>,
  explicitTemplateArgs: TypeSpec[] = [],
): CompiledMethod | null {
  const explicitTemplateKey = explicitTemplateArgs.map((argument) => codeGenerationContext.typeKeyOf(argument)).join(",");
  const baseInstanceKey = methodTypeKey(type, codeGenerationContext);
  const explicitTemplateSuffix = explicitTemplateKey ? `<${explicitTemplateKey}>` : "";
  const baseCacheKey = `${baseInstanceKey}::${methodName}/${argCount ?? "?"}${paramTypeKey ? `@${paramTypeKey}` : ""}${explicitTemplateSuffix}`;
  const cachedTemplateMethod = codeGenerationContext.compiledMethods.get(baseCacheKey);
  if (cachedTemplateMethod) return cachedTemplateMethod;

  // Specialization-aware: body + bindings come from matched template instance (primary or partial specialization)
  const mt = codeGenerationContext.methodTemplate(type.name, type.callArguments, methodName, argCount, paramTypeKey);
  if (!mt || !mt.def.body) return null;
  const def = mt.def;
  const resolvedMethodArgTypes = mt.memberTemplate ? (methodArgTypes?.() ?? []) : [];
  const memberTemplateTypeKey = mt.memberTemplate
    ? resolvedMethodArgTypes.map((argumentType) => (argumentType ? codeGenerationContext.typeKeyOf(argumentType) : "?")).join(",")
    : "";
  const cacheKey = `${baseCacheKey}${memberTemplateTypeKey ? `#${memberTemplateTypeKey}` : ""}`;
  const cached = codeGenerationContext.compiledMethods.get(cacheKey);
  if (cached) return cached;
  let bind = mt.bind;
  if (explicitTemplateArgs.length) {
    const types = new Map(bind.types);
    const values = new Map(bind.values);
    def.params.forEach((parameter, index) => {
      const argument = explicitTemplateArgs[index];
      if (!argument) return;
      if (parameter.kind === "type") types.set(parameter.name, argument);
      else values.set(parameter.name, codeGenerationContext.valueOfTypeArg(argument, bind));
    });
    bind = { ...bind, types, values };
  }
  // Infer a member-function template's type parameters from its concrete call arguments. This is
  // deliberately structural: any authoritative `const T&`/`T&` member-template parameter benefits,
  // rather than assigning semantics to Array::setMem or any other method name.
  if (mt.memberTemplate && def.params.some((param) => param.kind === "type")) {
    const types = new Map(bind.types);
    const templateTypeNames = new Set(
      def.params.filter((param) => param.kind === "type").map((param) => param.name),
    );
    for (let index = 0; index < (def.functionParameters ?? []).length; index++) {
      const declared = codeGenerationContext.derefType(def.functionParameters![index].type);
      const actual = resolvedMethodArgTypes[index];
      if (declared.kind === "name" && templateTypeNames.has(declared.name) && actual) {
        types.set(declared.name, actual);
      }
    }
    bind = { ...bind, types };
  }
  const functionParameters = (def.functionParameters ?? []).map((parameter) =>
    classifyMethodParam(codeGenerationContext, parameter, bind),
  );
  const retType = codeGenerationContext.substInBindings(codeGenerationContext.derefType(def.returnType), bind);
  const returnsAddr = def.returnType.kind === "reference" || def.returnType.kind === "pointer";
  const returnsAggregate =
    !returnsAddr && !codeGenerationContext.isVoidType(def.returnType) && codeGenerationContext.isAggregateType(retType);
  const retKind: "i32" | "i64" | "void" = returnsAddr
    ? "i32"
    : codeGenerationContext.isVoidType(def.returnType) || returnsAggregate
      ? "void"
      : "i64";
  const retAgg = returnsAggregate ? codeGenerationContext.sizeOfType(retType, bind) : undefined;

  const safeMethodName = methodName.replace(/[^a-zA-Z0-9_]/g, "_");
  const cm: CompiledMethod = {
    label: `$T${codeGenerationContext.compiledMethods.size}_${type.name}_${safeMethodName}`,
    functionParameters,
    retKind,
    retAgg,
    retType,
  };
  codeGenerationContext.compiledMethods.set(cacheKey, cm); // register before emitting so recursive/sibling calls resolve

  try {
    const warningBase = codeGenerationContext.warnings.length;
    const errorBase = codeGenerationContext.errors.length;
    const wat = emitTemplateMethod(codeGenerationContext, cm, def, type, bind);
    if (codeGenerationContext.warnings.length !== warningBase || codeGenerationContext.errors.length !== errorBase) {
      const diagnostic =
        codeGenerationContext.errors[errorBase]?.message ??
        codeGenerationContext.warnings[warningBase]?.message ??
        "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    codeGenerationContext.emittedMethodOrder.push(wat);
  } catch (entry: any) {
    codeGenerationContext.warn(`failed to compile ${cacheKey}: ${entry.message}`, def.span?.line ?? 0);
    codeGenerationContext.compiledMethods.delete(cacheKey);
    // Once an authoritative method body has been selected, a lowering failure is a
    // compiler error. Returning null here used to let callers substitute handwritten
    throw entry;
  }
  return cm;
}

function methodTypeKey(type: TypeSpec & { kind: "template_instance" }, context: CodeGenerationContext): string {
  const argumentKeys = type.callArguments.map((argument) => context.typeKeyOf(argument)).join(",");
  return `${type.name}<${argumentKeys}>`;
}

// Emit the wasm function for an instantiated container method: param $this + the method's own params, body lowered
export function emitTemplateMethod(
  codeGenerationContext: CodeGenerationContext,
  cm: CompiledMethod,
  def: FunctionTemplateDecl,
  type: TypeSpec & { kind: "template_instance" },
  bind: TemplateBindings,
): string {
  const thisLayout = codeGenerationContext.containerLayout(type.name, type.callArguments);
  const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
  const lookup = codeGenerationContext.namespaceContextOf(def);
  const context: FunctionEmissionContext = {
    codeGenerationContext,
    state: empty,
    in: empty,
    out: empty,
    locals: empty,
    localVars: new Map(),
    lines: [],
    tmpCount: 0,
    loops: [],
    loopCount: 0,
    params: new Map(),
    retIsValue: cm.retKind === "i64",
    retIsAddr: cm.retKind === "i32",
    thisLayout,
    thisType: type,
    thisBind: bind,
    staticConsts: codeGenerationContext.staticConstsOf(type.name, bind),
    sourceNamespace: lookup.sourceNamespace,
    usingNamespaces: lookup.usingNamespaces,
  };
  if (cm.retAgg) {
    context.retAddr = "(local.get $__qinit_ret)";
    context.retAggSize = cm.retAgg;
    context.retType = cm.retType;
  }
  // Register params with their CONCRETE types (ValueT → uint64): a scalar ref-param read sizes and signs its load
  for (const fnParam of cm.functionParameters)
    context.params!.set(fnParam.name, {
      wasmType: fnParam.wasmType,
      isAddr: fnParam.isAddr,
      type: fnParam.concreteType ?? codeGenerationContext.substInBindings(codeGenerationContext.derefType(fnParam.type), bind),
    });

  if (def.body) collectFunctionLocals(def.body, context);
  if (def.body) emitStatement(context, def.body);

  const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
  const paramDecls = cm.functionParameters.map((fnParam) => `(param $${fnParam.name} ${fnParam.wasmType})`).join(" ");
  const result =
    cm.retKind === "i64" ? " (result i64)" : cm.retKind === "i32" ? " (result i32)" : "";
  const header = `  (func ${cm.label} ${retParam}(param $this i32) ${paramDecls}${result}`.replace(
    /\s+\)/,
    ")",
  );
  const localDecls = [...context.localVars.entries()].map(
    ([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`,
  );
  const tail =
    cm.retKind === "i64"
      ? ["    (i64.const 0)"]
      : cm.retKind === "i32"
        ? ["    (i32.const 0)"]
        : [];
  return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}

// Build a call to a container method compiled from its real qpi.h body. Arguments are classified from
export function callCompiled(
  context: FunctionEmissionContext,
  type: TypeSpec & { kind: "template_instance" },
  method: string,
  self: string,
  callArguments: Expression[],
  paramTypeKey?: string,
  explicitTemplateArgs: TypeSpec[] = [],
): { call: string; cm: CompiledMethod; retDest?: string } | null {
  const methodArgTypes = () =>
    callArguments.map((argument) => {
      const node = resolveExpressionAddress(context, argument);
      if (node?.type) return context.codeGenerationContext.derefType(node.type);
      if (argument.kind === "construct") return context.codeGenerationContext.derefType(argument.type);
      if (argument.kind === "call" && argument.callee.kind === "identifier") {
        const type: TypeSpec = { kind: "name", name: argument.callee.name };
        if (context.codeGenerationContext.isAggregateType(type)) return type;
      }
      return null;
    });
  const cm = compileContainerMethod(
    context.codeGenerationContext,
    type,
    method,
    callArguments.length,
    paramTypeKey,
    methodArgTypes,
    explicitTemplateArgs,
  );
  if (!cm) return null;
  const minimumArgs = cm.functionParameters.findIndex((parameter) => parameter.defaultValue !== undefined);
  const minimum = minimumArgs < 0 ? cm.functionParameters.length : minimumArgs;
  if (callArguments.length < minimum || callArguments.length > cm.functionParameters.length) {
    const expected =
      minimum === cm.functionParameters.length ? `${minimum}` : `${minimum}..${cm.functionParameters.length}`;
    throw new Error(`${type.name}::${method} expects ${expected} argument(s), got ${callArguments.length}`);
  }
  const bind = context.codeGenerationContext.bindContainer(type.name, type.callArguments);
  const methodArgumentOperands = cm.functionParameters.map((methodParameter, methodParameterIndex) => {
    const callArgument = callArguments[methodParameterIndex] ?? methodParameter.defaultValue;
    if (!callArgument) {
      throw new Error(`${type.name}::${method} is missing required argument ${methodParameterIndex + 1}`);
    }
    if (callArgument.kind === "nullptr_literal") {
      return methodParameter.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    }
    const paramType = methodParameter.concreteType ??
      context.codeGenerationContext.substInBindings(context.codeGenerationContext.derefType(methodParameter.type), bind);
    if (!methodParameter.isAddr) return emitValue(context, callArgument);
    if (
      methodParameter.type.kind === "pointer" &&
      context.codeGenerationContext.isVoidType(methodParameter.type.pointee) &&
      !resolveExpressionAddress(context, callArgument)
    ) {
      return "(i32.const 0)";
    }
    if (context.codeGenerationContext.isAggregateType(paramType)) {
      if (callArgument.kind === "initializer_list") {
        return argAddr(
          context,
          callArgument,
          context.codeGenerationContext.sizeOfType(paramType, bind),
          paramType,
          methodParameter.readOnlyRef === true,
        );
      }
      const direct = emitAddress(context, callArgument);
      if (!direct)
        throw new Error(`${type.name}::${method} aggregate argument ${methodParameterIndex + 1} is not addressable`);
      return direct;
    }
    return argAddr(
      context,
      callArgument,
      context.codeGenerationContext.sizeOfType(paramType, bind),
      paramType,
      methodParameter.readOnlyRef === true,
    );
  });
  let retDest = "";
  if (cm.retAgg) retDest = watIr.serializeWatNode(allocateScratchSlotNode(context, cm.retAgg));
  return {
    call: `(call ${cm.label}${retDest ? " " + retDest : ""} ${self}${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`,
    cm,
    ...(retDest ? { retDest } : {}),
  };
}

export function emitTemplateContainerCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "template_call" },
  valueWanted: boolean,
): string | null {
  if (expression.callee.kind !== "member_access") return null;
  const node = resolveExpressionAddress(context, expression.callee.object);
  if (!node?.type) return null;
  let type: TypeSpec = node.type;
  if (
    type.kind === "name" &&
    (context.codeGenerationContext.globalStructs.has(type.name) || context.codeGenerationContext.templateMethods.has(type.name))
  ) {
    type = { kind: "template_instance", name: type.name, callArguments: [] };
  }
  if (type.kind !== "template_instance") return null;
  const compiled = callCompiled(
    context,
    type,
    expression.callee.member,
    node.addr,
    expression.callArguments,
    undefined,
    expression.templateArguments ?? [],
  );
  if (!compiled) return null;
  if (valueWanted) {
    if (compiled.retDest || compiled.cm.retKind === "void")
      throw new Error(
        `aggregate or void method ${type.name}::${expression.callee.member} used as a scalar`,
      );
    if (compiled.cm.retKind === "i32")
      return emitScalarLoad(
        compiled.call,
        context.codeGenerationContext.sizeOfType(compiled.cm.retType!),
        isSignedScalarType(compiled.cm.retType!, context.codeGenerationContext),
      );
    return compiled.call;
  }
  context.lines.push(
    compiled.cm.retKind === "void" ? `    ${compiled.call}` : `    (drop ${compiled.call})`,
  );
  return "";
}

// Lower a container method call on a HashMap/HashSet/Array state/locals field. When valueWanted, returns
export function emitContainerCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  if (expression.callee.kind !== "member_access") return null;
  const node = resolveExpressionAddress(context, expression.callee.object);
  if (!node || !node.type) return null;
  // follow typedefs to the concrete container instance (e.g. bit_4096 → BitArray<4096>). Resolve through the
  let ct: TypeSpec | null = node.type;
  for (let index = 0; index < 8 && ct?.kind === "name"; index++) {
    const next: TypeSpec | undefined =
      context.thisBind?.types.get(ct.name) ?? context.codeGenerationContext.typedefs.get(ct.name);
    if (!next) break;
    ct = next;
  }
  // A plain (non-template) struct with an inline method (ProposalDataYesNo::checkValidity) is dispatched as a zero-arg instance — normalize its
  if (
    ct?.kind === "inline_struct" &&
    ct.struct.name &&
    context.codeGenerationContext.templateMethods.get(ct.struct.name)?.has(expression.callee.member)
  ) {
    ct = { kind: "template_instance", name: ct.struct.name, callArguments: [] } as TypeSpec;
  }
  if (
    ct?.kind === "name" &&
    (context.codeGenerationContext.globalStructs.has(ct.name) || context.codeGenerationContext.templateMethods.has(ct.name))
  ) {
    ct = { kind: "template_instance", name: ct.name, callArguments: [] } as TypeSpec;
  }
  if (!ct || ct.kind !== "template_instance") return null;
  // A namespace-qualified spelling (QPI::HashMap<sint64,uint32,16> local) dispatches by its base name — the layout side already strips the qualifier
  if (ct.name.includes("::") && !context.codeGenerationContext.templates.has(ct.name)) {
    ct = { ...ct, name: ct.name.slice(ct.name.lastIndexOf("::") + 2) };
  }
  node.type = ct;

  const map = node.addr;
  const member = expression.callee.member;
  // Any captured instance method goes through the same source-instantiation path.
  // Container family and method names do not carry semantics here: the selected
  const compiled = callCompiled(context, node.type, member, map, expression.callArguments);
  if (!compiled) return null;

  if (valueWanted) {
    if (compiled.retDest) {
      context.lines.push(`    ${compiled.call}`);
      return `(i64.load ${compiled.retDest})`;
    }
    if (compiled.cm.retKind === "void")
      throw new Error(`void method ${node.type.name}::${member} used as a scalar`);
    if (compiled.cm.retKind === "i32") {
      if (!compiled.cm.retType || context.codeGenerationContext.isAggregateType(compiled.cm.retType)) {
        throw new Error(`aggregate reference ${node.type.name}::${member} used as a scalar`);
      }
      return emitScalarLoad(
        compiled.call,
        context.codeGenerationContext.sizeOfType(compiled.cm.retType, context.thisBind),
        isSignedScalarType(compiled.cm.retType, context.codeGenerationContext),
      );
    }
    return compiled.call;
  }

  context.lines.push(
    compiled.cm.retKind === "void" ? `    ${compiled.call}` : `    (drop ${compiled.call})`,
  );
  return "";
}

// Inside a compiled container method: a call to a sibling method of *this (getElementIndex(key)) or the hash functor
export function emitAssetIter(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  mode: "stmt" | "value" | "addr",
): string | null {
  if (expression.callee.kind !== "member_access") return null;
  const node = resolveExpressionAddress(context, expression.callee.object);
  const tn = node?.type?.kind === "name" ? (node.type as any).name : null;
  if (!node || (tn !== "AssetOwnershipIterator" && tn !== "AssetPossessionIterator")) return null;
  const method = expression.callee.member;
  const it = allocateTemporaryLocalName(context);
  context.lines.push(`    ${setLocal(context, it, addrIr(node.addr))}`);
  const itN = watIr.localGet(it, "i32");
  const iter = watIr.serializeWatNode(itN);
  const cursorN = watIr.rawLoad("i32.load", null, watIr.addressWithOffset(itN, 4));
  const count = `(i32.load ${iter})`;
  const cursor = watIr.serializeWatNode(cursorN);
  const record = context.codeGenerationContext.assetEnumerationRecord;
  const rec = `(i32.add (global.get $assetIterBase) (i32.mul ${cursor} (i32.const ${record.size})))`;

  if (method === "begin") {
    const selN = watIr.rawWatNode(materializeSelect(context, undefined), "i32");
    const asset = materializeAssetAddress(context, expression.callArguments[0], `${tn}.begin`);
    const kind = tn === "AssetPossessionIterator" ? 1 : 0;
    const enumerate = watIr.functionCall(
      "$lh_assetEnumerate",
      watIr.i32Constant(kind),
      addrIr(asset),
      selN,
      selN,
      watIr.rawWatNode("(global.get $assetIterBase)", "i32"),
      watIr.i32Constant(record.capacity),
    );
    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, itN, enumerate))}`);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, watIr.addressWithOffset(itN, 4), watIr.i32Constant(0)))}`);
    return "";
  }
  if (method === "next") {
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, watIr.addressWithOffset(itN, 4), watIr.operation("i32.add", cursorN, watIr.i32Constant(1))))}`,
    );
    return "";
  }
  if (method === "reachedEnd") return `(i64.extend_i32_u (i32.ge_u ${cursor} ${count}))`;
  if (method === "numberOfPossessedShares" || method === "numberOfOwnedShares")
    return `(i64.load (i32.add ${rec} (i32.const ${record.fields.shares.offset})))`;
  if (method === "possessor")
    return mode === "addr"
      ? `(i32.add ${rec} (i32.const ${record.fields.possessor.offset}))`
      : `(i64.load (i32.add ${rec} (i32.const ${record.fields.possessor.offset})))`;
  if (method === "owner") return mode === "addr" ? rec : `(i64.load ${rec})`;
  if (method === "ownershipManagingContract")
    return `(i64.extend_i32_u (i32.load16_u (i32.add ${rec} (i32.const ${record.fields.ownershipManagingContract.offset}))))`;
  return null;
}
