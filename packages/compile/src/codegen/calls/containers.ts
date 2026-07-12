import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import { emitValue } from "../value";
import { argAddr, resolveAddr, loadAt, emitAddr, addrIr, setLocal, allocSlotIr, isSignedScalarType } from "../addr";
import { collectLocals, emitStmt, newTmp } from "../stmt";
import { Bindings, CompiledMethod, FieldLayout, FnCtx } from "../types";
import { Codegen } from "../cg";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";
import { materializeAssetAddress, QPI_AGGREGATE_LAYOUTS, QPI_BINDINGS } from "./qpi";

// ---- compiling instantiated container methods from the real qpi.h bodies ----

// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32), scalars pass by value (i64).
export function classifyMethodParam(cg: Codegen, p: ParamDecl, bind: Bindings): { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; defaultValue?: Expression; readOnlyRef?: boolean } {
  const t = p.type;
  const isPtrOrRef = t.kind === "reference" || t.kind === "pointer";
  const readOnlyRef = t.kind === "reference" && t.refereed.kind === "const";
  const deref = cg.derefType(t);
  const concrete = deref.kind === "name" && bind.types.has(deref.name) ? bind.types.get(deref.name)! : deref;
  const isAddr = isPtrOrRef || cg.isAggregateType(concrete);
  return { name: p.name, wasmType: isAddr ? "i32" : "i64", isAddr, type: t, defaultValue: p.defaultValue, readOnlyRef };
}

// Instantiate (or fetch from cache) a container method from its real qpi.h body, emitting a wasm function. Returns
export function compileContainerMethod(cg: Codegen, type: TypeSpec & { kind: "template_instance" }, methodName: string, argCount?: number, paramTypeKey?: string): CompiledMethod | null {
  const cacheKey = `${type.name}<${type.args.map((a) => cg.typeKeyOf(a)).join(",")}>::${methodName}/${argCount ?? "?"}${paramTypeKey ? `@${paramTypeKey}` : ""}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  // Specialization-aware: the body + its binding come from the matched template instance (primary OR partial specialization), so a
  const mt = cg.methodTemplate(type.name, type.args, methodName, argCount, paramTypeKey);
  if (!mt || !mt.def.body) return null;
  const def = mt.def;
  const bind = mt.bind;
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retType = cg.substInBindings(cg.derefType(def.returnType), bind);
  const returnsAddr = def.returnType.kind === "reference" || def.returnType.kind === "pointer";
  const returnsAggregate = !returnsAddr && !cg.isVoidType(def.returnType) && cg.isAggregateType(retType);
  const retKind: "i32" | "i64" | "void" = returnsAddr ? "i32" : (cg.isVoidType(def.returnType) || returnsAggregate ? "void" : "i64");
  const retAgg = returnsAggregate ? cg.sizeOfType(retType, bind) : undefined;

  const safeMethodName = methodName.replace(/[^a-zA-Z0-9_]/g, "_");
  const cm: CompiledMethod = { label: `$T${cg.compiledMethods.size}_${type.name}_${safeMethodName}`, fnParams, retKind, retAgg, retType };
  cg.compiledMethods.set(cacheKey, cm);   // register before emitting so recursive/sibling calls resolve

  try {
    const warningBase = cg.warnings.length;
    const errorBase = cg.errors.length;
    const wat = emitTemplateMethod(cg, cm, def, type, bind);
    if (cg.warnings.length !== warningBase || cg.errors.length !== errorBase) {
      const diagnostic = cg.errors[errorBase]?.message ?? cg.warnings[warningBase]?.message ?? "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    cg.emittedMethodOrder.push(wat);
  } catch (e: any) {
    cg.warn(`failed to compile ${cacheKey}: ${e.message}`, def.span?.line ?? 0);
    cg.compiledMethods.delete(cacheKey);
    // Once an authoritative method body has been selected, a lowering failure is a
    // compiler error. Returning null here used to let callers substitute handwritten
    throw e;
  }
  return cm;
}

// Emit the wasm function for an instantiated container method: param $this + the method's own params, body lowered
export function emitTemplateMethod(cg: Codegen, cm: CompiledMethod, def: FunctionTemplateDecl, type: TypeSpec & { kind: "template_instance" }, bind: Bindings): string {
  const thisLayout = cg.containerLayout(type.name, type.args);
  const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
  const ctx: FnCtx = {
    cg, state: empty, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: cm.retKind === "i64", retIsAddr: cm.retKind === "i32",
    thisLayout, thisType: type, thisBind: bind, staticConsts: cg.staticConstsOf(type.name, bind),
  };
  if (cm.retAgg) {
    ctx.retAddr = "(local.get $__qinit_ret)";
    ctx.retAggSize = cm.retAgg;
    ctx.retType = cm.retType;
  }
  // Register params with their CONCRETE types (ValueT → uint64): a scalar ref-param read sizes and signs its load
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.substInBindings(cg.derefType(p.type), bind) });

  if (def.body) collectLocals(def.body, ctx);
  if (def.body) emitStmt(ctx, def.body);

  const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
  const paramDecls = cm.fnParams.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : cm.retKind === "i32" ? " (result i32)" : "";
  const header = `  (func ${cm.label} ${retParam}(param $this i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : cm.retKind === "i32" ? ["    (i32.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}

// Build a call to a container method compiled from its real qpi.h body. Arguments are classified from
export function callCompiled(
  ctx: FnCtx, type: TypeSpec & { kind: "template_instance" }, method: string, self: string, args: Expression[], paramTypeKey?: string,
): { call: string; cm: CompiledMethod; retDest?: string } | null {
  const cm = compileContainerMethod(ctx.cg, type, method, args.length, paramTypeKey);
  if (!cm) return null;
  const bind = ctx.cg.bindContainer(type.name, type.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = args[i] ?? fp.defaultValue;
    if (!arg) throw new Error(`${type.name}::${method} is missing required argument ${i + 1}`);
    if (arg.kind === "nullptr_literal") return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    const paramType = ctx.cg.substInBindings(ctx.cg.derefType(fp.type), bind);
    return fp.isAddr
      ? argAddr(ctx, arg, ctx.cg.sizeOfType(paramType, bind), paramType, fp.readOnlyRef === true)
      : emitValue(ctx, arg);
  });
  let retDest = "";
  if (cm.retAgg) retDest = ir.emit(allocSlotIr(ctx, cm.retAgg));
  return {
    call: `(call ${cm.label}${retDest ? " " + retDest : ""} ${self}${ops.length ? " " + ops.join(" ") : ""})`,
    cm,
    ...(retDest ? { retDest } : {}),
  };
}

// Lower a container method call on a HashMap/HashSet/Array state/locals field. When valueWanted, returns
export function emitContainerCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || !node.type) return null;
  // follow typedefs to the concrete container instance (e.g. bit_4096 → BitArray<4096>). Resolve through the
  let ct: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && ct?.kind === "name"; i++) {
    const next: TypeSpec | undefined = ctx.thisBind?.types.get(ct.name) ?? ctx.cg.typedefs.get(ct.name);
    if (!next) break;
    ct = next;
  }
  // A plain (non-template) struct with an inline method (ProposalDataYesNo::checkValidity) is dispatched as a zero-arg instance — normalize its
  if (ct?.kind === "inline_struct" && ct.struct.name && ctx.cg.templateMethods.get(ct.struct.name)?.has(expr.callee.member)) {
    ct = { kind: "template_instance", name: ct.struct.name, args: [] } as TypeSpec;
  }
  if (ct?.kind === "name" && ctx.cg.templateMethods.get(ct.name)?.has(expr.callee.member)) {
    ct = { kind: "template_instance", name: ct.name, args: [] } as TypeSpec;
  }
  if (!ct || ct.kind !== "template_instance") return null;
  // A namespace-qualified spelling (QPI::HashMap<sint64,uint32,16> local) dispatches by its base name — the layout side already strips the qualifier
  if (ct.name.includes("::") && !ctx.cg.templates.has(ct.name)) {
    ct = { ...ct, name: ct.name.slice(ct.name.lastIndexOf("::") + 2) };
  }
  node.type = ct;

  const map = node.addr;
  const member = expr.callee.member;
  // Any captured instance method goes through the same source-instantiation path.
  // Container family and method names do not carry semantics here: the selected
  if (!ctx.cg.templateMethods.get(node.type.name)?.has(member)) return null;
  const compiled = callCompiled(ctx, node.type, member, map, expr.args);
  if (!compiled) throw new Error(`authoritative method ${node.type.name}::${member} could not be lowered`);

  if (valueWanted) {
    if (compiled.retDest || compiled.cm.retKind === "void") {
      throw new Error(`aggregate or void method ${node.type.name}::${member} used as a scalar`);
    }
    if (compiled.cm.retKind === "i32") {
      if (!compiled.cm.retType || ctx.cg.isAggregateType(compiled.cm.retType)) {
        throw new Error(`aggregate reference ${node.type.name}::${member} used as a scalar`);
      }
      return loadAt(
        compiled.call,
        ctx.cg.sizeOfType(compiled.cm.retType, ctx.thisBind),
        isSignedScalarType(compiled.cm.retType, ctx.cg),
      );
    }
    return compiled.call;
  }

  ctx.lines.push(compiled.cm.retKind === "void" ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
  return "";
}

// Inside a compiled container method: a call to a sibling method of *this (getElementIndex(key)) or the hash functor
export function emitAssetIter(ctx: FnCtx, expr: Expression & { kind: "call" }, mode: "stmt" | "value" | "addr"): string | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  const tn = node?.type?.kind === "name" ? (node.type as any).name : null;
  if (!node || (tn !== "AssetOwnershipIterator" && tn !== "AssetPossessionIterator")) return null;
  const method = expr.callee.member;
  const it = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, it, addrIr(node.addr))}`);
  const itN = ir.getL(it, "i32");
  const iter = ir.emit(itN);
  const cursorN = ir.loadRaw("i32.load", null, ir.addr0(itN, 4));
  const count = `(i32.load ${iter})`;
  const cursor = ir.emit(cursorN);
  const record = ASSET_ENUMERATION_RECORD;
  const rec = `(i32.add (global.get $assetIterBase) (i32.mul ${cursor} (i32.const ${record.size})))`;

  if (method === "begin") {
    const selector = QPI_AGGREGATE_LAYOUTS.AssetSelect;
    const selN = allocSlotIr(ctx, selector.size);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", selN, ir.i32c(selector.size), ir.i32c(0)))}`);   // any-select: anyId + anyMgmt
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, selector.fields.anyId), ir.i32c(1)))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, selector.fields.anyManagingContract), ir.i32c(1)))}`);
    const asset = materializeAssetAddress(ctx, expr.args[0], `${tn}.begin`);
    const kind = tn === "AssetPossessionIterator" ? 1 : 0;
    const enumerate = ir.call(QPI_BINDINGS.__assetEnumerate.fwd, ir.i32c(kind), addrIr(asset), selN, selN, ir.raw("(global.get $assetIterBase)", "i32"), ir.i32c(record.capacity));
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, itN, enumerate))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.i32c(0)))}`);
    return "";
  }
  if (method === "next") {
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.op("i32.add", cursorN, ir.i32c(1))))}`);
    return "";
  }
  if (method === "reachedEnd") return `(i64.extend_i32_u (i32.ge_u ${cursor} ${count}))`;
  if (method === "numberOfPossessedShares" || method === "numberOfOwnedShares") return `(i64.load (i32.add ${rec} (i32.const ${record.fields.shares.offset})))`;
  if (method === "possessor") return mode === "addr" ? `(i32.add ${rec} (i32.const ${record.fields.possessor.offset}))` : `(i64.load (i32.add ${rec} (i32.const ${record.fields.possessor.offset})))`;
  if (method === "owner") return mode === "addr" ? rec : `(i64.load ${rec})`;
  if (method === "ownershipManagingContract") return `(i64.extend_i32_u (i32.load16_u (i32.add ${rec} (i32.const ${record.fields.ownershipManagingContract.offset}))))`;
  return null;
}
