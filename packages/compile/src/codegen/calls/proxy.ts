import { collectLocals, emitStmt } from "../stmt";
import { classifyMethodParam } from "./containers";
import { Codegen } from "../cg";
import { emitValue } from "../value";
import { qpiWrapperMethod } from "./dispatch";
import { resolveAddr, argAddr, allocSlot } from "../addr";
import { FnCtx, NO_BIND, CompiledMethod, Bindings, FieldLayout } from "../types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

export const PROXY_PROCEDURE_METHODS = new Set(["setProposal", "clearProposal", "vote"]);

// Resolve `qpi(X)`'s wrapped object X to a concrete ProposalVoting<P,D> instance + its address.
export function resolveProxyTarget(ctx: FnCtx, xExpr: Expression): { addr: string; pvType: TypeSpec & { kind: "template_instance" } } | null {
  const node = resolveAddr(ctx, xExpr);
  if (!node || !node.type) return null;
  let pvt: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && pvt?.kind === "name"; i++) pvt = ctx.cg.typedefs.get(pvt.name) ?? null;
  if (!pvt || pvt.kind !== "template_instance" || pvt.name !== "ProposalVoting") return null;
  // resolve the ProposalVoting args (ProposersAndVotersT/ProposalDataT contract typedefs) to concrete types
  const args = pvt.args.map((a) => ctx.cg.resolveType(a, NO_BIND));
  return { addr: node.addr, pvType: { kind: "template_instance", name: "ProposalVoting", args, span: pvt.span } };
}

// Lower `qpi(X).method(args)` to a call of the real qpi.h proxy method compiled against ProposalVoting<P,D>.
export function emitProposalProxyCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  const method = qpiWrapperMethod(expr);
  if (!method) return null;
  const xExpr = ((expr.callee as any).object as Expression & { kind: "call" }).args[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(ctx, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method) ? "QpiContextProposalProcedureCall" : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(ctx.cg, target.pvType, proxyClass, method);
  if (!cm) return null;
  return callProxy(ctx, cm, target.addr, target.pvType, expr.args, valueWanted);
}

// `qpi(X).method(args)` whose method returns an aggregate: emit the call writing into a fresh slot and return the slot
export function emitProposalProxyAddr(ctx: FnCtx, expr: Expression & { kind: "call" }): string | null {
  const method = qpiWrapperMethod(expr);
  if (!method) return null;
  const xExpr = ((expr.callee as Expression & { kind: "member_access" }).object as Expression & { kind: "call" }).args[0];
  if (!xExpr) return null;
  const target = resolveProxyTarget(ctx, xExpr);
  if (!target) return null;

  const proxyClass = PROXY_PROCEDURE_METHODS.has(method) ? "QpiContextProposalProcedureCall" : "QpiContextProposalFunctionCall";
  const cm = compileProxyMethod(ctx.cg, target.pvType, proxyClass, method);
  if (!cm || !cm.retAgg) return null;

  const bind = ctx.cg.bindContainer(target.pvType.name, target.pvType.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    const paramType = ctx.cg.substInBindings(ctx.cg.derefType(fp.type), bind);
    return fp.isAddr
      ? argAddr(ctx, arg, ctx.cg.sizeOfType(paramType, bind), paramType, fp.readOnlyRef === true)
      : emitValue(ctx, arg);
  });
  const s = allocSlot(ctx, cm.retAgg!);
  ctx.lines.push(`    (call ${cm.label} ${s} ${target.addr} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`);
  return s;
}

// A bare sibling call inside a proxy body (e.g. clearProposal(idx) from setProposal) — compile it against
export function emitProxySiblingCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.proxyClass || expr.callee.kind !== "identifier") return null;
  const method = expr.callee.name;
  const known = ctx.cg.templateMethods.get(ctx.proxyClass)?.has(method) || ctx.cg.templateMethods.get("QpiContextProposalFunctionCall")?.has(method);
  if (!known) return null;
  const pvType = ctx.refLocals?.get("pv");
  if (!pvType || pvType.kind !== "template_instance") return null;
  const cm = compileProxyMethod(ctx.cg, pvType, ctx.proxyClass, method);
  if (!cm) return null;
  return callProxy(ctx, cm, "(local.get $pv)", pvType, expr.args, valueWanted);
}

// Emit the actual `(call $PV…)`: self = the ProposalVoting address, then the dummy qpi context, then the method's
export function callProxy(ctx: FnCtx, cm: CompiledMethod, self: string, pvType: TypeSpec & { kind: "template_instance" }, args: Expression[], valueWanted: boolean): string {
  const bind = ctx.cg.bindContainer(pvType.name, pvType.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    const paramType = ctx.cg.substInBindings(ctx.cg.derefType(fp.type), bind);
    return fp.isAddr
      ? argAddr(ctx, arg, ctx.cg.sizeOfType(paramType, bind), paramType, fp.readOnlyRef === true)
      : emitValue(ctx, arg);
  });

  // An aggregate-returning proxy method (proposerId → id) writes through a leading $ret slot. The
  if (cm.retAgg) {
    const s = allocSlot(ctx, cm.retAgg);
    ctx.lines.push(`    (call ${cm.label} ${s} ${self} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`);
    if (!valueWanted) return "";
    throw new Error("aggregate proposal method return used as a scalar");
  }

  const call = `(call ${cm.label} ${self} (i32.const 0)${ops.length ? " " + ops.join(" ") : ""})`;
  if (valueWanted) {
    if (cm.retKind !== "i64") throw new Error("void proposal method used as a value");
    return call;
  }
  ctx.lines.push(cm.retKind === "i64" ? `    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: proxy method call")))}` : `    ${call}`);
  return "";
}

// Instantiate (or fetch) a ProposalVoting proxy method from its real qpi.h body, emitting a wasm function `(func $PV…
export function compileProxyMethod(cg: Codegen, pvType: TypeSpec & { kind: "template_instance" }, proxyClass: string, method: string): CompiledMethod | null {
  let def = cg.templateMethods.get(proxyClass)?.get(method);
  if (!def) def = cg.templateMethods.get("QpiContextProposalFunctionCall")?.get(method);   // FunctionCall base
  if (!def || !def.body) return null;

  const P = pvType.args[0], D = pvType.args[1];
  const cacheKey = `proxy:${proxyClass}<${cg.typeKeyOf(P)},${cg.typeKeyOf(D)}>::${method}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  const bind: Bindings = { types: new Map([["ProposerAndVoterHandlingType", P], ["ProposalDataType", D]]), values: new Map(), structs: new Map() };
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retT = cg.substInBindings(cg.derefType(def.returnType), bind);
  const isAggRet = !cg.isVoidType(def.returnType) && cg.isAggregateType(retT);
  const retKind: "i64" | "void" = cg.isVoidType(def.returnType) || isAggRet ? "void" : "i64";
  const retAgg = isAggRet ? cg.sizeOfType(retT, bind) : undefined;

  const cm: CompiledMethod = { label: `$PV${cg.compiledMethods.size}_${proxyClass}_${method}`, fnParams, retKind, retAgg, retType: retT };
  cg.compiledMethods.set(cacheKey, cm);   // register before emitting so recursive/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitProxyMethodFn(cg, cm, def, pvType, bind, proxyClass));
  } catch (e: any) {
    cg.warn(`failed to compile proxy ${cacheKey}: ${e.message}`, def.span?.line ?? 0);
    cg.compiledMethods.delete(cacheKey);
    throw e;
  }
  return cm;
}

export function emitProxyMethodFn(cg: Codegen, cm: CompiledMethod, def: FunctionTemplateDecl, pvType: TypeSpec & { kind: "template_instance" }, bind: Bindings, proxyClass: string): string {
  const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
  const lookup = cg.namespaceContextOf(def);
  const ctx: FnCtx = {
    cg, state: empty, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: cm.retKind === "i64",
    thisBind: bind, proxyClass,
    sourceNamespace: lookup.sourceNamespace, usingNamespaces: lookup.usingNamespaces,
    refLocals: new Map([["pv", pvType as TypeSpec]]),   // `pv` (member) → the wrapped ProposalVoting at $pv
  };
  if (cm.retAgg) {
    ctx.retAddr = "(local.get $__qinit_ret)";
    ctx.retAggSize = cm.retAgg;
    ctx.retType = cm.retType;
  }
  // `qpi` (member) is a dummy address param; qpi.method() routes to the ambient host context.
  ctx.params!.set("qpi", { wasmType: "i32", isAddr: true, type: { kind: "name", name: "QpiContextFunctionCall" } });
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.substInBindings(cg.derefType(p.type), bind) });

  if (def.body) collectLocals(def.body, ctx);
  if (def.body) emitStmt(ctx, def.body);

  const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
  const paramDecls = cm.fnParams.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : "";
  const header = `  (func ${cm.label} ${retParam}(param $pv i32) (param $qpi i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}
