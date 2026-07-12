import { Codegen } from "./cg";
import { emitAggHelperCall, emitHelperCall, lookupHelper, pickHelperOverload } from "./calls/libfn";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES, symbolBaseName } from "./tables";
import { isScalarLocal, emitIncDec, newTmp } from "./stmt";
import { describeShape, emitCallValueIr, emitOracleQueryCall, emitOracleReadCall } from "./calls/dispatch";
import { emitQpiCall, QPI_CALLS } from "./calls/qpi";
import { callCompiled, emitAssetIter } from "./calls/containers";
import { resolveAddr, isUint128, addrIr, isAggregate, emitConstruct, emitAddr, emitInlineStructValue, setLocal, narrowCastIr, loadAtIr, isSignedScalarType, allocSlotIr } from "./addr";
import { FnCtx, NO_BIND } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import * as ir from "../ir";

function newValueTmp(ctx: FnCtx): string {
  let name: string;
  do name = `__qinit_value${ctx.tmpCount++}`;
  while (ctx.localVars.has(name) || ctx.params?.has(name));
  ctx.localVars.set(name, { wasmType: "i64" });
  return name;
}

// ---- assignment ----

// Lowers an assignment by pushing WAT lines to ctx; returns "" (the statement is fully emitted).
export function emitAssign(ctx: FnCtx, expr: Expression & { kind: "assign" }): string {
  if (ctx.cg.gtestMode && expr.op === "=" && expr.left.kind === "member_access"
      && expr.left.object.kind === "identifier" && expr.left.object.name === "system"
      && (expr.left.member === "epoch" || expr.left.member === "tick")) {
    const host = expr.left.member === "epoch" ? "$qt_set_epoch" : "$qt_set_tick";
    ctx.lines.push(`    ${ir.emit(ir.call(host, ir.op("i32.wrap_i64", emitValueIr(ctx, expr.right))))}`);
    return "";
  }
  const lhs = resolveAddr(ctx, expr.left);

  // uint128 plain assignment materializes RHS through source-compiled uint128_t helpers for computed expressions.
  if (lhs && expr.op === "=" && isUint128(ctx.cg, lhs.type)) {
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), emitU128Ir(ctx, expr.right), ir.i32c(16)))}`);
    return "";
  }

  // aggregate target (id/m256i/struct/array): copy by value, or let a qpi producer write into it
  if (lhs && expr.op === "=" && isAggregate(ctx, lhs.type, lhs.size)) {
    // Assignment-form iterator construction (`locals.aoi = AssetOwnershipIterator(asset)`): the RHS `Type(...)` parses as a plain call, so it has no
    if (lhs.type?.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(lhs.type.name)
      && (expr.right.kind === "call" || expr.right.kind === "construct")
      && ((expr.right.kind === "call" && expr.right.callee.kind === "identifier" && /Asset(Ownership|Possession)Iterator$/.test(expr.right.callee.name))
        || expr.right.kind === "construct")) {
      const arg = expr.right.args[0];
      if (arg) {
        emitAssetIter(ctx, {
          kind: "call", span: expr.span, args: [arg],
          callee: { kind: "member_access", span: expr.span, object: expr.left, member: "begin" },
        } as Expression & { kind: "call" }, "stmt");
      } else {
        ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, addrIr(lhs.addr), ir.i64c(0)))}`); // zero count+cursor
      }
      return "";
    }
    if (expr.right.kind === "call") {
      const out = emitQpiCall(ctx, expr.right, lhs.addr);
      if (out && out.ret === "out") {
        ctx.lines.push(`    ${out.wat}`);
        return "";
      }
    }
    // aggregate construction `target = Type{ ... }` (e.g. a Logger) — materialize the fields in place.
    if (expr.right.kind === "construct" && lhs.type && emitConstruct(ctx, lhs.addr, lhs.type, expr.right.args)) {
      return "";
    }
    // bare brace-init-list `target = { a, b, c };` — same field-wise materialization, typed by the target.
    if (expr.right.kind === "initializer_list" && lhs.type && emitConstruct(ctx, lhs.addr, lhs.type, expr.right.exprs)) {
      return "";
    }
    const src = emitAddr(ctx, expr.right);
    if (src) {
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), addrIr(src), ir.i32c(lhs.size)))}`);
      return "";
    }
    ctx.cg.warn(`unsupported aggregate assignment [${describeShape(expr.left)} = ${describeShape(expr.right)}]`, expr.span.line);
    return "";
  }

  // uint128 compound assignment (z >>= n, prod -= y + z): lhs = lhs <op> rhs via the
  if (lhs && expr.op !== "=" && isUint128(ctx.cg, lhs.type)) {
    const binOp = expr.op.slice(0, -1);
    const src = emitU128Ir(ctx, { kind: "binary_op", op: binOp, left: expr.left, right: expr.right, span: expr.span } as Expression & { kind: "binary_op" });
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(lhs.addr), src, ir.i32c(16)))}`);
    return "";
  }

  // scalar field target
  if (lhs) {
    if (expr.op === "=") {
      ctx.lines.push(`    ${ir.emit(ir.storeScalar(addrIr(lhs.addr), lhs.size, emitValueIr(ctx, expr.right)))}`);
      return "";
    }

    // Compound assignment lowers as lhs = lhs <op> rhs so the binary op carries the operands' real types
    ctx.lines.push(`    ${ir.emit(ir.storeScalar(addrIr(lhs.addr), lhs.size, emitValueIr(ctx, compoundToBinary(expr))))}`);
    return "";
  }

  // local variable / scalar value-parameter target (both are mutable wasm locals)
  if (expr.left.kind === "identifier" && isScalarLocal(ctx, expr.left.name)) {
    const n = expr.left.name;
    const rhs = expr.op === "=" ? emitValueIr(ctx, expr.right) : emitValueIr(ctx, compoundToBinary(expr));
    ctx.lines.push(`    ${setLocal(ctx, n, narrowLocalIr(ctx, n, rhs))}`);
    return "";
  }

  ctx.cg.warn(`unsupported assignment target [${describeShape(expr.left)}]`, expr.span.line);
  return "";
}

// Rewrite `lhs <op>= rhs` into the equivalent `lhs <op> rhs` expression node.
export function compoundToBinary(expr: Expression & { kind: "assign" }): Expression {
  return { kind: "binary_op", op: expr.op.slice(0, -1), left: expr.left, right: expr.right, span: expr.span } as Expression;
}

// Keep sub-64-bit scalar locals in canonical i64 form (zero-/sign-extended) on every store, so loads and compares can consume
export function narrowLocalIr(ctx: FnCtx, name: string, v: ir.Ir): ir.Ir {
  const raw = ctx.localVars.get(name)?.type ?? ctx.params?.get(name)?.type;
  const t = raw ? ctx.cg.scalarStorageType(raw) : undefined;
  if (t?.kind === "name" && (SCALAR_SIZE[t.name] ?? 8) < 8) {
    return narrowCastIr(v, t.name);
  }
  return v;
}

// ---- value (rvalue) codegen — produces an i64 ----

export function emitValueIr(ctx: FnCtx, expr: Expression): ir.Ir {
  if (ctx.cg.gtestMode && expr.kind === "member_access" && expr.member === "constructionEpoch"
      && expr.object.kind === "subscript" && expr.object.object.kind === "identifier"
      && expr.object.object.name === "contractDescriptions") {
    return ir.op("i64.extend_i32_u", ir.call("$qt_construction_epoch", ir.op("i32.wrap_i64", emitValueIr(ctx, expr.object.index))));
  }
  if (expr.kind === "member_access" && expr.member === "ptr" &&
      expr.object.kind === "identifier" && ctx.scratchpadLocals?.has(expr.object.name)) {
    return ir.op("i64.extend_i32_u", ir.getL(expr.object.name, "i32"));
  }
  // A uint128-valued expression used in a scalar/boolean context (a `while(z)` / `if(z)` truthiness test): materialize it and collapse
  if ((expr.kind === "call" || expr.kind === "binary_op" || expr.kind === "identifier" || expr.kind === "member_access") && isU128Expr(ctx, expr)) {
    const result = sourceU128Result(ctx, "operator bool", emitU128Ir(ctx, expr), []);
    return result.ty === "i64" ? result : ir.op("i64.extend_i32_u", result);
  }

  // `.low` / `.high` of a uint128-valued expression that is not itself an lvalue (e.g. `div(a, b).low`):
  if (expr.kind === "member_access" && (expr.member === "low" || expr.member === "high") && isU128Expr(ctx, expr.object)) {
    const a = emitU128Ir(ctx, expr.object);
    return ir.loadRaw("i64.load", expr.member === "high" ? 8 : 0, a);
  }

  switch (expr.kind) {
    case "int_literal": {
      const v = ctx.cg["sema"].evaluateConstexpr(expr) ?? 0n;
      return ir.i64c(v);
    }
    case "bool_literal":
      return ir.i64c(expr.value ? 1 : 0);
    case "nullptr_literal":
      return ir.i64c(0);
    case "char_literal":
      return ir.i64c(expr.value);
    case "paren":
      return emitValueIr(ctx, expr.expr);
    case "identifier": {
      // a reference local is an address, not a scalar value — its scalar use is always via a
      if (ctx.localVars.has(expr.name) && !ctx.refLocals?.has(expr.name)) {
        return ir.getL(expr.name, ctx.localVars.get(expr.name)!.wasmType);
      }
      // a pointer local read as a value (p == NULL): the held address, zero-extended.
      if (ctx.refLocals?.get(expr.name)?.kind === "pointer") {
        return ir.op("i64.extend_i32_u", ir.getL(expr.name, "i32"));
      }
      const p = ctx.params?.get(expr.name);
      if (p && !p.isAddr) return ir.getL(p.local ?? expr.name, p.wasmType);
      // A pointer param read as a value (if (ptr), ptr == NULL) is the held address; a scalar
      if (p && p.isAddr && p.type.kind === "pointer")
        return ir.op("i64.extend_i32_u", ir.getL(p.local ?? expr.name, "i32"));
      if (p && p.isAddr && !ctx.cg.isAggregateType(p.type))
        return ir.loadScalar(ir.getL(p.local ?? expr.name, "i32"), ctx.cg.sizeOfType(p.type), !unsignedScalar(p.type));
      if (expr.name === "SELF_INDEX") return ir.op("i64.extend_i32_u", ir.call("$qpi_contractIndex"));
      if (expr.name === "NULL") return ir.i64c(0);
      // inside a compiled container method: a template non-type param (L), a static constexpr member (_nEncodedFlags), or a bare
      if (ctx.thisBind?.values.has(expr.name)) return ir.i64c(ctx.thisBind.values.get(expr.name)!);
      if (ctx.staticConsts?.has(expr.name)) return ir.i64c(ctx.staticConsts.get(expr.name)!);
      if (ctx.thisLayout) {
        const tn = resolveAddr(ctx, expr);
        if (tn && tn.size <= 8) return loadAtIr(tn.addr, tn.size, isSignedScalarType(tn.type, ctx.cg));
      }
      // entry-fn `input`/`output` typed by a scalar typedef (typedef uint16 SetShareholderProposal_output): the io name is a region address, so
      if ((expr.name === "input" || expr.name === "output") && !ctx.localVars.has(expr.name)) {
        const io = resolveAddr(ctx, expr);
        if (io && io.size > 0 && io.size <= 8 && (!io.layout || io.layout.fields.size === 0)) {
          return loadAtIr(io.addr, io.size, isSignedScalarType(io.type, ctx.cg));
        }
      }
      // a named constant: enum constant or constexpr (incl. qualified Type::NAME)
      const c = ctx.cg.resolveConst(expr.name);
      if (c !== null) return ir.i64c(c);
      ctx.cg.warn(`unknown identifier '${expr.name}'`, expr.span);
      return ir.i64c(0);
    }
    case "member_access": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAtIr(n.addr, n.size, isSignedScalarType(n.type, ctx.cg));
      if (n) {
        ctx.cg.warn(`aggregate value read unsupported [${describeShape(expr)}]`, expr.span.line);
        return ir.i64c(0);
      }
      // a static constexpr member of the object's type (pv.maxProposals / pv.maxVotes on ProposalVoting<P,D>): not a runtime field, so
      const obj = resolveAddr(ctx, expr.object);
      let ot: TypeSpec | null = obj?.type ?? null;
      for (let i = 0; i < 8 && ot?.kind === "name"; i++) ot = ctx.cg.typedefs.get(ot.name) ?? null;
      if (ot?.kind === "template_instance") {
        const sc = ctx.cg.staticConstsOf(ot.name, ctx.cg.bindContainer(ot.name, ot.args));
        if (sc.has(expr.member)) return ir.i64c(sc.get(expr.member)!);
      }
      // the same static constexpr read through an inline-typed object (data.variableScalar carries its union/struct decl inline): fold the member's
      if (ot?.kind === "inline_struct") {
        const sm = ot.struct.members.find(
          (m) => m.kind === "variable" && (m as VariableDecl).name === expr.member
            && ((m as VariableDecl).isStatic || (m as VariableDecl).isConstexpr) && (m as VariableDecl).init,
        ) as VariableDecl | undefined;
        if (sm?.init) {
          try {
            return ir.i64c(ctx.cg.evalConstBig(sm.init, ctx.thisBind ?? NO_BIND));
          } catch {
            /* not foldable under these bindings — fall through to the warning */
          }
        }
      }
      // qpi.invocationReward() etc. handled in call; bare member returns 0
      ctx.cg.warn(`unsupported member read [${describeShape(expr)}]`, expr.span.line);
      return ir.i64c(0);
    }
    case "subscript": {
      const n = resolveAddr(ctx, expr);
      if (n && n.size <= 8) return loadAtIr(n.addr, n.size, isSignedScalarType(n.type, ctx.cg));
      ctx.cg.warn(`unsupported subscript value`, (expr as any).span?.line ?? 0);
      return ir.i64c(0);
    }
    case "call": {
      const inline = emitInlineStructValue(ctx, expr);
      return inline ?? emitCallValueIr(ctx, expr);
    }
    case "template_call": {
      if (expr.callee.kind === "identifier") {
        const name = expr.callee.name;
        // C++ cast spelled as a template call. static_cast narrows to its target width; reinterpret_cast/
        if ((name === "static_cast" || name === "reinterpret_cast" || name === "const_cast") && expr.args[0]) {
          const inner = emitValueIr(ctx, expr.args[0]);
          const tgt = expr.templateArgs?.[0];
          return name === "static_cast" && tgt?.kind === "name" ? narrowCastIr(inner, tgt.name) : inner;
        }
        const helper = emitHelperCall(ctx, expr as unknown as Expression & { kind: "call" }, true);
        if (helper !== null) return ir.raw(helper, "i64", "source-compiled template helper");
      }
      if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
        if (expr.callee.member === "__qpiQueryOracle" || expr.callee.member === "__qpiSubscribeOracle") {
          const o = emitOracleQueryCall(ctx, expr);
          if (o !== null) return ir.raw(o, "i64", "unconverted: oracle call");
        }
        if (expr.callee.member === "getOracleQuery" || expr.callee.member === "getOracleReply") {
          const o = emitOracleReadCall(ctx, expr);
          if (o !== null) return o;
        }
      }
      ctx.cg.warn(`unsupported template_call '${expr.callee.kind === "identifier" ? expr.callee.name : "?"}' as value`, expr.span.line);
      return ir.i64c(0);
    }
    case "binary_op":
      return emitBinaryIr(ctx, expr);
    case "unary_op": {
      // *ptr as a value: load the pointee through the pointer's held address.
      if (expr.op === "*") {
        const n = resolveAddr(ctx, expr);
        if (n && n.size <= 8) {
          return loadAtIr(n.addr, n.size, isSignedScalarType(n.type, ctx.cg));
        }
      }
      const a = emitValueIr(ctx, expr.arg);
      // A 32-bit result wraps at 32 bits, so - and ~ reduce back to the canonical form: mask
      const info = scalarTypeInfo(ctx, expr);
      const mask32 = info !== null && info.width === 4 && info.unsigned;
      const sext32 = info !== null && info.width === 4 && !info.unsigned;
      const canon32 = (n: ir.Ir) =>
        mask32 ? ir.op("i64.and", n, ir.i64c("0xffffffff")) : sext32 ? ir.op("i64.extend32_s", n) : n;
      switch (expr.op) {
        case "-": {
          return canon32(ir.op("i64.sub", ir.i64c(0), a));
        }
        case "~": {
          return canon32(ir.op("i64.xor", a, ir.i64c(-1)));
        }
        case "!": return ir.op("i64.extend_i32_u", ir.op("i64.eqz", a));
        default: return a;
      }
    }
    case "prefix_op": {
      // ++x / --x as a value: apply in place (as a side-effect line), then yield the new value.
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return emitValueIr(ctx, expr.arg);
    }
    case "postfix_op": {
      // x++ / x-- as a value: capture the old value, then apply — the expression evaluates to the old.
      const t = newValueTmp(ctx);
      ctx.lines.push(`    ${ir.emit(ir.setL(t, emitValueIr(ctx, expr.arg)))}`);
      const w = emitIncDec(ctx, expr);
      if (w) ctx.lines.push(`    ${w}`);
      return ir.getL(t, "i64");
    }
    case "ternary": {
      // C++ evaluates the condition, then exactly ONE arm. wasm select is eager, so it is only safe
      const cv = usualConversion(ctx, expr.then, expr.else_);
      const cvName = cv.width < 8 ? (cv.unsigned ? "uint32" : "sint32") : undefined;
      const cond = emitValueIr(ctx, expr.cond);
      const saved = ctx.lines;
      ctx.lines = [];
      const thenV = emitValueIr(ctx, expr.then);
      const thenLines = ctx.lines;
      ctx.lines = [];
      const elseV = emitValueIr(ctx, expr.else_);
      const elseLines = ctx.lines;
      ctx.lines = saved;
      if (thenLines.length === 0 && elseLines.length === 0 && ir.pureIr(thenV) && ir.pureIr(elseV)) {
        return narrowCastIr(ir.selectV(thenV, elseV, ir.op("i64.ne", ir.i64c(0), cond)), cvName);
      }
      const t = newValueTmp(ctx);
      const thenB = [...thenLines, `      ${setLocal(ctx, t, thenV)}`].join("\n");
      const elseB = [...elseLines, `      ${setLocal(ctx, t, elseV)}`].join("\n");
      ctx.lines.push(`    (if (i64.ne (i64.const 0) ${ir.emit(cond)}) (then\n${thenB}\n    ) (else\n${elseB}\n    ))`);
      return narrowCastIr(ir.getL(t, "i64"), cvName);
    }
    case "c_cast":
    case "static_cast":
      return narrowCastIr(emitValueIr(ctx, expr.expr), expr.type?.kind === "name" ? expr.type.name : undefined);
    case "construct": {
      const t = ctx.cg.scalarStorageType(expr.type);
      if (t.kind === "name" && SCALAR_SIZE[t.name] !== undefined && SCALAR_SIZE[t.name] <= 8) {
        return narrowCastIr(expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0), t.name);
      }
      ctx.cg.warn(`aggregate construction used as a scalar value`, expr.span);
      return ir.i64c(0);
    }
    case "initializer_list":
      return expr.exprs.length === 1 ? emitValueIr(ctx, expr.exprs[0]) : ir.i64c(0);
    case "sizeof_type":
      return ir.i64c(ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND));
    case "sizeof_expr": {
      // sizeof someLvalue — e.g. sizeof(*this) (the container).
      const n = resolveAddr(ctx, expr.expr);
      if (n) return ir.i64c(n.size);
      const scalar = scalarTypeInfo(ctx, expr.expr);
      if (scalar) return ir.i64c(scalar.width);
      // sizeof(TypeName) parses here when the operand is a bare type (e.g. sizeof(Element)) rather than
      if (expr.expr.kind === "identifier") {
        const sz = ctx.cg.sizeOfType({ kind: "name", name: expr.expr.name }, ctx.thisBind ?? NO_BIND);
        if (sz > 0) return ir.i64c(sz);
      }
      ctx.cg.warn(`unsupported sizeof expr`, expr.span.line);
      return ir.i64c(0);
    }
    case "assign": {
      // assignment used as a value — `while ((i = next()) >= 0)`, `a = b = 0`. Perform
      emitAssign(ctx, expr);
      return emitValueIr(ctx, expr.left);
    }
    default:
      ctx.cg.warn(`unsupported expression '${expr.kind}' as value`, (expr as any).span?.line ?? 0);
      return ir.i64c(0);
  }
}

export function emitValue(ctx: FnCtx, expr: Expression): string {
  return ir.emit(emitValueIr(ctx, expr));
}

// Address+size of an operand that is an aggregate (id/m256i/struct): a struct-field lvalue, or a materialized id producer (SELF
export function aggOperand(ctx: FnCtx, expr: Expression): { addr: string; size: number } | null {
  const n = resolveAddr(ctx, expr);
  if (n) return n.size > 8 ? { addr: n.addr, size: n.size } : null;
  const a = emitAddr(ctx, expr);
  return a ? { addr: a, size: 32 } : null;
}

// Whether an expression is uint128-typed (so it flows as a 16-byte value through source-compiled methods rather than
export function isU128Expr(ctx: FnCtx, expr: Expression): boolean {
  if (expr.kind === "paren") return isU128Expr(ctx, expr.expr);
  if (expr.kind === "construct") return isUint128(ctx.cg, expr.type);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") {
    const t = (expr as any).type;
    if (t?.kind === "name" && (t.name === "uint128" || t.name === "uint128_t")) return true;
    return isU128Expr(ctx, expr.expr);
  }
  if (expr.kind === "ternary") return isU128Expr(ctx, expr.then) || isU128Expr(ctx, expr.else_);
  if (expr.kind === "template_call" && expr.callee.kind === "identifier") {
    const base = symbolBaseName((expr.callee as any).name);
    if ((base === "div" || base === "mod") && MATH_INTRINSIC_NAMES.has(base) && expr.args.length === 2) {
      const ta = expr.templateArgs?.[0];
      if (ta?.kind === "name" && (ta.name === "uint128" || ta.name === "uint128_t")) return true;
      return isU128Expr(ctx, expr.args[0]) || isU128Expr(ctx, expr.args[1]);
    }
  }
  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const nm = expr.callee.name;
    if (nm === "uint128" || nm === "uint128_t") return true;
    const bound = ctx.thisBind?.types.get(nm);
    if (bound && isUint128(ctx.cg, bound)) return true;
    const base = symbolBaseName(nm);
    if ((base === "div" || base === "mod") && MATH_INTRINSIC_NAMES.has(base) && expr.args.length === 2) {
      return isU128Expr(ctx, expr.args[0]) || isU128Expr(ctx, expr.args[1]);
    }
  }
  if (expr.kind === "binary_op") {
    if (expr.op === "<<" || expr.op === ">>") return isU128Expr(ctx, expr.left);
    if (expr.op === "*" || expr.op === "/" || expr.op === "+" || expr.op === "-" || expr.op === "&" || expr.op === "|" || expr.op === "^")
      return isU128Expr(ctx, expr.left) || isU128Expr(ctx, expr.right);
    return false;
  }

  // Method calls: answer from the DECLARED return type. Falling through to resolveAddr would
  if (expr.kind === "call" && expr.callee.kind === "member_access") {
    const obj = resolveAddr(ctx, expr.callee.object);
    let ot: TypeSpec | null = obj?.type ?? null;
    for (let i = 0; i < 8 && ot?.kind === "name"; i++) {
      const next = ctx.thisBind?.types.get(ot.name) ?? ctx.cg.typedefs.get(ot.name);
      if (!next) break;
      ot = next;
    }

    if (ot?.kind === "template_instance") {
      const mt = ctx.cg.methodTemplate(ot.name, ot.args, expr.callee.member, expr.args.length);
      if (mt?.def.returnType) {
        return isUint128(ctx.cg, ctx.cg.substInBindings(ctx.cg.derefType(mt.def.returnType), mt.bind));
      }
    }
    const struct = ot ? ctx.cg.structOf(ot, ctx.thisBind ?? NO_BIND) : null;
    const fn = struct?.members.find(
      (m) => m.kind === "function" && (m as FunctionDecl).name === (expr.callee as Expression & { kind: "member_access" }).member,
    ) as FunctionDecl | undefined;
    if (fn?.returnType) {
      return isUint128(ctx.cg, fn.returnType);
    }
  }

  const n = resolveAddr(ctx, expr);
  return !!(n && isUint128(ctx.cg, n.type));
}

// Materialize a uint128 expression into a fresh 16-byte slot (low@0, high@8) and return its address; an existing uint128
const U128_CLASS: TypeSpec & { kind: "template_instance" } = {
  kind: "template_instance",
  name: "uint128_t",
  args: [],
};

function constructU128(ctx: FnCtx, args: Expression[]): ir.Ir {
  const destination = allocSlotIr(ctx, 16);
  const compiled = callCompiled(ctx, U128_CLASS, "uint128_t", ir.emit(destination), args);
  if (!compiled || compiled.cm.retKind !== "void") {
    throw new Error("authoritative uint128_t constructor could not be lowered");
  }
  ctx.lines.push(`    ${compiled.call}`);
  return destination;
}

function u128ConstructorExpr(expr: Expression): Expression {
  return {
    kind: "call",
    callee: { kind: "identifier", name: "uint128_t", span: expr.span },
    args: [expr],
    span: expr.span,
  };
}

function sourceU128Result(ctx: FnCtx, method: string, self: ir.Ir, args: Expression[], paramTypeKey?: string): ir.Ir {
  const compiled = callCompiled(ctx, U128_CLASS, method, ir.emit(self), args, paramTypeKey);
  if (!compiled) throw new Error(`authoritative uint128_t::${method} could not be lowered`);
  if (compiled.retDest) {
    ctx.lines.push(`    ${compiled.call}`);
    return ir.raw(compiled.retDest, "i32", "source-compiled uint128 aggregate result");
  }
  if (compiled.cm.retKind === "i64") return ir.raw(compiled.call, "i64", "source-compiled uint128 scalar result");
  if (compiled.cm.retKind === "i32") return ir.raw(compiled.call, "i32", "source-compiled uint128 reference result");
  ctx.lines.push(`    ${compiled.call}`);
  throw new Error(`void uint128_t::${method} used as a value`);
}

// Materialize a uint128 expression into a 16-byte slot (low@0, high@8). Arithmetic and
// comparisons are instantiated from the authoritative platform/uint128.h method bodies.
export function emitU128Ir(ctx: FnCtx, expr: Expression): ir.Ir {
  if (expr.kind === "paren") return emitU128Ir(ctx, expr.expr);
  if (expr.kind === "initializer_list") return constructU128(ctx, expr.exprs);
  if (expr.kind === "construct" && isUint128(ctx.cg, expr.type)) return constructU128(ctx, expr.args);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") {
    if (isU128Expr(ctx, expr.expr)) return emitU128Ir(ctx, expr.expr);
    return constructU128(ctx, [expr.expr]);
  }

  const n = resolveAddr(ctx, expr);
  if (n && isUint128(ctx.cg, n.type)) return ir.raw(n.addr, "i32", "lvalue address channel");

  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const bound = ctx.thisBind?.types.get(expr.callee.name);
    const constructor = expr.callee.name === "uint128" || expr.callee.name === "uint128_t" ||
      (bound ? isUint128(ctx.cg, bound) : false);
    if (constructor) return constructU128(ctx, expr.args);

    if (symbolBaseName(expr.callee.name) === "div" && MATH_INTRINSIC_NAMES.has("div") && expr.args.length === 2) {
      const helper = lookupHelper(ctx, expr);
      if (!helper?.retAgg || helper.retAgg !== 16) {
        throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
      }
      return ir.raw(emitAggHelperCall(ctx, expr, helper), "i32", "source-compiled uint128 div result");
    }
  }

  if (expr.kind === "template_call" && expr.callee.kind === "identifier" &&
      symbolBaseName(expr.callee.name) === "div" && MATH_INTRINSIC_NAMES.has("div") && expr.args.length === 2) {
    const callExpr = expr as unknown as Expression & { kind: "call" };
    const helper = lookupHelper(ctx, callExpr);
    if (!helper?.retAgg || helper.retAgg !== 16) {
      throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
    }
    return ir.raw(emitAggHelperCall(ctx, callExpr, helper), "i32", "source-compiled uint128 div result");
  }

  if (expr.kind === "ternary") {
    const destination = allocSlotIr(ctx, 16);
    ctx.lines.push(`    (if ${ir.emit(ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.cond)))} (then`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", destination, emitU128Ir(ctx, expr.then), ir.i32c(16)))}`);
    ctx.lines.push("    ) (else");
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", destination, emitU128Ir(ctx, expr.else_), ir.i32c(16)))}`);
    ctx.lines.push("    ))");
    return destination;
  }

  if (expr.kind === "binary_op") {
    // The pinned uint128_t class has no |/^ overloads. Keep these representation-level bitwise
    // operations as compiler primitives; every defined class operator below is source-compiled.
    if (expr.op === "|" || expr.op === "^") {
      const destination = allocSlotIr(ctx, 16);
      const left = emitU128Ir(ctx, expr.left);
      const right = emitU128Ir(ctx, expr.right);
      const opcode = expr.op === "|" ? "i64.or" : "i64.xor";
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, destination, ir.op(opcode, ir.loadRaw("i64.load", null, left), ir.loadRaw("i64.load", null, right))))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", 8, destination, ir.op(opcode, ir.loadRaw("i64.load", 8, left), ir.loadRaw("i64.load", 8, right))))}`);
      return destination;
    }

    const method = ["+", "-", "*", "/", "&", "<<", ">>"].includes(expr.op) ? `operator${expr.op}` : null;
    if (method) {
      const left = emitU128Ir(ctx, expr.left);
      const scalarRight = !isU128Expr(ctx, expr.right);
      // platform/uint128.h defines scalar overloads only for `& int` and `>> unsigned
      // int`. Every other scalar operand reaches the uint128_t overload through the
      const key = scalarRight && expr.op === "&" ? "int"
        : scalarRight && expr.op === ">>" ? "unsigned int"
          : "uint128_t";
      const right = key === "uint128_t" && scalarRight ? u128ConstructorExpr(expr.right) : expr.right;
      return sourceU128Result(ctx, method, left, [right], key);
    }
  }

  return constructU128(ctx, [expr]);
}
export function emitU128(ctx: FnCtx, expr: Expression): string {
  return ir.emit(emitU128Ir(ctx, expr));
}

// True for `auto` (or `auto*`) type specs, which take their real type from the initializer.
export function isAutoType(t: TypeSpec): boolean {
  if (t.kind === "pointer") {
    return isAutoType(t.pointee);
  }
  return t.kind === "name" && t.name === "auto";
}

// Resolve a named type through typedef/using aliases to its underlying spec (bounded walk; stops at a known scalar
export function resolveAliasType(cg: Codegen, t: TypeSpec): TypeSpec {
  let r = t;
  for (let i = 0; i < 8 && r.kind === "name" && SCALAR_SIZE[r.name] === undefined; i++) {
    const td = cg.typedefs.get(r.name);
    if (!td || td.kind === "void") {
      break;
    }
    r = td;
  }
  return r;
}

// True if a scalar type is unsigned (uint*/unsigned/size_t-like). Drives signed-vs-unsigned op selection.
export function unsignedScalar(t: TypeSpec | null | undefined): boolean {
  if (!t) return false;
  if (t.kind === "const") return unsignedScalar(t.valueType);
  if (t.kind === "reference") return unsignedScalar(t.refereed);
  if (t.kind === "pointer") return false;
  if (t.kind !== "name") return false;
  return /^(uint|unsigned\b|size_t$|bool$|bit$)/.test(t.name) || t.name === "uint128" || t.name === "uint128_t";
}

// Best-effort signedness is unsigned when unsigned lvalue/params, casts, or suffixed literals are present.
export function isUnsignedExpr(ctx: FnCtx, expr: Expression): boolean {
  switch (expr.kind) {
    case "c_cast": case "static_cast": return unsignedScalar(expr.type);
    case "paren": return isUnsignedExpr(ctx, expr.expr);
    case "int_literal": return /[uU]/.test(expr.suffix ?? "");
    case "identifier": {
      const p = ctx.params?.get(expr.name);
      if (p) return unsignedScalar(ctx.cg.scalarStorageType(p.type));
      const rl = ctx.refLocals?.get(expr.name);
      if (rl) return unsignedScalar(ctx.cg.scalarStorageType(rl));
      const lv = ctx.localVars.get(expr.name)?.type;
      if (lv) return unsignedScalar(ctx.cg.scalarStorageType(lv));
      const constant = ctx.cg.typeOfConstant(expr.name);
      if (constant) return unsignedScalar(ctx.cg.scalarStorageType(constant));
      const addrType = resolveAddr(ctx, expr)?.type;
      return addrType ? unsignedScalar(ctx.cg.scalarStorageType(addrType)) : false;
    }
    case "member_access": case "subscript": {
      const t = resolveAddr(ctx, expr)?.type ?? null;
      if (t?.kind === "name" && t.name === "DateAndTime") return true; // compares via its packed uint64 value
      return t ? unsignedScalar(ctx.cg.scalarStorageType(t)) : false;
    }
    case "call":
      // qpi out-producers read as scalars are packed uint64 values (qpi.now() → DateAndTime.value)
      return expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier"
        && expr.callee.object.name === "qpi" && QPI_CALLS[expr.callee.member]?.ret === "out";
    case "binary_op":
      if (["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"].includes(expr.op))
        return isUnsignedExpr(ctx, expr.left) || isUnsignedExpr(ctx, expr.right);
      return false;
    case "unary_op":
      if (expr.op === "-" || expr.op === "~" || expr.op === "+")
        return isUnsignedExpr(ctx, expr.arg);
      return false;
    case "prefix_op": case "postfix_op": return isUnsignedExpr(ctx, expr.arg);
    case "ternary": return isUnsignedExpr(ctx, expr.then) || isUnsignedExpr(ctx, expr.else_);
    default: return false;
  }
}

// Best-effort (byte width, signedness) of a scalar expression, mirroring isUnsignedExpr's coverage.
export function scalarTypeInfo(ctx: FnCtx, expr: Expression): { width: number; unsigned: boolean } | null {
  switch (expr.kind) {
    case "paren": return scalarTypeInfo(ctx, expr.expr);
    case "c_cast": case "static_cast": {
      const n = expr.type?.kind === "name" ? expr.type.name : null;
      const sz = n ? SCALAR_SIZE[n] : undefined;
      return sz ? { width: sz, unsigned: unsignedScalar(expr.type) } : null;
    }
    case "int_literal": {
      // C++ literal typing: int → (uint for hex/octal) → long long by fit; a u/U suffix forces unsigned
      const v = ctx.cg["sema"].evaluateConstexpr(expr) ?? 0n;
      const suffixU = /[uU]/.test(expr.suffix ?? "");
      const suffixL = /[lL]/.test(expr.suffix ?? "");
      const hex = /^0[xX0-7]/.test(expr.value ?? "");
      if (suffixL) return { width: 8, unsigned: suffixU };
      if (v >= -(2n ** 31n) && v < 2n ** 31n) return { width: 4, unsigned: suffixU };
      if (suffixU && v < 2n ** 32n) return { width: 4, unsigned: true };
      if (hex && v < 2n ** 32n) return { width: 4, unsigned: true };
      if (!suffixU && v < 2n ** 63n) return { width: 8, unsigned: false };
      return { width: 8, unsigned: true };
    }
    case "identifier": case "member_access": case "subscript": {
      const t = expr.kind === "identifier"
        ? (ctx.params?.get(expr.name)?.type ?? ctx.refLocals?.get(expr.name) ?? ctx.localVars.get(expr.name)?.type ?? ctx.cg.typeOfConstant(expr.name) ?? resolveAddr(ctx, expr)?.type ?? null)
        : (resolveAddr(ctx, expr)?.type ?? null);
      let c = t;
      if (c?.kind === "const") c = c.valueType;
      if (c?.kind === "reference") c = c.refereed;
      if (c) c = ctx.cg.scalarStorageType(c);
      const sz = c?.kind === "name" ? SCALAR_SIZE[c.name] : undefined;
      return sz ? { width: sz, unsigned: unsignedScalar(c) } : null;
    }
    case "binary_op": {
      if (["+", "-", "*", "/", "%", "&", "|", "^"].includes(expr.op)) {
        const cv = usualConversion(ctx, expr.left, expr.right);
        return { width: cv.width, unsigned: cv.unsigned };
      }
      if (expr.op === "<<" || expr.op === ">>") return promoteInfo(ctx, expr.left);
      // Comparisons and logical ops yield bool, which promotes to int.
      if (["<", ">", "<=", ">=", "==", "!=", "&&", "||"].includes(expr.op)) return { width: 4, unsigned: false };
      return null;
    }
    // The C++ common type of the two arms (condition contributes nothing).
    case "ternary": {
      const cv = usualConversion(ctx, expr.then, expr.else_);
      return { width: cv.width, unsigned: cv.unsigned };
    }
    case "unary_op": {
      if (expr.op === "-" || expr.op === "~" || expr.op === "+") return promoteInfo(ctx, expr.arg);
      if (expr.op === "!") return { width: 4, unsigned: false };
      return null;
    }
    // ++x / x++ yield the operand's own type (no promotion).
    case "prefix_op": case "postfix_op": return scalarTypeInfo(ctx, expr.arg);
    case "call": case "template_call": {
      // QPI safe-math intrinsics return their (deduced or explicit) argument type; without this a comparison against e.g. `math_lib::max((uint64)a, (uint64)b)`
      const nm = expr.callee?.kind === "identifier" ? expr.callee.name : null;
      if (!nm) return null;
      const base = nm.includes("::") ? nm.slice(nm.lastIndexOf("::") + 2) : nm;
      if (!MATH_INTRINSIC_NAMES.has(base)) {
        // A member value helper carries its declared return type; the width/signedness of `pick(x) + 1` etc. follow the
        const set = ctx.cg.helperOverloads.get(nm);
        const h = set?.length ? pickHelperOverload(ctx, set, expr.args ?? []) : ctx.cg.helpers.get(nm);
        const rt = h?.retType;
        const sz = rt?.kind === "name" ? SCALAR_SIZE[rt.name] : undefined;
        if (sz !== undefined && sz <= 8) return { width: sz, unsigned: unsignedScalar(rt) };
        return null;
      }
      if (expr.kind === "template_call" && expr.templateArgs?.[0]?.kind === "name") {
        const sz = SCALAR_SIZE[expr.templateArgs[0].name];
        if (sz) return { width: sz, unsigned: unsignedScalar(expr.templateArgs[0]) };
      }
      const a0 = expr.args?.[0], a1 = expr.args?.[1];
      if (base === "abs") return a0 ? promoteInfo(ctx, a0) : null;
      if (!a0 || !a1) return null;
      const cv = usualConversion(ctx, a0, a1);
      return base === "sdiv" ? { width: cv.width, unsigned: false } : cv;
    }
    default: return null;
  }
}

// Integral promotion: sub-int scalars become int (signed, 4 bytes); unknown types fall back to the legacy 64-bit +
export function promoteInfo(ctx: FnCtx, expr: Expression): { width: number; unsigned: boolean } {
  const info = scalarTypeInfo(ctx, expr) ?? { width: 8, unsigned: isUnsignedExpr(ctx, expr) };
  if (info.width < 4) return { width: 4, unsigned: false };
  return info;
}

// C++ usual arithmetic conversions over the promoted operands: same signedness → wider wins; mixed → unsigned wins at
export function usualConversion(ctx: FnCtx, left: Expression, right: Expression): { width: number; unsigned: boolean } {
  const l = promoteInfo(ctx, left);
  const r = promoteInfo(ctx, right);
  const width = Math.max(l.width, r.width);
  if (l.unsigned === r.unsigned) return { width, unsigned: l.unsigned };
  const u = l.unsigned ? l : r;
  const s = l.unsigned ? r : l;
  return u.width >= s.width ? { width, unsigned: true } : { width, unsigned: false };
}

export function emitBinaryIr(ctx: FnCtx, expr: Expression & { kind: "binary_op" }): ir.Ir {
  // uint128 comparisons instantiate the corresponding platform/uint128.h operator body.
  if ((expr.op === "==" || expr.op === "!=" || expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=")
    && (isU128Expr(ctx, expr.left) || isU128Expr(ctx, expr.right))) {
    const left = emitU128Ir(ctx, expr.left);
    const method = expr.op === "!=" ? "operator==" : `operator${expr.op}`;
    const right = isU128Expr(ctx, expr.right) ? expr.right : u128ConstructorExpr(expr.right);
    const result = sourceU128Result(ctx, method, left, [right], "uint128_t");
    if (result.ty !== "i64") throw new Error(`uint128_t::${method} did not return a scalar`);
    return expr.op === "!=" ? ir.op("i64.extend_i32_u", ir.op("i64.eqz", result)) : result;
  }

  // id/struct equality compares bytes, not an i64 value.
  if (expr.op === "==" || expr.op === "!=") {
    const la = aggOperand(ctx, expr.left);
    const ra = aggOperand(ctx, expr.right);
    if (la && ra) {
      const eq = ir.call("$memeq", ir.raw(la.addr, "i32", "lvalue address channel"), ir.raw(ra.addr, "i32", "lvalue address channel"), ir.i32c(Math.min(la.size, ra.size)));
      return expr.op === "==" ? ir.op("i64.extend_i32_u", eq) : ir.op("i64.extend_i32_u", ir.op("i32.eqz", eq));
    }
  }

  // id/m256i ordering is a 256-bit lexicographic compare of 4 u64 limbs.
  if (expr.op === "<" || expr.op === ">" || expr.op === "<=" || expr.op === ">=") {
    const la = aggOperand(ctx, expr.left);
    const ra = aggOperand(ctx, expr.right);
    if (la && ra && la.size === 32 && ra.size === 32) {
      const lt = (x: { addr: string }, y: { addr: string }) =>
        ir.call("$m256_lt", ir.raw(x.addr, "i32", "lvalue address channel"), ir.raw(y.addr, "i32", "lvalue address channel"));
      if (expr.op === "<") return ir.op("i64.extend_i32_u", lt(la, ra));
      if (expr.op === ">") return ir.op("i64.extend_i32_u", lt(ra, la));
      if (expr.op === "<=") return ir.op("i64.extend_i32_u", ir.op("i32.eqz", lt(ra, la)));
      return ir.op("i64.extend_i32_u", ir.op("i32.eqz", lt(la, ra)));
    }
  }

  // Short-circuit `&&` / `||`: the right operand must not be evaluated when the left already decides the result
  if (expr.op === "&&" || expr.op === "||") {
    const lb = ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.left));
    const saved = ctx.lines;
    ctx.lines = [];
    const rExpr = emitValueIr(ctx, expr.right);
    const rLines = ctx.lines;
    ctx.lines = saved;
    const rb = ir.op("i64.ne", ir.i64c(0), rExpr);
    if (rLines.length === 0) {
      return expr.op === "||"
        ? ir.raw(`(i64.extend_i32_u (if (result i32) ${ir.emit(lb)} (then (i32.const 1)) (else ${ir.emit(rb)})))`, "i64", "inline if-expression")
        : ir.raw(`(i64.extend_i32_u (if (result i32) ${ir.emit(lb)} (then ${ir.emit(rb)}) (else (i32.const 0))))`, "i64", "inline if-expression");
    }
    const tmp = newTmp(ctx);
    const rBranch = [...rLines, `      (local.set $${tmp} ${ir.emit(rb)})`].join("\n");
    if (expr.op === "||") {
      ctx.lines.push(`    (if ${ir.emit(lb)} (then (local.set $${tmp} (i32.const 1))) (else\n${rBranch}\n    ))`);
    } else {
      ctx.lines.push(`    (if ${ir.emit(lb)} (then\n${rBranch}\n    ) (else (local.set $${tmp} (i32.const 0))))`);
    }
    return ir.op("i64.extend_i32_u", ir.getL(tmp, "i32"));
  }

  const l = emitValueIr(ctx, expr.left);
  const r = emitValueIr(ctx, expr.right);
  // C++ usual arithmetic conversions decide the operation's signedness and rank. A 32-bit result
  const cv = usualConversion(ctx, expr.left, expr.right);
  const u = cv.unsigned;
  const li = promoteInfo(ctx, expr.left);
  const wrapL = (n: ir.Ir, active: boolean) => (active ? ir.op("i64.and", n, ir.i64c("0xffffffff")) : n);
  const wrapS = (n: ir.Ir, active: boolean) => (active ? ir.op("i64.extend32_s", n) : n);
  const wrap32 = u && cv.width === 4;
  const swrap32 = !u && cv.width === 4;
  const shiftCount = (n: ir.Ir) => (li.width === 4 ? ir.op("i64.and", n, ir.i64c(31)) : n);

  // Signed-to-unsigned 32-bit converts by sign extension rules, so / and % follow unsigned arithmetic semantics.
  const toU32 = (n: ir.Ir, e: Expression) => {
    if (!wrap32) {
      return n;
    }
    const pi = promoteInfo(ctx, e);
    return pi.width === 4 && !pi.unsigned ? ir.op("i64.and", n, ir.i64c("0xffffffff")) : n;
  };
  const lc = toU32(l, expr.left);
  const rc = toU32(r, expr.right);
  const cmp = (op: string) => ir.op("i64.extend_i32_u", ir.op(op, lc, rc));

  switch (expr.op) {
    case "+": return wrapS(wrapL(ir.op("i64.add", l, r), wrap32), swrap32);
    case "-": return wrapS(wrapL(ir.op("i64.sub", l, r), wrap32), swrap32);
    case "*": return wrapS(wrapL(ir.op("i64.mul", l, r), wrap32), swrap32);
    case "/": return ir.op(u ? "i64.div_u" : "i64.div_s", lc, rc);
    case "%": return ir.op(u ? "i64.rem_u" : "i64.rem_s", lc, rc);
    case "<<": {
      const sh = ir.op("i64.shl", l, shiftCount(r));
      return li.width === 4 ? (li.unsigned ? wrapL(sh, true) : wrapS(sh, true)) : sh;
    }
    // Signed right-shift is arithmetic in C++ — zero-filling a negative sint64 silently corrupts it.
    case ">>": return ir.op(li.unsigned ? "i64.shr_u" : "i64.shr_s", l, shiftCount(r));
    case "&": return ir.op("i64.and", l, r);
    case "|": return wrapL(ir.op("i64.or", l, r), wrap32);
    case "^": return wrapL(ir.op("i64.xor", l, r), wrap32);
    case "==": return cmp("i64.eq");
    case "!=": return cmp("i64.ne");
    case "<": return cmp(u ? "i64.lt_u" : "i64.lt_s");
    case ">": return cmp(u ? "i64.gt_u" : "i64.gt_s");
    case "<=": return cmp(u ? "i64.le_u" : "i64.le_s");
    case ">=": return cmp(u ? "i64.ge_u" : "i64.ge_s");
    default: return ir.i64c(0);
  }
}
