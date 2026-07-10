import { emitValue, emitValueIr } from "../value";
import { argAddr, resolveAddr, loadAt, emitAddr, addrIr, setLocal, isAggregate, allocSlot, emitConstruct, storeAt, allocSlotIr } from "../addr";
import { collectLocals, emitStmt, newTmp } from "../stmt";
import { Bindings, CompiledMethod, FieldLayout, FnCtx } from "../types";
import { Codegen } from "../cg";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

// ---- compiling instantiated container methods from the real qpi.h bodies ----

// A method parameter's wasm calling convention: references/pointers and aggregates pass by address (i32), scalars pass by value (i64).
export function classifyMethodParam(cg: Codegen, p: ParamDecl, bind: Bindings): { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec } {
  const t = p.type;
  const isPtrOrRef = t.kind === "reference" || t.kind === "pointer";
  const deref = cg.derefType(t);
  const concrete = deref.kind === "name" && bind.types.has(deref.name) ? bind.types.get(deref.name)! : deref;
  const isAddr = isPtrOrRef || cg.isAggregateType(concrete);
  return { name: p.name, wasmType: isAddr ? "i32" : "i64", isAddr, type: t };
}

// Instantiate (or fetch from cache) a container method from its real qpi.h body, emitting a wasm function. Returns
export function compileContainerMethod(cg: Codegen, type: TypeSpec & { kind: "template_instance" }, methodName: string, argCount?: number): CompiledMethod | null {
  const cacheKey = `${type.name}<${type.args.map((a) => cg.typeKeyOf(a)).join(",")}>::${methodName}/${argCount ?? "?"}`;
  const cached = cg.compiledMethods.get(cacheKey);
  if (cached) return cached;

  // Specialization-aware: the body + its binding come from the matched template instance (primary OR partial specialization), so a
  const mt = cg.methodTemplate(type.name, type.args, methodName, argCount);
  if (!mt || !mt.def.body) return null;
  const def = mt.def;
  const bind = mt.bind;
  const fnParams = (def.fnParams ?? []).map((p) => classifyMethodParam(cg, p, bind));
  const retKind: "i64" | "void" = cg.isVoidType(def.returnType) ? "void" : (cg.isAggregateType(cg.derefType(def.returnType)) ? "void" : "i64");

  const cm: CompiledMethod = { label: `$T${cg.compiledMethods.size}_${type.name}_${methodName}`, fnParams, retKind };
  cg.compiledMethods.set(cacheKey, cm);   // register before emitting so recursive/sibling calls resolve

  try {
    cg.emittedMethodOrder.push(emitTemplateMethod(cg, cm, def, type, bind));
  } catch (e: any) {
    cg.warn(`failed to compile ${cacheKey}: ${e.message}`, def.span?.line ?? 0);
    cg.compiledMethods.delete(cacheKey);
    return null;
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
    params: new Map(), retIsValue: cm.retKind === "i64",
    thisLayout, thisType: type, thisBind: bind, staticConsts: cg.staticConstsOf(type.name, bind),
  };
  // Register params with their CONCRETE types (ValueT → uint64): a scalar ref-param read sizes and signs its load
  for (const p of cm.fnParams) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: cg.substInBindings(cg.derefType(p.type), bind) });

  if (def.body) collectLocals(def.body, ctx);
  if (def.body) emitStmt(ctx, def.body);

  const paramDecls = cm.fnParams.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = cm.retKind === "i64" ? " (result i64)" : "";
  const header = `  (func ${cm.label} (param $this i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  const tail = cm.retKind === "i64" ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}

// Build a call to a container method compiled from its real qpi.h body. Arguments are classified from
export function callCompiled(
  ctx: FnCtx, type: TypeSpec & { kind: "template_instance" }, method: string, self: string, args: Expression[],
): { call: string; cm: CompiledMethod } | null {
  const cm = compileContainerMethod(ctx.cg, type, method, args.length);
  if (!cm) return null;
  const bind = ctx.cg.bindContainer(type.name, type.args);
  const ops = cm.fnParams.map((fp, i) => {
    const arg = args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return fp.isAddr ? argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), bind)) : emitValue(ctx, arg);
  });
  return { call: `(call ${cm.label} ${self}${ops.length ? " " + ops.join(" ") : ""})`, cm };
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
    const isSet = node.type.name === "HashSet";
    const info = isSet ? ctx.cg.hashsetInfo(node.type.args) : ctx.cg.hashmapInfo(node.type.args);
    if (!info) return null;
    const dims = `${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.valOff!)} ${C(info.valSize!)} ${C(info.occBase!)}`;
    const indexOf = (k: string) => `(call $hm_index ${map} ${k} ${C(info.L!)} ${C(info.elemSize)} ${C(info.keySize!)} ${C(info.occBase!)} ${C(info.hashMode!)})`;
    const elemAt = (idx: Expression) => `(call $hm_elem ${map} (i32.and (i32.wrap_i64 ${emitValue(ctx, idx)}) ${C(info.L! - 1)}) ${C(info.elemSize)})`;

    // Prefer the method compiled from the real qpi.h body (HashMap and HashSet share the same impl shape); the
    const compiledHM = (m: string) => callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, m, map, expr.args);
    // Wire a compiled HashMap method that returns a value (or void): in value context return the call; as
    const wireCompiled = (m: string): boolean => {
      const c = compiledHM(m);
      if (!c) return false;
      if (valueWanted) { lastWired = c.call; return true; }
      ctx.lines.push(c.cm.retKind === "void" ? `    ${c.call}` : `    (drop ${c.call})`);
      lastWired = "";
      return true;
    };
    let lastWired = "";

    // queries (value context)
    if (member === "population" && valueWanted) return wireCompiled("population") ? lastWired : `(call $hm_population ${map} ${C(info.popOff!)})`;
    if (member === "capacity" && valueWanted) return `(i64.const ${info.L})`;
    if (member === "contains" && valueWanted) {
      if (wireCompiled("contains")) return lastWired;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      return `(i64.extend_i32_u (i32.ne ${indexOf(k)} (i32.const -1)))`;
    }
    if (member === "getElementIndex" && valueWanted) {
      if (wireCompiled("getElementIndex")) return lastWired;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      return `(i64.extend_i32_s ${indexOf(k)})`;
    }
    if (member === "nextElementIndex" && valueWanted) {
      if (wireCompiled("nextElementIndex")) return lastWired;
      return `(i64.extend_i32_s (call $hm_next ${map} (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L!)} ${C(info.occBase!)}))`;
    }
    if (member === "isEmptySlot" && valueWanted) {
      if (wireCompiled("isEmptySlot")) return lastWired;
      const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L! - 1)})`;
      return `(i64.extend_i32_u (i32.ne (call $hm_flag (i32.add ${map} ${C(info.occBase!)}) ${idx}) (i32.const 1)))`;
    }
    if (member === "value" && valueWanted) return loadAt(`(i32.add ${elemAt(expr.args[0])} ${C(info.valOff!)})`, info.valSize!);
    if (member === "key" && valueWanted && info.keySize! <= 8) return loadAt(elemAt(expr.args[0]), info.keySize!);

    // get(key, &value) — bool found, value copied out. The out parameter is a real lvalue (emitAddr),
    if (member === "get") {
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const out = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      const cm = compileContainerMethod(ctx.cg, node.type, "get", 2);
      const call = cm
        ? `(call ${cm.label} ${map} ${k} ${out})`
        : `(i64.extend_i32_u (call $hm_get ${map} ${k} ${out} ${dims} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container call")))}`);
      return "";
    }

    // set (HashMap) / add (HashSet) both insert; add has no value.
    if (member === "set" || member === "add") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = isSet ? k : argAddr(ctx, expr.args[1], info.valSize!);
      const call = `(i64.extend_i32_s (call $hm_set ${map} ${k} ${v} ${dims} ${C(info.popOff!)} ${C(info.hashMode!)}))`;
      if (valueWanted) return call;
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container call")))}`);
      return "";
    }
    if (member === "removeByKey" || member === "remove") {
      if (wireCompiled(member)) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_remove", addrIr(map), addrIr(k), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!)))}`);
      return "";
    }
    if (member === "replace") {
      if (wireCompiled("replace")) return valueWanted ? lastWired : "";
      if (valueWanted) return null;
      const k = argAddr(ctx, expr.args[0], info.keySize!);
      const v = argAddr(ctx, expr.args[1], info.valSize!);
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, ir.raw(indexOf(k), "i32", "unconverted: hm index probe"))}`);
      ctx.lines.push(`    (if (i32.ge_s (local.get $${t}) (i32.const 0)) (then (call $copyMem (i32.add (call $hm_elem ${map} (local.get $${t}) ${C(info.elemSize)}) ${C(info.valOff!)}) ${v} ${C(info.valSize!)})))`);
      return "";
    }
    if (member === "reset" && !valueWanted) {
      if (wireCompiled("reset")) return "";
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_reset", addrIr(map), ir.i32c(info.totalSize!)))}`);
      return "";
    }
    // cleanup family: compaction + threshold checks over the mark-removal counter, matching the native rehash byte-for-byte (slot placement is
    const threshold = () => (expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(50));
    if (member === "cleanup" && !valueWanted) {
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_cleanup", addrIr(map), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!), ir.i32c(info.totalSize!)))}`);
      return "";
    }
    if (member === "cleanupIfNeeded" && !valueWanted) {
      ctx.lines.push(`    ${ir.emit(ir.call("$hm_cleanup_if", addrIr(map), ir.i32c(info.L!), ir.i32c(info.elemSize), ir.i32c(info.keySize!), ir.i32c(info.occBase!), ir.i32c(info.popOff!), ir.i32c(info.hashMode!), ir.i32c(info.totalSize!), threshold()))}`);
      return "";
    }
    if (member === "needsCleanup" && valueWanted) {
      return ir.emit(ir.call("$hm_needs_cleanup", addrIr(map), ir.i32c(info.L!), ir.i32c(info.popOff!), threshold()));
    }
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
    // Collection cleanup family: pov-table compaction + threshold checks over the mark-removal counter. The native body leans on _tzcnt_u64/_lzcnt_u64
    if (node.type.name === "Collection" && (member === "cleanup" || member === "cleanupIfNeeded" || member === "needsCleanup")) {
      const lay = ctx.cg.containerLayout("Collection", node.type.args);
      const ci = ctx.cg.collectionInfo(node.type.args);
      const flagsF = lay.fields.get("_povOccupationFlags");
      const elemsF = lay.fields.get("_elements");
      const popF = lay.fields.get("_population");
      if (ci && flagsF && elemsF && popF) {
        const threshold = () => expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(50);
        if (member === "cleanup" && !valueWanted) {
          ctx.lines.push(`    ${ir.emit(ir.call("$coll_cleanup", addrIr(map), ir.i32c(ci.L), ir.i32c(flagsF.offset), ir.i32c(elemsF.offset), ir.i32c(ci.stride), ir.i32c(popF.offset)))}`);
          return "";
        }
        if (member === "cleanupIfNeeded" && !valueWanted) {
          ctx.lines.push(`    ${ir.emit(ir.call("$coll_cleanup_if", addrIr(map), ir.i32c(ci.L), ir.i32c(flagsF.offset), ir.i32c(elemsF.offset), ir.i32c(ci.stride), ir.i32c(popF.offset), threshold()))}`);
          return "";
        }
        if (member === "needsCleanup" && valueWanted) {
          return ir.emit(ir.call("$hm_needs_cleanup", addrIr(map), ir.i32c(ci.L), ir.i32c(popF.offset), threshold()));
        }
      }
    }
    if ((member === "element" || member === "pov") && valueWanted) {
      const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
      return c && c.cm.retKind === "i64" ? c.call : null;
    }
    const c = callCompiled(ctx, node.type as TypeSpec & { kind: "template_instance" }, member, map, expr.args);
    if (!c) return null;
    if (valueWanted) return c.cm.retKind === "void" ? null : c.call;
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
