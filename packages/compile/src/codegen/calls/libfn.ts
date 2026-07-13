import { resolveAddr, emitAddr, allocSlot, narrowCast, argAddr } from "../addr";
import { emitHelperFunction } from "../stmt";
import { Codegen } from "../cg";
import {
  emitValueIr,
  isUnsignedExpr,
  emitValue,
  promoteInfo,
  scalarTypeInfo,
  unsignedScalar,
  isU128Expr,
} from "../value";
import { FnCtx, HelperInfo, Bindings, NO_BIND } from "../types";
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
import * as ir from "../../ir";

// Call to a contract value helper (toReturnCode(...)): scalar args by value, aggregate args by address. valueWanted → returns
export function compileLibFn(
  cg: Codegen,
  name: string,
  definition?: FunctionDecl,
  cacheKey = name,
): HelperInfo | null {
  const cached = cg.helpers.get(cacheKey);
  if (cached) return cached;
  // Resolve via namespace candidates (using-directives + lexical source). libFns are keyed by full namespace path.
  let resolvedKey = name;
  let fn = definition;
  if (!fn) {
    for (const key of cg.namespaceCandidates(name)) {
      const hit = cg.libFns.get(key);
      if (hit) {
        fn = hit;
        resolvedKey = key;
        break;
      }
    }
  }
  if (!fn || !fn.body) return null;
  const params = fn.params.map((p) => {
    // A NON-const scalar reference (RL::makeDateStamp's `uint32& res`) is an out-param and must travel by address for the write
    const isConstRef = p.type.kind === "reference" && p.type.refereed?.kind === "const";
    const isPtrRef = (p.type.kind === "reference" && !isConstRef) || p.type.kind === "pointer";
    const isAddr = isPtrRef || cg.isAggregateType(p.type);
    const byValAgg = isAddr && p.type.kind !== "reference" && p.type.kind !== "pointer";
    return {
      name: p.name,
      wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
      isAddr,
      type: cg.derefType(p.type),
      byValAgg,
    };
  });
  const retAgg =
    !cg.isVoidType(fn.returnType) && cg.isAggregateType(fn.returnType)
      ? cg.sizeOfType(fn.returnType)
      : undefined;
  const retIsValue = !cg.isVoidType(fn.returnType) && !retAgg;
  const nameSep = resolvedKey.lastIndexOf("::");
  const authoritative = isAuthoritativeSymbol(resolvedKey);
  const lookup = cg.namespaceContextOf(fn);
  const info: HelperInfo = {
    label: `$lib${cg.helpers.size}_${resolvedKey.replace(/[^a-zA-Z0-9]/g, "_")}`,
    params,
    retIsValue,
    retAgg,
    retType: cg.derefType(fn.returnType),
    sourceNamespace: nameSep >= 0 ? resolvedKey.slice(0, nameSep) : undefined,
    usingNamespaces: lookup.usingNamespaces,
  };
  cg.helpers.set(cacheKey, info); // register before emit so recursion/sibling calls resolve
  try {
    const warningBase = cg.warnings.length;
    const errorBase = cg.errors.length;
    const wat = emitHelperFunction(cg, info, fn, { size: 0, align: 1, fields: new Map() });
    if (authoritative && (cg.warnings.length !== warningBase || cg.errors.length !== errorBase)) {
      const diagnostic =
        cg.errors[errorBase]?.message ??
        cg.warnings[warningBase]?.message ??
        "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    cg.emittedMethodOrder.push(wat);
  } catch (e: any) {
    cg.warn(`failed to compile lib fn ${resolvedKey}: ${e.message}`, fn.span?.line ?? 0);
    cg.helpers.delete(cacheKey);
    if (authoritative) throw e;
    return null;
  }
  return info;
}

// Deduce template bindings (T→sint64, L→4) for a free function template from the concrete types of its call-site arguments:
export function deduceLibFnBindings(
  ctx: FnCtx,
  def: FunctionTemplateDecl,
  args: Expression[],
  explicit: TypeSpec[] = [],
): Bindings {
  const types = new Map<string, TypeSpec>();
  const values = new Map<string, bigint>();
  const typeParams = new Set(def.params.filter((p) => p.kind === "type").map((p) => p.name));
  const valueParams = new Set(def.params.filter((p) => p.kind !== "type").map((p) => p.name));
  const fps = def.fnParams ?? [];

  def.params.forEach((param, index) => {
    const arg = explicit[index];
    if (!arg) return;
    if (param.kind === "type") {
      types.set(param.name, ctx.thisBind ? ctx.cg.substInBindings(arg, ctx.thisBind) : arg);
    } else {
      values.set(param.name, ctx.cg.valueOfTypeArg(arg, ctx.thisBind ?? NO_BIND));
    }
  });

  const argType = (a: Expression): TypeSpec | null => {
    let t = resolveAddr(ctx, a)?.type ?? null;
    if (!t) {
      // A computed uint128 rvalue has no lvalue address until call lowering materializes it,
      // but template deduction still sees its class type (`div(a * b, c)` in GGWP/Qswap).
      if (isU128Expr(ctx, a)) return { kind: "name", name: "uint128_t" };
      const scalar = scalarTypeInfo(ctx, a);
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
    t = ctx.cg.derefType(t);
    // Resolve through the caller's template bindings so the deduced type is concrete (ProposalDataType → ProposalDataV1<false>), not a symbolic
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
        else if (valueParams.has(pa.name) && !values.has(pa.name))
          values.set(pa.name, ctx.cg.valueOfTypeArg(at.args[j]));
      }
    } else if (pt.kind === "name" && typeParams.has(pt.name) && !types.has(pt.name)) {
      const at = argType(arg);
      if (at) types.set(pt.name, at);
    }
  }
  return { types, values, structs: new Map() };
}

// Pick the overload whose parameter patterns best match the concrete argument types. A concrete name
export function pickLibFnOverload(
  ctx: FnCtx,
  defs: FunctionTemplateDecl[],
  args: Expression[],
): FunctionTemplateDecl {
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
export function compileLibFnInstance(
  ctx: FnCtx,
  def: FunctionTemplateDecl,
  args: Expression[],
  explicit: TypeSpec[] = [],
  authoritative = false,
  sourceKey = def.name,
): HelperInfo | null {
  const cg = ctx.cg;
  const bind = deduceLibFnBindings(ctx, def, args, explicit);
  const keyArgs = def.params
    .map((p) =>
      p.kind === "type"
        ? cg.typeKeyOf(bind.types.get(p.name) ?? { kind: "name", name: p.name })
        : (bind.values.get(p.name)?.toString() ?? p.name),
    )
    .join(",");
  // The overload's source line disambiguates same-name defs whose deduced args coincide.
  const key = `${def.name}@${def.span?.line ?? 0}<${keyArgs}>`;
  const cached = cg.helpers.get(key);
  if (cached) return cached;

  const params = (def.fnParams ?? []).map((p) => {
    const concrete = cg.substInBindings(cg.derefType(p.type), bind);
    const aggregate = cg.isAggregateType(concrete);
    const constScalarRef =
      p.type.kind === "reference" && p.type.refereed.kind === "const" && !aggregate;
    const isPtrRef = p.type.kind === "pointer" || (p.type.kind === "reference" && !constScalarRef);
    const isAddr = isPtrRef || aggregate;
    const byValAgg = isAddr && !isPtrRef && aggregate;
    return {
      name: p.name,
      wasmType: (isAddr ? "i32" : "i64") as "i32" | "i64",
      isAddr,
      type: concrete,
      byValAgg,
    };
  });
  const retT = cg.substInBindings(cg.derefType(def.returnType), bind);
  const retAgg =
    !cg.isVoidType(def.returnType) && cg.isAggregateType(retT)
      ? cg.sizeOfType(retT, bind)
      : undefined;
  const retIsValue = !cg.isVoidType(def.returnType) && !retAgg;
  const sourceSep = sourceKey.lastIndexOf("::");
  const lookup = cg.namespaceContextOf(def);
  const info: HelperInfo = {
    label: `$lib${cg.helpers.size}_${key.replace(/[^a-zA-Z0-9]/g, "_")}`,
    params,
    retIsValue,
    retAgg,
    retType: retT,
    sourceNamespace: sourceSep >= 0 ? sourceKey.slice(0, sourceSep) : undefined,
    usingNamespaces: lookup.usingNamespaces,
  };
  cg.helpers.set(key, info); // register before emit so recursive/sibling calls resolve
  try {
    const warningBase = cg.warnings.length;
    const errorBase = cg.errors.length;
    const wat = emitHelperFunction(cg, info, def, { size: 0, align: 1, fields: new Map() }, bind);
    if (authoritative && (cg.warnings.length !== warningBase || cg.errors.length !== errorBase)) {
      const diagnostic =
        cg.errors[errorBase]?.message ??
        cg.warnings[warningBase]?.message ??
        "unknown lowering diagnostic";
      throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
    }
    cg.emittedMethodOrder.push(wat);
  } catch (e: any) {
    cg.warn(`failed to instantiate lib fn ${key}: ${e.message}`, def.span?.line ?? 0);
    cg.helpers.delete(key);
    if (authoritative) throw e;
    return null;
  }
  return info;
}

// Build the args for a helper call (scalar args by value, reference/aggregate args by address).
export function helperCallOps(ctx: FnCtx, info: HelperInfo, args: Expression[]): string {
  return info.params
    .map((p, i) => {
      const arg = args[i];
      if (!arg)
        throw new Error(
          `${info.sourceNamespace ?? info.label} is missing required argument ${i + 1}`,
        );
      if (p.isAddr) {
        return argAddr(
          ctx,
          arg,
          ctx.cg.sizeOfType(p.type, ctx.thisBind ?? NO_BIND),
          p.type,
          false,
          true,
        );
      }
      const declared = ctx.cg.derefType(p.type);
      const value = narrowCast(
        emitValue(ctx, arg),
        declared.kind === "name" ? declared.name : undefined,
      );
      return p.wasmType === "i32" ? `(i32.wrap_i64 ${value})` : value;
    })
    .join(" ");
}

// Aggregate-returning helpers allocate destination first, then pass it as the leading $ret arg.
export function emitAggHelperCall(
  ctx: FnCtx,
  expr: Expression & { kind: "call" },
  info: HelperInfo,
): string {
  const s = allocSlot(ctx, info.retAgg!);
  const ops = helperCallOps(ctx, info, expr.args);
  ctx.lines.push(`    (call ${info.label} ${s}${ops ? " " + ops : ""})`);
  return s;
}

// Scalar width/signedness of a declared parameter or return type, or null for aggregates/unknowns.
function scalarDeclInfo(ctx: FnCtx, t: TypeSpec): { width: number; unsigned: boolean } | null {
  const c = ctx.cg.derefType(t);
  const name =
    c.kind === "name" && c.name.includes("::")
      ? c.name.slice(c.name.lastIndexOf("::") + 2)
      : c.kind === "name"
        ? c.name
        : "";
  // The parser keeps a plain C `int` as `int`, while QPI's corresponding
  // typedef is spelled `sint32`. Treat the C spelling as its canonical signed
  const canonical =
    name === "int" || name === "signed"
      ? "signed int"
      : name === "unsigned"
        ? "unsigned int"
        : name;
  const normalized: TypeSpec = c.kind === "name" ? { ...c, name: canonical } : c;
  const sz = normalized.kind === "name" ? SCALAR_SIZE[normalized.name] : undefined;
  if (sz === undefined || sz > 8) return null;
  return { width: sz, unsigned: unsignedScalar(normalized) };
}

// Rank a member-helper overload set against the call's argument types, mirroring C++ overload resolution over the scalar subset:
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
  // Match the intrinsics by base name — a qualified QPI::div would otherwise slip past this guard, get instantiated
  const name = expr.callee.name;
  const base = symbolBaseName(name);
  const sourceKeys = ctx.cg.namespaceCandidates(name, ctx.sourceNamespace, ctx.usingNamespaces);
  const set = ctx.cg.helperOverloads.get(expr.callee.name);
  let info: HelperInfo | null | undefined = set?.length
    ? pickHelperOverload(ctx, set, expr.args)
    : sourceKeys.map((key) => ctx.cg.helpers.get(key)).find((candidate) => candidate !== undefined);
  if (!info) {
    for (const sourceKey of sourceKeys) {
      const defs = ctx.cg.libFnOverloads.get(sourceKey);
      if (!defs?.length) continue;
      const compiled = defs
        .map((definition, index) =>
          compileLibFn(
            ctx.cg,
            sourceKey,
            definition,
            `${sourceKey}@${definition.span?.line ?? index}`,
          ),
        )
        .filter((candidate): candidate is HelperInfo => candidate !== null);
      if (compiled.length) info = pickHelperOverload(ctx, compiled, expr.args);
      if (info) break;
    }
  }
  if (!info && !MATH_INTRINSIC_NAMES.has(base)) {
    info = compileLibFn(ctx.cg, expr.callee.name);
  }
  if (!info) {
    // A namespace free function template (isArraySortedWithoutDuplicates<T,L>): instantiate for this call, picking the overload whose parameter patterns match the
    const templateKey = sourceKeys.find((key) => ctx.cg.libFnTemplates.has(key));
    const tdefs = templateKey ? ctx.cg.libFnTemplates.get(templateKey) : undefined;
    if (tdefs?.length)
      info = compileLibFnInstance(
        ctx,
        pickLibFnOverload(ctx, tdefs, expr.args),
        expr.args,
        (expr as Expression & { templateArgs?: TypeSpec[] }).templateArgs ?? [],
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
      ctx.thisBind?.types.get(ownerName) ?? ctx.thisBind?.types.get(ownerName.split("::").pop()!);
    const sd = boundOwner
      ? (ctx.cg.structOf(boundOwner, ctx.thisBind ?? NO_BIND) ?? undefined)
      : ctx.cg.structByName(ownerName, ctx.thisBind ?? NO_BIND);
    const fn = sd?.members.find(
      (m): m is Declaration & { kind: "function" } =>
        m.kind === "function" && m.name === method && m.isStatic && !!m.body,
    );
    if (sd && fn) {
      // Param/return types spelled in the owner's scope (const OracleReply&) name its nested structs — substitute them inline so
      const nestedOf = new Map(
        sd.members
          .filter((m): m is StructDecl => m.kind === "struct" && !!m.name)
          .map((m) => [m.name, m]),
      );
      const qual = (tp: TypeSpec): TypeSpec => {
        if (tp.kind === "const") return { ...tp, valueType: qual(tp.valueType) };
        if (tp.kind === "reference") return { ...tp, refereed: qual(tp.refereed) };
        if (tp.kind === "name" && nestedOf.has(tp.name))
          return { kind: "inline_struct", struct: nestedOf.get(tp.name)!, span: tp.span };
        return tp;
      };
      const def: FunctionTemplateDecl = {
        kind: "function_template",
        name: `${sd.name}::${method}`,
        params: [],
        fnParams: fn.params.map((p) => ({ ...p, type: qual(p.type) })),
        returnType: qual(fn.returnType),
        body: fn.body,
        isConstexpr: fn.isConstexpr,
        span: fn.span,
      };
      info = compileLibFnInstance(ctx, def, expr.args);
    }
  }
  return info ?? null;
}

export function emitHelperCall(
  ctx: FnCtx,
  expr: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  const info = lookupHelper(ctx, expr);
  if (!info) return null;

  // An aggregate-returning helper flows as an address — materialize into a slot. In value context return 0
  if (info.retAgg) {
    const addr = emitAggHelperCall(ctx, expr, info);
    return valueWanted ? "(i64.const 0)" : (void addr, "");
  }

  const ops = helperCallOps(ctx, info, expr.args);
  const call = `(call ${info.label}${ops ? " " + ops : ""})`;

  if (valueWanted) {
    if (!info.retIsValue) return "(i64.const 0)";
    if (info.retWasmType === "i32") {
      const unsigned = info.retType ? unsignedScalar(ctx.cg.derefType(info.retType)) : true;
      return `(${unsigned ? "i64.extend_i32_u" : "i64.extend_i32_s"} ${call})`;
    }
    return call;
  }
  ctx.lines.push(info.retIsValue ? `    (drop ${call})` : `    ${call}`);
  return "";
}
