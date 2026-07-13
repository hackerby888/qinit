import { collectFunctionLocals, emitStatement } from "../statement-emitter";
import { classifyMethodParam } from "./containers";
import { CodeGenerationContext } from "../code-generation-context";
import { emitValue } from "../expression-lowering";
import { qpiWrapperMethod } from "./dispatch";
import { resolveExpressionAddress, argAddr, allocateScratchSlot } from "../address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS, CompiledMethod, TemplateBindings, FieldLayout } from "../types";
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

export const PROXY_PROCEDURE_METHODS = new Set(["setProposal", "clearProposal", "vote"]);

// Resolve `qpi(X)`'s wrapped object X to a concrete ProposalVoting<P,D> instance + its address.
export function resolveProxyTarget(
  context: FunctionEmissionContext,
  xExpr: Expression,
): { addr: string; pvType: TypeSpec & { kind: "template_instance" } } | null {
  const node = resolveExpressionAddress(context, xExpr);
  if (!node || !node.type) return null;
  let pvt: TypeSpec | null = node.type;
  for (let index = 0; index < 8 && pvt?.kind === "name"; index++) pvt = context.codeGenerationContext.typedefs.get(pvt.name) ?? null;
  if (!pvt || pvt.kind !== "template_instance" || pvt.name !== "ProposalVoting") return null;
  // resolve the ProposalVoting args (ProposersAndVotersT/ProposalDataT contract typedefs) to concrete types
  const callArguments = pvt.callArguments.map((argument) => context.codeGenerationContext.resolveType(argument, EMPTY_TEMPLATE_BINDINGS));
  return {
    addr: node.addr,
    pvType: { kind: "template_instance", name: "ProposalVoting", callArguments, span: pvt.span },
  };
}

// Lower `qpi(X).method(args)` to a call of the real qpi.h proxy method compiled against ProposalVoting<P,D>.
export function emitProposalProxyCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  const method = qpiWrapperMethod(expression);
  if (!method) return null;
  const xExpr = ((expression.callee as any).object as Expression & { kind: "call" }).callArguments[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(context, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method)
    ? "QpiContextProposalProcedureCall"
    : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(context.codeGenerationContext, target.pvType, proxyClass, method);
  if (!cm) return null;
  return callProxy(context, cm, target.addr, target.pvType, expression.callArguments, valueWanted);
}

// `qpi(X).method(args)` whose method returns an aggregate: emit the call writing into a fresh slot and return the slot
export function emitProposalProxyAddr(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): string | null {
  const method = qpiWrapperMethod(expression);
  if (!method) return null;
  const xExpr = (
    (expression.callee as Expression & { kind: "member_access" }).object as Expression & { kind: "call" }
  ).callArguments[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(context, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method)
    ? "QpiContextProposalProcedureCall"
    : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(context.codeGenerationContext, target.pvType, proxyClass, method);
  if (!cm || !cm.retAgg) return null;

  const bind = context.codeGenerationContext.bindContainer(target.pvType.name, target.pvType.callArguments);
  const methodArgumentOperands = cm.functionParameters.map((methodParameter, methodParameterIndex) => {
    const callArgument = expression.callArguments[methodParameterIndex];
    if (!callArgument) return methodParameter.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    const paramType = context.codeGenerationContext.substInBindings(
      context.codeGenerationContext.derefType(methodParameter.type),
      bind,
    );
    return methodParameter.isAddr
      ? argAddr(
          context,
          callArgument,
          context.codeGenerationContext.sizeOfType(paramType, bind),
          paramType,
          methodParameter.readOnlyRef === true,
        )
      : emitValue(context, callArgument);
  });
  const scratchAddress = allocateScratchSlot(context, cm.retAgg!);
  context.lines.push(
    `    (call ${cm.label} ${scratchAddress} ${target.addr} (i32.const 0)${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`,
  );
  return scratchAddress;
}

// A bare sibling call inside a proxy body (e.g. clearProposal(idx) from setProposal) — compile it against
export function emitProxySiblingCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  if (!context.proxyClass || expression.callee.kind !== "identifier") return null;
  const method = expression.callee.name;
  const known =
    context.codeGenerationContext.templateMethods.get(context.proxyClass)?.has(method) ||
    context.codeGenerationContext.templateMethods.get("QpiContextProposalFunctionCall")?.has(method);
  if (!known) return null;
  const pvType = context.refLocals?.get("pv");
  if (!pvType || pvType.kind !== "template_instance") return null;
  const cm = compileProxyMethod(context.codeGenerationContext, pvType, context.proxyClass, method);
  if (!cm) return null;
  return callProxy(context, cm, "(local.get $pv)", pvType, expression.callArguments, valueWanted);
}

// Emit the actual `(call $PV…)`: self = the ProposalVoting address, then the dummy qpi context, then the method's
export function callProxy(
  context: FunctionEmissionContext,
  cm: CompiledMethod,
  self: string,
  pvType: TypeSpec & { kind: "template_instance" },
  callArguments: Expression[],
  valueWanted: boolean,
): string {
  const bind = context.codeGenerationContext.bindContainer(pvType.name, pvType.callArguments);
  const methodArgumentOperands = cm.functionParameters.map((methodParameter, methodParameterIndex) => {
    const callArgument = callArguments[methodParameterIndex];
    if (!callArgument) return methodParameter.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    const paramType = context.codeGenerationContext.substInBindings(
      context.codeGenerationContext.derefType(methodParameter.type),
      bind,
    );
    return methodParameter.isAddr
      ? argAddr(
          context,
          callArgument,
          context.codeGenerationContext.sizeOfType(paramType, bind),
          paramType,
          methodParameter.readOnlyRef === true,
        )
      : emitValue(context, callArgument);
  });

  // An aggregate-returning proxy method (proposerId → id) writes through a leading $ret slot. The
  if (cm.retAgg) {
    const scratchAddress = allocateScratchSlot(context, cm.retAgg);
    context.lines.push(
      `    (call ${cm.label} ${scratchAddress} ${self} (i32.const 0)${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`,
    );
    if (!valueWanted) return "";
    throw new Error("aggregate proposal method return used as a scalar");
  }

  const call = `(call ${cm.label} ${self} (i32.const 0)${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`;
  if (valueWanted) {
    if (cm.retKind !== "i64") throw new Error("void proposal method used as a value");
    return call;
  }
  context.lines.push(
    cm.retKind === "i64"
      ? `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.rawWatNode(call, "i64", "unconverted: proxy method call")))}`
      : `    ${call}`,
  );
  return "";
}

// Instantiate (or fetch) a ProposalVoting proxy method from its real qpi.h body, emitting a wasm function `(func $PV…
export function compileProxyMethod(
  codeGenerationContext: CodeGenerationContext,
  pvType: TypeSpec & { kind: "template_instance" },
  proxyClass: string,
  method: string,
): CompiledMethod | null {
  let def = codeGenerationContext.templateMethods.get(proxyClass)?.get(method);
  if (!def) def = codeGenerationContext.templateMethods.get("QpiContextProposalFunctionCall")?.get(method); // FunctionCall base
  if (!def || !def.body) return null;

  const [proposalHandlingType, proposalDataType] = pvType.callArguments;
  const cacheKey = `proxy:${proxyClass}<${codeGenerationContext.typeKeyOf(proposalHandlingType)},${codeGenerationContext.typeKeyOf(proposalDataType)}>::${method}`;
  const cached = codeGenerationContext.compiledMethods.get(cacheKey);
  if (cached) return cached;

  const bind: TemplateBindings = {
    types: new Map([
      ["ProposerAndVoterHandlingType", proposalHandlingType],
      ["ProposalDataType", proposalDataType],
    ]),
    values: new Map(),
    structs: new Map(),
  };
  const functionParameters = (def.functionParameters ?? []).map((parameter) => classifyMethodParam(codeGenerationContext, parameter, bind));
  const retT = codeGenerationContext.substInBindings(codeGenerationContext.derefType(def.returnType), bind);
  const isAggRet = !codeGenerationContext.isVoidType(def.returnType) && codeGenerationContext.isAggregateType(retT);
  const retKind: "i64" | "void" = codeGenerationContext.isVoidType(def.returnType) || isAggRet ? "void" : "i64";
  const retAgg = isAggRet ? codeGenerationContext.sizeOfType(retT, bind) : undefined;

  const cm: CompiledMethod = {
    label: `$PV${codeGenerationContext.compiledMethods.size}_${proxyClass}_${method}`,
    functionParameters,
    retKind,
    retAgg,
    retType: retT,
  };
  codeGenerationContext.compiledMethods.set(cacheKey, cm); // register before emitting so recursive/sibling calls resolve
  try {
    codeGenerationContext.emittedMethodOrder.push(emitProxyMethodFn(codeGenerationContext, cm, def, pvType, bind, proxyClass));
  } catch (entry: any) {
    codeGenerationContext.warn(`failed to compile proxy ${cacheKey}: ${entry.message}`, def.span?.line ?? 0);
    codeGenerationContext.compiledMethods.delete(cacheKey);
    throw entry;
  }
  return cm;
}

export function emitProxyMethodFn(
  codeGenerationContext: CodeGenerationContext,
  cm: CompiledMethod,
  def: FunctionTemplateDecl,
  pvType: TypeSpec & { kind: "template_instance" },
  bind: TemplateBindings,
  proxyClass: string,
): string {
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
    thisBind: bind,
    proxyClass,
    sourceNamespace: lookup.sourceNamespace,
    usingNamespaces: lookup.usingNamespaces,
    refLocals: new Map([["pv", pvType as TypeSpec]]), // `pv` (member) → the wrapped ProposalVoting at $pv
  };
  if (cm.retAgg) {
    context.retAddr = "(local.get $__qinit_ret)";
    context.retAggSize = cm.retAgg;
    context.retType = cm.retType;
  }
  // `qpi` (member) is a dummy address param; qpi.method() routes to the ambient host context.
  context.params!.set("qpi", {
    wasmType: "i32",
    isAddr: true,
    type: { kind: "name", name: "QpiContextFunctionCall" },
  });
  for (const fnParam of cm.functionParameters)
    context.params!.set(fnParam.name, {
      wasmType: fnParam.wasmType,
      isAddr: fnParam.isAddr,
      type: codeGenerationContext.substInBindings(codeGenerationContext.derefType(fnParam.type), bind),
    });

  if (def.body) collectFunctionLocals(def.body, context);
  if (def.body) emitStatement(context, def.body);

  const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
  const paramDecls = cm.functionParameters.map((fnParam) => `(param $${fnParam.name} ${fnParam.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : "";
  const header =
    `  (func ${cm.label} ${retParam}(param $pv i32) (param $qpi i32) ${paramDecls}${result}`.replace(
      /\s+\)/,
      ")",
    );
  const localDecls = [...context.localVars.entries()].map(
    ([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`,
  );
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}
