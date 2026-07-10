import { resolveAddr, emitAddr, allocSlot } from "../addr";
import { emitHelperFunction } from "../stmt";
import { Codegen } from "../cg";
import { emitValueIr, isUnsignedExpr, emitValue, promoteInfo, scalarTypeInfo, unsignedScalar } from "../value";
import { FnCtx, HelperInfo, Bindings, NO_BIND } from "../types";
import { MATH_INTRINSIC_NAMES, SCALAR_SIZE } from "../tables";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

// QPI safe-math + helper free functions, lowered to scalar i64. div/mod guard division by zero;
// sadd/smul saturate at the type extreme, matching math_lib.h — the 32-bit overloads clamp at
// INT32/UINT32, selected by argument width like native overload resolution.
export function emitMathCallIr(ctx: FnCtx, name: string, args: Expression[]): ir.Ir | null {
  const a = () => (args[0] ? emitValueIr(ctx, args[0]) : ir.i64c(0));
  const b = () => (args[1] ? emitValueIr(ctx, args[1]) : ir.i64c(0));
  // accept a namespace-qualified spelling (math_lib::max, QPI::div, RL::min) — strip the qualifier.
  const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  // div/mod/min/max take the unsigned variant when either operand is unsigned (C++ usual-conversion rule).
  // Without this, `min(div(reward,price), slots)` on a huge uint64 reward picked the wrong branch via a signed
  // compare, so RL's BuyTicket computed a giant `toBuy` and looped ~forever. `sdiv` stays explicitly signed.
  const u = (args[0] ? isUnsignedExpr(ctx, args[0]) : false) || (args[1] ? isUnsignedExpr(ctx, args[1]) : false);
  const s = u ? "u" : "s";
  switch (base) {
    case "sdiv": return ir.call("$m_div_s", a(), b());
    case "div": return ir.call(`$m_div_${s}`, a(), b());
    case "mod": return ir.call(`$m_mod_${s}`, a(), b());
    case "min": return ir.call(`$m_min_${s}`, a(), b());
    case "max": return ir.call(`$m_max_${s}`, a(), b());
    case "abs": return ir.call("$m_abs", a());
    // sadd/smul are SATURATING natively (math_lib.h clamps at the type extreme) — plain wrap-around
    // arithmetic silently diverges exactly at the overflow boundary. Both args at rank ≤ 32 select
    // the 32-bit overload (clamps at the 32-bit extremes), mirroring native overload resolution.
    case "sadd": case "smul": {
      const w4 = args.length >= 2 &&
        promoteInfo(ctx, args[0]).width === 4 && promoteInfo(ctx, args[1]).width === 4;
      return ir.call(`$m_${base}_${s}${w4 ? "32" : ""}`, a(), b());
    }
    default: return null;
  }
}

export function emitMathCall(ctx: FnCtx, name: string, args: Expression[]): string | null {
  const n = emitMathCallIr(ctx, name, args);
  return n === null ? null : ir.emit(n);
}

// Call to a contract value helper (toReturnCode(...)): scalar args by value, aggregate args by
// address. valueWanted → returns the i64 result; otherwise pushes the call as a statement.
// Compile a qpi.h namespace free function (ProposalTypes::cls / optionCount) on first use: register it as a
// pure value helper and emit its wasm function. Returns its HelperInfo, or null if it can't be compiled.
export function compileLibFn(cg: Codegen, name: string): HelperInfo | null {
  const cached = cg.helpers.get(name);
  if (cached) return cached;
  // `using namespace QPI` lets a call drop the QPI:: qualifier; libFns are keyed by full namespace path.
  const fn = cg.libFns.get(name) ?? cg.libFns.get(`QPI::${name}`);
  if (!fn || !fn.body) return null;
  const params = fn.params.map((p) => {
    // A NON-const scalar reference (RL::makeDateStamp's `uint32& res`) is an out-param and must travel by
    // address for the write to reach the caller; a const scalar ref stays a value (same policy as helpers).
    const isConstRef = p.type.kind === "reference" && p.type.refereed?.kind === "const";
    const isPtrRef = (p.type.kind === "reference" && !isConstRef) || p.type.kind === "pointer";
    const isAddr = isPtrRef || cg.isAggregateType(p.type);
    const byValAgg = isAddr && p.type.kind !== "reference" && p.type.kind !== "pointer";
    return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: cg.derefType(p.type), byValAgg };
  });
  const retAgg = !cg.isVoidType(fn.returnType) && cg.isAggregateType(fn.returnType) ? cg.sizeOfType(fn.returnType) : undefined;
  const retIsValue = !cg.isVoidType(fn.returnType) && !retAgg;
  const info: HelperInfo = { label: `$lib${cg.helpers.size}_${name.replace(/[^a-zA-Z0-9]/g, "_")}`, params, retIsValue, retAgg };
  cg.helpers.set(name, info);   // register before emit so recursion/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitHelperFunction(cg, info, fn, { size: 0, align: 1, fields: new Map() }));
  } catch (e: any) {
    cg.warn(`failed to compile lib fn ${name}: ${e.message}`, fn.span?.line ?? 0);
    cg.helpers.delete(name);
    return null;
  }
  return info;
}

// Deduce template bindings (T→sint64, L→4) for a free function template from the concrete types of its
// call-site arguments: a param `const Array<T,L>&` matched against arg `Array<sint64,4>` binds T and L.
export function deduceLibFnBindings(ctx: FnCtx, def: FunctionTemplateDecl, args: Expression[]): Bindings {
  const types = new Map<string, TypeSpec>();
  const values = new Map<string, bigint>();
  const typeParams = new Set(def.params.filter((p) => p.kind === "type").map((p) => p.name));
  const valueParams = new Set(def.params.filter((p) => p.kind !== "type").map((p) => p.name));
  const fps = def.fnParams ?? [];

  const argType = (a: Expression): TypeSpec | null => {
    let t = resolveAddr(ctx, a)?.type ?? null;
    if (!t) return null;
    t = ctx.cg.derefType(t);
    // Resolve through the caller's template bindings so the deduced type is concrete (ProposalDataType →
    // ProposalDataV1<false>), not a symbolic param name the instantiated lib fn can't size.
    if (ctx.thisBind) t = ctx.cg.derefType(ctx.cg.substInBindings(t, ctx.thisBind));
    for (let i = 0; i < 8 && t.kind === "name"; i++) {
      const td = ctx.cg.typedefs.get(t.name);
      if (!td) break;
      t = ctx.cg.derefType(td);
    }
    return t;
  };

  for (let i = 0; i < fps.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    const pt = ctx.cg.derefType(fps[i].type);
    if (pt.kind === "template_instance") {
      const at = argType(arg);
      if (at?.kind !== "template_instance" || at.name !== pt.name) continue;
      for (let j = 0; j < pt.args.length && j < at.args.length; j++) {
        const pa = pt.args[j];
        if (pa.kind !== "name") continue;
        if (typeParams.has(pa.name) && !types.has(pa.name)) types.set(pa.name, at.args[j]);
        else if (valueParams.has(pa.name) && !values.has(pa.name)) values.set(pa.name, ctx.cg.valueOfTypeArg(at.args[j]));
      }
    } else if (pt.kind === "name" && typeParams.has(pt.name) && !types.has(pt.name)) {
      const at = argType(arg);
      if (at) types.set(pt.name, at);
    }
  }
  return { types, values, structs: new Map() };
}

// Pick the overload whose parameter patterns best match the concrete argument types. A concrete name
// in a pattern (ProposalWithAllVoteData<ProposalDataYesNo, maxVotes>) must EQUAL the argument's type
// at that position — matching disqualifies the def otherwise — while a template-param name matches
// anything. Mirrors C++ partial-ordering just far enough for qpi.h's overload sets: the YesNo
// specialization wins for YesNo args and is rejected for V1 args.
export function pickLibFnOverload(ctx: FnCtx, defs: FunctionTemplateDecl[], args: Expression[]): FunctionTemplateDecl {
  if (defs.length === 1) return defs[0];

  const argTypeOf = (a: Expression): TypeSpec | null => {
    let t = resolveAddr(ctx, a)?.type ?? null;
    if (!t) return null;
    t = ctx.cg.derefType(t);
    if (ctx.thisBind) t = ctx.cg.derefType(ctx.cg.substInBindings(t, ctx.thisBind));
    return t;
  };
  const argTypes = args.map(argTypeOf);

  const score = (def: FunctionTemplateDecl): number => {
    const fps = def.fnParams ?? [];
    if (args.length > fps.length) return -1;
    const tparams = new Set(def.params.map((p) => p.name));

    let s = 0;
    for (let i = 0; i < fps.length && i < args.length; i++) {
      const pat = ctx.cg.derefType(fps[i].type);
      const at = argTypes[i];
      if (!at) continue;
      if (pat.kind === "name") {
        if (tparams.has(pat.name)) s += 1;
        else if (at.kind === "name" && at.name === pat.name) s += 2;
        continue;
      }
      if (pat.kind === "template_instance" && at.kind === "template_instance") {
        if (pat.name !== at.name) return -1;
        for (let j = 0; j < pat.args.length && j < at.args.length; j++) {
          const pa = pat.args[j];
          if (pa.kind !== "name") continue;
          if (tparams.has(pa.name)) {
            s += 1;
          } else {
            const aa = at.args[j];
            if (aa.kind === "name" && aa.name === pa.name) s += 2;
            else if (aa.kind === "template_instance" && aa.name === pa.name) s += 2;
            else return -1;
          }
        }
      }
    }
    return s;
  };

  let best = defs[0];
  let bestScore = score(defs[0]);
  for (let i = 1; i < defs.length; i++) {
    const s = score(defs[i]);
    if (s > bestScore) {
      best = defs[i];
      bestScore = s;
    }
  }
  return best;
}

// Instantiate a free function template for the concrete types at a call site, emitting its wasm function.
// Param types are substituted through the deduced bindings (Array<T,L> → Array<sint64,4>) so the body's
// container calls resolve, and bare value params (`L`) read from thisBind.values. Cached by instantiation.
export function compileLibFnInstance(ctx: FnCtx, def: FunctionTemplateDecl, args: Expression[]): HelperInfo | null {
  const cg = ctx.cg;
  const bind = deduceLibFnBindings(ctx, def, args);
  const keyArgs = def.params
    .map((p) => (p.kind === "type" ? cg.typeKeyOf(bind.types.get(p.name) ?? { kind: "name", name: p.name }) : (bind.values.get(p.name)?.toString() ?? p.name)))
    .join(",");
  // The overload's source line disambiguates same-name defs whose deduced args coincide.
  const key = `${def.name}@${def.span?.line ?? 0}<${keyArgs}>`;
  const cached = cg.helpers.get(key);
  if (cached) return cached;

  const params = (def.fnParams ?? []).map((p) => {
    const isPtrRef = p.type.kind === "reference" || p.type.kind === "pointer";
    const concrete = cg.substInBindings(cg.derefType(p.type), bind);
    const isAddr = isPtrRef || cg.isAggregateType(concrete);
    const byValAgg = isAddr && !isPtrRef;
    return { name: p.name, wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64", isAddr, type: concrete, byValAgg };
  });
  const retT = cg.substInBindings(cg.derefType(def.returnType), bind);
  const retAgg = !cg.isVoidType(def.returnType) && cg.isAggregateType(retT) ? cg.sizeOfType(retT, bind) : undefined;
  const retIsValue = !cg.isVoidType(def.returnType) && !retAgg;
  const info: HelperInfo = { label: `$lib${cg.helpers.size}_${key.replace(/[^a-zA-Z0-9]/g, "_")}`, params, retIsValue, retAgg };
  cg.helpers.set(key, info);   // register before emit so recursive/sibling calls resolve
  try {
    cg.emittedMethodOrder.push(emitHelperFunction(cg, info, def, { size: 0, align: 1, fields: new Map() }, bind));
  } catch (e: any) {
    cg.warn(`failed to instantiate lib fn ${key}: ${e.message}`, def.span?.line ?? 0);
    cg.helpers.delete(key);
    return null;
  }
  return info;
}


// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
export function helperCallOps(ctx: FnCtx, info: HelperInfo, args: Expression[]): string {
  return info.params.map((p, i) => {
    const arg = args[i];
    if (!arg) return p.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    return p.isAddr ? (emitAddr(ctx, arg) ?? "(i32.const 0)") : emitValue(ctx, arg);
  }).join(" ");
}

// Call to an aggregate-returning helper (id liquidityPov(...)): allocate the destination slot, pass it as the
// leading $ret arg, emit the call as a statement, and return the slot's address (so the result chains like any
// aggregate lvalue).
export function emitAggHelperCall(ctx: FnCtx, expr: Expression & { kind: "call" }, info: HelperInfo): string {
  const s = allocSlot(ctx, info.retAgg!);
  const ops = helperCallOps(ctx, info, expr.args);
  ctx.lines.push(`    (call ${info.label} ${s}${ops ? " " + ops : ""})`);
  return s;
}

// Scalar width/signedness of a declared parameter or return type, or null for aggregates/unknowns.
function scalarDeclInfo(ctx: FnCtx, t: TypeSpec): { width: number; unsigned: boolean } | null {
  const c = ctx.cg.derefType(t);
  const sz = c.kind === "name" ? SCALAR_SIZE[c.name] : undefined;
  if (sz === undefined || sz > 8) return null;
  return { width: sz, unsigned: unsignedScalar(c) };
}

// Rank a member-helper overload set against the call's argument types, mirroring C++ overload
// resolution over the scalar subset: per argument, exact width+signedness beats width-only,
// which beats any other conversion; ties keep declaration order. Aggregate params and untypable
// arguments score neutral, so single-signature corpus code resolves exactly as before.
export function pickHelperOverload(ctx: FnCtx, set: HelperInfo[], args: Expression[]): HelperInfo {
  if (set.length === 1) return set[0];

  const argInfos = args.map((a) => scalarTypeInfo(ctx, a));
  const rank = (cand: HelperInfo): number => {
    if (cand.params.length !== args.length) return -1;
    let s = 0;
    for (let i = 0; i < args.length; i++) {
      const pi = scalarDeclInfo(ctx, cand.params[i].type);
      const ai = argInfos[i];
      if (!pi || !ai) continue;
      if (pi.width === ai.width && pi.unsigned === ai.unsigned) s += 2;
      else if (pi.width === ai.width) s += 1;
    }
    return s;
  };

  let best = set[0];
  let bestScore = rank(set[0]);
  for (let i = 1; i < set.length; i++) {
    const s = rank(set[i]);
    if (s > bestScore) {
      best = set[i];
      bestScore = s;
    }
  }
  return best;
}

// Resolve a helper / lib-fn name to its (possibly just-compiled) info, or null.
export function lookupHelper(ctx: FnCtx, expr: Expression & { kind: "call" }): HelperInfo | null {
  if (expr.callee.kind !== "identifier") return null;
  // Match the intrinsics by base name — a qualified QPI::div would otherwise slip past this guard,
  // get instantiated from its qpi.h template body, and lose the divide-by-zero-safe lowering.
  const name = expr.callee.name;
  const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
  if (MATH_INTRINSIC_NAMES.has(base)) return null;
  const set = ctx.cg.helperOverloads.get(expr.callee.name);
  let info = set?.length
    ? pickHelperOverload(ctx, set, expr.args)
    : (ctx.cg.helpers.get(expr.callee.name) ?? compileLibFn(ctx.cg, expr.callee.name));
  if (!info) {
    // A namespace free function template (isArraySortedWithoutDuplicates<T,L>): instantiate for this call,
    // picking the overload whose parameter patterns match the argument types.
    const tdefs = ctx.cg.libFnTemplates.get(expr.callee.name) ?? ctx.cg.libFnTemplates.get(`QPI::${expr.callee.name}`);
    if (tdefs?.length) info = compileLibFnInstance(ctx, pickLibFnOverload(ctx, tdefs, expr.args), expr.args);
  }
  if (!info && name.includes("::")) {
    // Qualified static member call (OI::Price::getQueryFee(q)) — resolve the struct (namespace members
    // are flattened at parse; structByName strips qualifiers), wrap the static method as a template-less
    // lib fn and instantiate it through the same helper cache.
    const segs = name.split("::");
    const method = segs[segs.length - 1];
    const sd = ctx.cg.structByName(segs.slice(0, -1).join("::"), ctx.thisBind ?? NO_BIND);
    const fn = sd?.members.find(
      (m): m is Declaration & { kind: "function" } => m.kind === "function" && m.name === method && m.isStatic && !!m.body,
    );
    if (sd && fn) {
      // Param/return types spelled in the owner's scope (const OracleReply&) name its nested structs —
      // substitute them inline so the instance compiles without the owner's lookup scope.
      const nestedOf = new Map(sd.members.filter((m): m is StructDecl => m.kind === "struct" && !!m.name).map((m) => [m.name, m]));
      const qual = (tp: TypeSpec): TypeSpec => {
        if (tp.kind === "const") return { ...tp, valueType: qual(tp.valueType) };
        if (tp.kind === "reference") return { ...tp, refereed: qual(tp.refereed) };
        if (tp.kind === "name" && nestedOf.has(tp.name)) return { kind: "inline_struct", struct: nestedOf.get(tp.name)!, span: tp.span };
        return tp;
      };
      const def: FunctionTemplateDecl = {
        kind: "function_template", name: `${sd.name}::${method}`, params: [],
        fnParams: fn.params.map((p) => ({ ...p, type: qual(p.type) })),
        returnType: qual(fn.returnType), body: fn.body, isConstexpr: fn.isConstexpr, span: fn.span,
      };
      info = compileLibFnInstance(ctx, def, expr.args);
    }
  }
  return info ?? null;
}

export function emitHelperCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  const info = lookupHelper(ctx, expr);
  if (!info) return null;

  // An aggregate-returning helper flows as an address — materialize into a slot. In value context return 0
  // (the aggregate value is reached through emitAddr); as a statement just run it for its side effects.
  if (info.retAgg) {
    const addr = emitAggHelperCall(ctx, expr, info);
    return valueWanted ? "(i64.const 0)" : (void addr, "");
  }

  const ops = helperCallOps(ctx, info, expr.args);
  const call = `(call ${info.label}${ops ? " " + ops : ""})`;

  if (valueWanted) return info.retIsValue ? call : "(i64.const 0)";
  ctx.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
  return "";
}
