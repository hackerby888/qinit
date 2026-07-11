import { emitValue, emitValueIr } from "../value";
import { argAddr, resolveAddr, loadAt, emitAddr, addrIr, setLocal, isAggregate, allocSlot, emitConstruct, storeAt, allocSlotIr, isSignedScalarType } from "../addr";
import { collectLocals, emitStmt, newTmp } from "../stmt";
import { Bindings, CompiledMethod, FieldLayout, FnCtx } from "../types";
import { Codegen } from "../cg";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

// ---- compiling instantiated container methods from the real qpi.h bodies ----

// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32), scalars pass by value (i64).
export function classifyMethodParam(cg: Codegen, p: ParamDecl, bind: Bindings): { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; defaultValue?: Expression } {
  const t = p.type;
  const isPtrOrRef = t.kind === "reference" || t.kind === "pointer";
  const deref = cg.derefType(t);
  const concrete = deref.kind === "name" && bind.types.has(deref.name) ? bind.types.get(deref.name)! : deref;
  const isAddr = isPtrOrRef || cg.isAggregateType(concrete);
  return { name: p.name, wasmType: isAddr ? "i32" : "i64", isAddr, type: t, defaultValue: p.defaultValue };
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
    // behavior or a zero value and made source coverage impossible to ratchet.
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
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (arg.kind === "nullptr_literal") return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), bind)) : emitValue(ctx, arg);
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
  const C = (n: number) => `(i32.const ${n})`;

  if (node.type.name === "HashMap" || node.type.name === "HashSet") {
    // HashMap/HashSet behavior is authoritative only when the real core-lite body lowers. There is
    // deliberately no handwritten probing/cleanup fallback: a compiler gap must fail the build.
    const compiled = callCompiled(
      ctx,
      node.type as TypeSpec & { kind: "template_instance" },
      member,
      map,
      expr.args,
    );
    if (!compiled) {
      throw new Error(`authoritative QPI method ${node.type.name}::${member} could not be lowered`);
    }
    if (valueWanted) {
      if (compiled.cm.retKind === "void") {
        throw new Error(`void QPI method ${node.type.name}::${member} used as a value`);
      }
      if (compiled.cm.retKind === "i32") {
        if (!compiled.cm.retType || ctx.cg.isAggregateType(compiled.cm.retType)) {
          throw new Error(`aggregate QPI reference ${node.type.name}::${member} used as a scalar`);
        }
        return loadAt(compiled.call, ctx.cg.sizeOfType(compiled.cm.retType, ctx.thisBind), isSignedScalarType(compiled.cm.retType, ctx.cg));
      }
      return compiled.call;
    }
    ctx.lines.push(compiled.cm.retKind === "void" ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
    return "";
  }

  if (node.type.name === "Array") {
    const info = ctx.cg.arrayInfo(node.type.args);
    if (!info) return null;
    const mask = info.L - 1;
    const aggr = isAggregate(ctx, info.elemType ?? null, info.elemSize);
    const elemAddr = (idx: Expression) =>
      `(i32.add ${map} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, idx)}) ${C(mask)}) ${C(info.elemSize)}))`;

    if (member === "get" && valueWanted && !aggr) return loadAt(elemAddr(expr.args[0]), info.elemSize);
    if (member === "capacity" && valueWanted) return `(i64.const ${info.L})`;
    if (member === "set" && !valueWanted) {
      const ea = elemAddr(expr.args[0]);
      if (aggr) {
        // A brace-init value (`arr.set(i, { owner, amount })`) has no address — materialize it into a slot via
        let src = emitAddr(ctx, expr.args[1]);
        if (!src && (expr.args[1].kind === "initializer_list" || expr.args[1].kind === "construct") && info.elemType) {
          const vals = expr.args[1].kind === "initializer_list" ? expr.args[1].exprs : expr.args[1].args;
          const s = allocSlot(ctx, info.elemSize);
          if (emitConstruct(ctx, s, info.elemType, vals)) src = s;
        }
        if (!src) {
          ctx.cg.warn(`unsupported Array.set aggregate value`, expr.span.line);
          return "";
        }
        ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ea), addrIr(src), ir.i32c(info.elemSize)))}`);
      } else {
        ctx.lines.push(`    ${storeAt(ea, info.elemSize, emitValue(ctx, expr.args[1]))}`);
      }
      return "";
    }
    if (member === "setAll" && !valueWanted && !aggr) {
      // setAll(v): write v to every element. value scalar only (aggregate setAll is rare).
      const v = emitValueIr(ctx, expr.args[0]);
      const i = newTmp(ctx), val = newTmp(ctx);
      ctx.localVars.set(val, { wasmType: "i64" });
      ctx.lines.push(`    ${setLocal(ctx, val, v)}`);
      ctx.lines.push(`    ${setLocal(ctx, i, ir.i32c(0))}`);
      ctx.lines.push(`    (block $sa_done (loop $sa`);
      ctx.lines.push(`      (br_if $sa_done (i32.ge_u (local.get $${i}) ${C(info.L)}))`);
      ctx.lines.push(`      ${storeAt(`(i32.add ${map} (i32.mul (local.get $${i}) ${C(info.elemSize)}))`, info.elemSize, `(local.get $${val})`)}`);
      ctx.lines.push(`      (local.set $${i} (i32.add (local.get $${i}) (i32.const 1)))`);
      ctx.lines.push(`      (br $sa)))`);
      return "";
    }
  }

  // Collection (priority queues over a per-PoV BST) and LinkedList (doubly-linked with a free list): every method is compiled
  if (node.type.name === "Collection" || node.type.name === "LinkedList") {
    const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
    if (!c) {
      throw new Error(`authoritative QPI method ${node.type.name}::${member} could not be lowered`);
    }
    if (valueWanted) {
      if (c.cm.retKind === "void") {
        throw new Error(`void QPI method ${node.type.name}::${member} used as a value`);
      }
      if (c.cm.retKind === "i32") {
        if (!c.cm.retType || ctx.cg.isAggregateType(c.cm.retType)) {
          throw new Error(`aggregate QPI reference ${node.type.name}::${member} used as a scalar`);
        }
        return loadAt(c.call, ctx.cg.sizeOfType(c.cm.retType, ctx.thisBind), isSignedScalarType(c.cm.retType, ctx.cg));
      }
      return c.call;
    }
    ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
    return "";
  }

  // BitArray<L> (bit_4096 etc.): get/set/setAll/capacity are inline methods compiled from the qpi.h body.
  if (node.type.name === "BitArray" || ctx.cg.templateMethods.get(node.type.name)?.has(member)) {
    const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
    if (!c) return null;
    if (valueWanted) return c.cm.retKind === "void" ? null : c.call;
    ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
    return "";
  }

  return null;
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
  const rec = `(i32.add (global.get $assetIterBase) (i32.mul ${cursor} (i32.const 80)))`;

  if (method === "begin") {
    const selN = allocSlotIr(ctx, 40);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", selN, ir.i32c(40), ir.i32c(0)))}`);   // any-select: anyId + anyMgmt
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, 34), ir.i32c(1)))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(selN, 35), ir.i32c(1)))}`);
    const asset = expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const kind = tn === "AssetPossessionIterator" ? 1 : 0;
    const enumerate = ir.call("$lh_assetEnumerate", ir.i32c(kind), addrIr(asset), selN, selN, ir.raw("(global.get $assetIterBase)", "i32"), ir.i32c(1024));
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, itN, enumerate))}`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.i32c(0)))}`);
    return "";
  }
  if (method === "next") {
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, ir.addr0(itN, 4), ir.op("i32.add", cursorN, ir.i32c(1))))}`);
    return "";
  }
  if (method === "reachedEnd") return `(i64.extend_i32_u (i32.ge_u ${cursor} ${count}))`;
  if (method === "numberOfPossessedShares" || method === "numberOfOwnedShares") return `(i64.load (i32.add ${rec} (i32.const 64)))`;
  if (method === "possessor") return mode === "addr" ? `(i32.add ${rec} (i32.const 32))` : `(i64.load (i32.add ${rec} (i32.const 32)))`;
  if (method === "owner") return mode === "addr" ? rec : `(i64.load ${rec})`;
  if (method === "ownershipManagingContract") return `(i64.extend_i32_u (i32.load16_u (i32.add ${rec} (i32.const 72))))`;
  return null;
}
