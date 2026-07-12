import { SCALAR_SIZE } from "./tables";
import { emitProposalProxyAddr } from "./calls/proxy";
import { qpiWrapperMethod } from "./calls/dispatch";
import { emitAssetIter, classifyMethodParam, callCompiled, compileContainerMethod } from "./calls/containers";
import { platformPrimitive } from "./platform-primitives";
import { lookupHelper, emitAggHelperCall } from "./calls/libfn";
import { newTmp, collectLocals, emitStmt } from "./stmt";
import { QPI_CALLS, emitQpiCall } from "./calls/qpi";
import { emitValue, isU128Expr, emitU128, emitValueIr, aggOperand } from "./value";
import { Codegen } from "./cg";
import { StructLayout, FieldLayout, FnCtx, AddrNode, NO_BIND, Lvalue } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import * as ir from "../ir";

// ---- lvalue addressing ----

// True if `state.get()` / `state.mut()`.
export function isStateAccessor(expr: Expression): boolean {
  return expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "state" &&
    (expr.callee.member === "mut" || expr.callee.member === "get");
}

// id/m256i expose their 32 bytes as fixed-width limb views (`.u64`/`.u32`/`.u16`/`.u8`) with named limbs `_0.._N` at element-sized strides. Each
export function limbLayout(elemSize: number, count: number): StructLayout {
  const t: TypeSpec = { kind: "name", name: elemSize === 8 ? "uint64" : elemSize === 4 ? "uint32" : elemSize === 2 ? "uint16" : "uint8" };
  const fields = new Map<string, FieldLayout>();
  for (let i = 0; i < count; i++) fields.set(`_${i}`, { name: `_${i}`, offset: i * elemSize, size: elemSize, type: t });
  return { size: elemSize * count, align: elemSize, fields };
}
export const ID_VIEWS: Record<string, StructLayout> = {
  u64: limbLayout(8, 4), u32: limbLayout(4, 8), u16: limbLayout(2, 16), u8: limbLayout(1, 32),
};
export function isIdLike(cg: Codegen, t: TypeSpec | null): boolean {
  if (!t) return false;
  const d = cg.derefType(t);
  return d.kind === "name" && (d.name === "id" || d.name === "m256i");
}
export function isUint128(cg: Codegen, t: TypeSpec | null): boolean {
  if (!t) return false;
  const d = cg.derefType(t);
  return (d.kind === "name" || d.kind === "template_instance") && (d.name === "uint128" || d.name === "uint128_t");
}

// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
export function castInfo(e: Expression): { type: TypeSpec; operand: Expression } | null {
  if (e.kind === "static_cast" || e.kind === "c_cast" || e.kind === "reinterpret_cast") return { type: e.type, operand: e.expr };
  if (e.kind === "template_call" && e.callee.kind === "identifier" && /^(static|reinterpret|const)_cast$/.test(e.callee.name) && e.templateArgs?.[0] && e.args?.[0]) {
    return { type: e.templateArgs[0], operand: e.args[0] };
  }
  return null;
}

export function stripPtrRefConst(t: TypeSpec): TypeSpec {
  while (t.kind === "pointer" || t.kind === "reference" || t.kind === "const") {
    t = t.kind === "pointer" ? t.pointee : t.kind === "reference" ? t.refereed : t.valueType;
  }
  return t;
}

export function resolveAddr(ctx: FnCtx, expr: Expression): AddrNode | null {
  if (expr.kind === "paren") return resolveAddr(ctx, expr.expr);
  // __ScopedScratchpad.ptr → the held scratch buffer base (the local's value). `reinterpret_cast<T*>(sp.ptr)`
  if (expr.kind === "member_access" && expr.member === "ptr" &&
    expr.object.kind === "identifier" && ctx.scratchpadLocals?.has(expr.object.name)) {
    return { addr: `(local.get $${expr.object.name})`, type: { kind: "pointer", pointee: { kind: "name", name: "uint8" } }, size: 4, layout: null };
  }

  // roots
  if (expr.kind === "identifier") {
    // a reference/pointer local holds the address of its referent; chain member access through it.
    if (ctx.refLocals?.has(expr.name)) {
      const t = ctx.refLocals.get(expr.name)!;
      return { addr: `(local.get $${expr.name})`, type: t, size: ctx.cg.sizeOfType(t, ctx.thisBind ?? NO_BIND), layout: ctx.cg.layoutOfType(t, ctx.thisBind ?? NO_BIND) };
    }
    // an aggregate value-helper / container-method parameter holds the address of its argument; its type may reference template params
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) {
      const b = ctx.thisBind ?? NO_BIND;
      return { addr: `(local.get $${p.local ?? expr.name})`, type: p.type, size: ctx.cg.sizeOfType(p.type, b), layout: ctx.cg.layoutOfType(p.type, b) };
    }
    if (p) return null;   // a scalar param has no address; don't let it fall through to the entry-fn names
    if (expr.name === "input") return { addr: "(local.get $__qinit_in)", type: null, size: ctx.in.size, layout: ctx.in };
    if (expr.name === "output") return { addr: "(local.get $__qinit_out)", type: null, size: ctx.out.size, layout: ctx.out };
    if (expr.name === "locals") return { addr: "(local.get $__qinit_locals)", type: null, size: ctx.locals.size, layout: ctx.locals };
    // bare `state` (a static helper taking ContractState& — QTF's enableBuyTicket(state, flag)): the resident state region. Only meaningful where
    if (expr.name === "state" && ctx.hasStateParam && !ctx.localVars.has("state")) {
      return { addr: "(local.get $__qinit_state)", type: null, size: ctx.state.size, layout: ctx.state };
    }
    // inside a compiled container method (or an inlined struct method): `this`, or a bare member of *this
    if (ctx.thisLayout) {
      const thisAddr = ctx.thisAddr ?? "(local.get $this)";
      if (expr.name === "this") return { addr: thisAddr, type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
      const f = ctx.thisLayout.fields.get(expr.name);
      if (f) return { addr: addrOf(thisAddr, f.offset), type: f.type, size: f.size, layout: ctx.cg.layoutOfType(f.type, ctx.thisBind) };
    }
    return null;
  }

  // arr[i] / ptr[i]: element address from an array member (this+off) or a pointer-valued operand.
  if (expr.kind === "subscript") {
    const base = resolveAddr(ctx, expr.object);
    let baseAddr: string | null = null, elemType: TypeSpec | null = null;
    if (base?.type?.kind === "array") { baseAddr = base.addr; elemType = base.type.elem; }
    else if (base?.type?.kind === "pointer") { baseAddr = base.addr; elemType = base.type.pointee; }
    if (!baseAddr || !elemType) return null;
    const elemSize = ctx.cg.sizeOfType(elemType, ctx.thisBind);
    const idx = `(i32.mul (i32.wrap_i64 ${emitValue(ctx, expr.index)}) (i32.const ${elemSize}))`;
    return { addr: `(i32.add ${baseAddr} ${idx})`, type: elemType, size: elemSize, layout: ctx.cg.layoutOfType(elemType, ctx.thisBind) };
  }

  // ptr + n / ptr - n: pointer arithmetic — the address n elements away, staying pointer-typed (feeds
  if (expr.kind === "binary_op" && (expr.op === "+" || expr.op === "-")) {
    const base = resolveAddr(ctx, expr.left);
    const bt = base?.type;
    if (base && bt?.kind === "pointer") {
      const elemSize = ctx.cg.sizeOfType(bt.pointee, ctx.thisBind) || 8;
      const off = `(i32.mul (i32.wrap_i64 ${emitValue(ctx, expr.right)}) (i32.const ${elemSize}))`;
      const addr = `(${expr.op === "+" ? "i32.add" : "i32.sub"} ${base.addr} ${off})`;
      return { addr, type: bt, size: base.size, layout: null };
    }
  }

  // inside a compiled container method: `this` (the object) and `*this` both address the instance.
  if (expr.kind === "this" && ctx.thisLayout) {
    return { addr: ctx.thisAddr ?? "(local.get $this)", type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
  }
  // A pointer/reference cast reinterprets the same address as the target type (the base subobject of a single-inheritance derived
  {
    const ci = castInfo(expr);
    if (ci) {
      const inner = resolveAddr(ctx, ci.operand);
      const materialized = !inner && ctx.cg.gtestMode ? emitAddr(ctx, ci.operand) : null;
      if (!inner && !materialized) return null;
      const address = inner?.addr ?? materialized!;
      const b = ctx.thisBind ?? NO_BIND;
      // A cast to T* produces a pointer value at the same wasm32 address. Keep the pointer wrapper so
      // subsequent `+ n`, subscripting, and unary `*` scale by sizeof(T) and load the pointee.
      if (ci.type.kind === "pointer") {
        return { addr: address, type: ci.type, size: 4, layout: null };
      }
      const t = stripPtrRefConst(ci.type);
      return { addr: address, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
    }
  }

  // &lvalue (address-of) and *this (deref) are identity at the addressing level — the node already carries the operand's
  if (expr.kind === "unary_op" && expr.op === "&") return resolveAddr(ctx, expr.arg);
  if (expr.kind === "unary_op" && expr.op === "*") {
    if (expr.arg.kind === "this") return resolveAddr(ctx, expr.arg);
    // *cast<T*>(&X): the deref of a pointer cast is the cast operand's address, retyped to the pointee.
    const ci = castInfo(expr.arg);
    if (ci && ci.type.kind === "pointer") {
      const inner = resolveAddr(ctx, ci.operand);
      const materialized = !inner && ctx.cg.gtestMode ? emitAddr(ctx, ci.operand) : null;
      if (inner || materialized) {
        const b = ctx.thisBind ?? NO_BIND;
        const t = stripPtrRefConst(ci.type);
        return { addr: inner?.addr ?? materialized!, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
      }
    }
    // *ptr: a pointer param/local holds the pointed-to address, so dereferencing yields that address.
    const pn = resolveAddr(ctx, expr.arg);
    const pt = pn?.type ? ctx.cg.derefType(pn.type) : null;
    if (pn && pt?.kind === "pointer") {
      const pointee = pt.pointee;
      const sz = ctx.cg.sizeOfType(pointee, ctx.thisBind ?? NO_BIND) || 8;
      return { addr: pn.addr, type: pointee, size: sz, layout: ctx.cg.layoutOfType(pointee, ctx.thisBind ?? NO_BIND) };
    }
    return null;
  }

  if (isStateAccessor(expr)) {
    // Inside a compiled struct/template method `state` is a ContractState& PARAM (NextEpochData::apply); the wasm local of the same name
    const layout = ctx.state.size > 0 ? ctx.state : ctx.cg.contractStateLayout;
    const stateParam = ctx.params?.get("state");
    const addr = stateParam?.isAddr ? `(local.get $${stateParam.local ?? "state"})` : "(local.get $__qinit_state)";
    return { addr, type: null, size: layout.size, layout };
  }

  // a container element getter (arr.get(i), map.value(i)/key(i)) is an lvalue we can keep chaining from
  if (expr.kind === "call") {
    const ce = resolveContainerElem(ctx, expr);
    if (ce) return ce;
    // obj.method(args) where method is an inline member of obj's struct returning a reference (the fluent `Element& init(...) {
    return tryInlineStructMethod(ctx, expr);
  }

  // member access: resolve the object, then index its field
  if (expr.kind === "member_access") {
    let parent = resolveAddr(ctx, expr.object);
    if (!parent && expr.object.kind === "call" && expr.object.callee.kind === "member_access") {
      const method = inlineMethodInfo(ctx, expr.object);
      if (method && ctx.cg.isAggregateType(ctx.cg.derefType(method.fn.returnType))) {
        const type = ctx.cg.derefType(method.fn.returnType);
        const addr = emitAddr(ctx, expr.object);
        if (addr) parent = {
          addr,
          type,
          size: Math.max(1, ctx.cg.sizeOfType(type, ctx.thisBind ?? NO_BIND)),
          layout: ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND),
        };
      }
    }
    if (!parent && expr.object.kind === "call" && expr.object.callee.kind === "identifier") {
      const helper = lookupHelper(ctx, expr.object);
      if (helper?.retAgg && helper.retType) {
        const addr = emitAggHelperCall(ctx, expr.object, helper);
        parent = {
          addr,
          type: helper.retType,
          size: helper.retAgg,
          layout: ctx.cg.layoutOfType(helper.retType, ctx.thisBind ?? NO_BIND),
        };
      }
    }
    // Member of an id-producing qpi call (`qpi.K12(x).u64._0`): resolveAddr has no lvalue for the call, but emitAddr materializes an
    if (!parent && expr.object.kind === "call" && expr.object.callee.kind === "member_access"
      && expr.object.callee.object.kind === "identifier" && expr.object.callee.object.name === "qpi"
      && (QPI_CALLS[expr.object.callee.member]?.ret === "out" || QPI_ID_PRODUCERS[expr.object.callee.member])) {
      const addr = emitAddr(ctx, expr.object);
      if (addr) parent = { addr, type: { kind: "name", name: "id" }, size: 32, layout: null };
    }
    if (!parent) return null;
    if (expr.arrow && parent.type?.kind === "pointer") {
      const pointee = parent.type.pointee;
      parent = {
        addr: parent.addr,
        type: pointee,
        size: ctx.cg.sizeOfType(pointee, ctx.thisBind ?? NO_BIND),
        layout: ctx.cg.layoutOfType(pointee, ctx.thisBind ?? NO_BIND),
      };
    }
    // id/m256i limb views (`.u64`/`.u32`/`.u16`/`.u8`) → a fixed-width array at the value's base.
    if (isIdLike(ctx.cg, parent.type) && ID_VIEWS[expr.member]) {
      return { addr: parent.addr, type: null, size: 32, layout: ID_VIEWS[expr.member] };
    }
    // uint128 `.low` / `.high` → the low / high 64-bit half (low at offset 0).
    if (isUint128(ctx.cg, parent.type) && (expr.member === "low" || expr.member === "high")) {
      return { addr: addrOf(parent.addr, expr.member === "low" ? 0 : 8), type: { kind: "name", name: "uint64" }, size: 8, layout: null };
    }
    if (!parent.layout) return null;
    const f = parent.layout.fields.get(expr.member);
    if (!f) return null;
    // A member type written in terms of the parent instance's own params / nested typedefs (e.g.
    let ptype: TypeSpec | null = parent.type;
    for (let i = 0; i < 8 && ptype?.kind === "name"; i++) ptype = ctx.cg.typedefs.get(ptype.name) ?? null;
    let ftype = ptype?.kind === "template_instance" ? ctx.cg.concreteMemberType(f.type, ptype) : f.type;
    ftype = resolveInParentStruct(ctx, ftype, parent);
    return {
      addr: addrOf(parent.addr, f.offset),
      type: ftype,
      size: f.size,
      layout: ctx.cg.layoutOfType(ftype),
    };
  }

  return null;
}

// Resolve a field type spelled in its declaring struct's own scope — Array<Order,256> where Order is a sibling
export function resolveInParentStruct(ctx: FnCtx, t: TypeSpec, parent: AddrNode): TypeSpec {
  const decl = parent.type?.kind === "inline_struct"
    ? parent.type.struct
    : parent.type?.kind === "name" ? ctx.cg.structByName(parent.type.name, ctx.thisBind ?? NO_BIND) : undefined;
  if (!decl) return t;

  const nestedOf = (n: string): TypeSpec | null => {
    const s = decl.members.find((m) => m.kind === "struct" && (m as StructDecl).name === n) as StructDecl | undefined;
    return s ? { kind: "inline_struct", struct: s } : null;
  };

  if (t.kind === "name") {
    return nestedOf(t.name) ?? t;
  }
  if (t.kind === "template_instance") {
    let changed = false;
    const args = t.args.map((a) => {
      if (a.kind === "name") {
        const r = nestedOf(a.name);
        if (r) {
          changed = true;
          return r;
        }
      }
      return a;
    });
    return changed ? { ...t, args } : t;
  }
  return t;
}

// Scalar lvalue (size <= 8) address+size, for load/store of a scalar field.
export function tryLvalueAddr(ctx: FnCtx, expr: Expression): Lvalue | null {
  const n = resolveAddr(ctx, expr);
  if (!n) return null;
  return { addr: n.addr, size: n.size, type: n.type };
}

// Address of an lvalue or a materializable aggregate. Returns null if not addressable.
export function emitAddr(ctx: FnCtx, expr: Expression): string | null {
  if (expr.kind === "identifier" && expr.name === "SELF") return "(call $self_id)";
  // an aggregate value-helper parameter is passed by address
  if (expr.kind === "identifier") {
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) return `(local.get $${p.local ?? expr.name})`;
  }
  if (expr.kind === "paren") return emitAddr(ctx, expr.expr);

  if (expr.kind === "call") {
    const cached = ctx.materializedCalls?.get(expr);
    if (cached) return cached.addr;
  }

  if (expr.kind === "call" && (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name")) {
    const primitive = platformPrimitive(expr.callee.name);
    if (primitive?.result === "address") {
      for (const capability of primitive.capabilities ?? []) ctx.cg.capabilities.add(capability);
      if (expr.args.length !== primitive.operands.length) {
        throw new Error(`${primitive.name} expects ${primitive.operands.length} argument(s), got ${expr.args.length}`);
      }
      const destination = allocSlotIr(ctx, 32);
      if (primitive.kind === "zero") {
        ctx.lines.push(`    ${ir.emit(ir.call("$setMem", destination, ir.i32c(32), ir.i32c(0)))}`);
      } else if (primitive.kind === "lane-pack-64") {
        for (let lane = 0; lane < 4; lane++) {
          ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", lane * 8, destination, emitValueIr(ctx, expr.args[3 - lane])))}`);
        }
      } else if (primitive.kind === "lane-pack-8") {
        for (let lane = 0; lane < 32; lane++) {
          const byte = ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[31 - lane]));
          ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", lane, destination, byte))}`);
        }
      } else if (primitive.kind === "memory-load") {
        const source = emitAddr(ctx, expr.args[0]);
        if (!source) throw new Error(`${primitive.name} source is not addressable`);
        ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", destination, addrIr(source), ir.i32c(32)))}`);
      } else if (primitive.kind === "lane-compare-64") {
        const left = emitAddr(ctx, expr.args[0]);
        const right = emitAddr(ctx, expr.args[1]);
        if (!left || !right) throw new Error(`${primitive.name} operands must be addressable`);
        for (let lane = 0; lane < 4; lane++) {
          const a = ir.loadRaw("i64.load", lane * 8, addrIr(left));
          const b = ir.loadRaw("i64.load", lane * 8, addrIr(right));
          const value = ir.selectV(ir.i64c(-1), ir.i64c(0), ir.op("i64.eq", a, b));
          ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", lane * 8, destination, value))}`);
        }
      } else {
        throw new Error(`platform primitive '${primitive.name}' cannot produce an address via ${primitive.kind}`);
      }
      return ir.emit(destination);
    }
  }

  if (ctx.cg.gtestMode && expr.kind === "call" && (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name")) {
    const calleeName = expr.callee.name;
    if (calleeName === "__qtest_state") {
      const sizeExpr = expr.args[1];
      const size = sizeExpr?.kind === "sizeof_expr" && sizeExpr.expr.kind === "identifier"
        ? ctx.cg.sizeOfType({ kind: "name", name: sizeExpr.expr.name }, ctx.thisBind ?? NO_BIND)
        : sizeExpr ? Number(ctx.cg.evalConstBig(sizeExpr, ctx.thisBind ?? NO_BIND)) : 0;
      if (!(size > 0)) throw new Error("gtest state access requires a constant positive state size");
      const destination = allocSlotIr(ctx, size);
      const slot = ir.op("i32.wrap_i64", expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0));
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.call("$qt_state", slot, destination, ir.i32c(size))))}`);
      const addr = ir.emit(destination);
      (ctx.materializedCalls ??= new WeakMap()).set(expr, { addr, type: null, size, layout: null });
      return addr;
    }

    // Core-lite fixtures commonly pass an empty input temporary directly to callFunction, for example
    // `callFunction(..., CCF::GetProposalFee_input(), output)`. It has the same zero-initialized object
    if (expr.args.length === 0) {
      const type: TypeSpec = { kind: "name", name: calleeName };
      const size = ctx.cg.sizeOfType(type, ctx.thisBind ?? NO_BIND);
      if (size > 0 || /_(?:input|output)$/.test(calleeName)) {
        const destination = size > 0 ? allocSlotIr(ctx, size) : ir.i32c(0);
        if (size > 0) ctx.lines.push(`    ${ir.emit(ir.call("$setMem", destination, ir.i32c(size), ir.i32c(0)))}`);
        const addr = ir.emit(destination);
        (ctx.materializedCalls ??= new WeakMap()).set(expr, {
          addr,
          type,
          size,
          layout: ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND),
        });
        return addr;
      }
    }
  }

  if (ctx.cg.gtestMode && expr.kind === "call" && expr.callee.kind === "member_access") {
    const resolved = inlineMethodInfo(ctx, expr);
    if (resolved && ctx.cg.isAggregateType(ctx.cg.derefType(resolved.fn.returnType))) {
      const type = ctx.cg.derefType(resolved.fn.returnType);
      const size = Math.max(1, ctx.cg.sizeOfType(type, ctx.thisBind ?? NO_BIND));
      const destination = allocSlotIr(ctx, size);
      emitInlineStructMethod(ctx, resolved.object, resolved.fn, expr.args, { retAddr: ir.emit(destination), retSize: size });
      const addr = ir.emit(destination);
      (ctx.materializedCalls ??= new WeakMap()).set(expr, { addr, type, size, layout: ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND) });
      return addr;
    }
  }

  // A computed uint128 value must go through its source-compiled constructor/operator
  // before it is passed by reference. In particular, do this before stripping a C-style
  if ((expr.kind === "call" || expr.kind === "template_call" || expr.kind === "construct" || expr.kind === "binary_op" ||
       expr.kind === "c_cast" || expr.kind === "static_cast" || expr.kind === "ternary") &&
      isU128Expr(ctx, expr)) {
    return emitU128(ctx, expr);
  }
  if (expr.kind === "c_cast" || expr.kind === "static_cast") return emitAddr(ctx, expr.expr);

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot
  if (expr.kind === "ternary") {
    const ta = resolveAddr(ctx, expr.then)?.addr ?? emitAddr(ctx, expr.then);
    const ea = ta ? (resolveAddr(ctx, expr.else_)?.addr ?? emitAddr(ctx, expr.else_)) : null;
    if (ta && ea) {
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, ir.selectV(addrIr(ta), addrIr(ea), ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.cond))))}`);
      return `(local.get $${t})`;
    }
  }

  // min/max over id/m256i operands select an address by the 256-bit lexicographic compare (mirroring the contract-defined `const T&`-returning template
  if (expr.kind === "call" && expr.args.length === 2 &&
    (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name")) {
    const cname = expr.callee.kind === "identifier" ? expr.callee.name : expr.callee.name;
    const base = cname.includes("::") ? cname.slice(cname.lastIndexOf("::") + 2) : cname;
    if (base === "min" || base === "max") {
      const la = aggOperand(ctx, expr.args[0]);
      const ra = la ? aggOperand(ctx, expr.args[1]) : null;
      if (la && ra && la.size === 32 && ra.size === 32) {
        const t = newTmp(ctx);
        const cmp = ir.call("$m256_lt", addrIr(la.addr), addrIr(ra.addr));
        const pick = base === "min"
          ? ir.selectV(addrIr(la.addr), addrIr(ra.addr), cmp)
          : ir.selectV(addrIr(ra.addr), addrIr(la.addr), cmp);
        ctx.lines.push(`    ${setLocal(ctx, t, pick)}`);
        return `(local.get $${t})`;
      }
    }
  }

  // aggregate construction Type{...} as an rvalue/argument — materialize into a scratch slot.
  if (expr.kind === "construct") {
    const sz = ctx.cg.sizeOfType(expr.type, ctx.thisBind ?? NO_BIND);
    if (sz > 0) {
      const s = allocSlot(ctx, sz);
      if (emitConstruct(ctx, s, expr.type, expr.args)) return s;
    }
  }

  // Plain aggregate constructor syntax is normalized through the authoritative class constructor.
  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "id" || expr.callee.name === "m256i")) {
    const type: TypeSpec = { kind: "name", name: expr.callee.name };
    const destination = allocSlot(ctx, 32);
    if (!emitConstruct(ctx, destination, type, expr.args)) {
      throw new Error(`authoritative ${expr.callee.name} constructor could not be lowered`);
    }
    return destination;
  }

  // A qualified static method returning an aggregate is compiled from the owning
  // struct's authoritative body. Typedef owners (id -> m256i) resolve to the same
  if (expr.kind === "call" && (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name")) {
    const qualified = expr.callee.name;
    const separator = qualified.lastIndexOf("::");
    if (separator > 0) {
      const ownerSpelling = qualified.slice(0, separator);
      const method = qualified.slice(separator + 2);
      // Resolve NS::Type (or Type) without assuming a QPI:: prefix — try full spelling, then tail.
      const bind = ctx.thisBind ?? NO_BIND;
      const resolveOwner = (spelling: string): { type: TypeSpec; struct: StructDecl } | null => {
        const type = ctx.cg.resolveType({ kind: "name", name: spelling }, bind);
        const struct = ctx.cg.structOf(type, bind);
        return struct ? { type, struct } : null;
      };
      let owner = resolveOwner(ownerSpelling);
      if (!owner && ownerSpelling.includes("::")) {
        const tail = ownerSpelling.slice(ownerSpelling.lastIndexOf("::") + 2);
        owner = resolveOwner(tail);
      }
      if (owner) {
        const declaration = owner.struct.members.find(
          (member): member is FunctionDecl => member.kind === "function" && member.name === method && member.isStatic && !!member.body,
        );
        if (declaration && ctx.cg.isAggregateType(ctx.cg.derefType(declaration.returnType))) {
          const concreteOwner = owner.type.kind === "name" ? owner.type.name : owner.struct.name;
          const target: TypeSpec & { kind: "template_instance" } = { kind: "template_instance", name: concreteOwner, args: [] };
          const compiled = callCompiled(ctx, target, method, "(i32.const 0)", expr.args);
          if (!compiled?.retDest || !compiled.cm.retType) {
            throw new Error(`authoritative static aggregate method ${qualified} could not be lowered`);
          }
          ctx.lines.push(`    ${compiled.call}`);
          const type = ctx.cg.substInBindings(ctx.cg.derefType(compiled.cm.retType), bind);
          const size = compiled.cm.retAgg ?? ctx.cg.sizeOfType(type, bind);
          (ctx.materializedCalls ??= new WeakMap()).set(expr, {
            addr: compiled.retDest,
            type,
            size,
            layout: ctx.cg.layoutOfType(type, bind),
          });
          return compiled.retDest;
        }
      }
    }
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot.
  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const hinfo = lookupHelper(ctx, expr);
    if (hinfo?.retAgg) return emitAggHelperCall(ctx, expr, hinfo);
  }

  // AssetOwnership/PossessionIterator.possessor()/owner() → address of the id in the current buffer record.
  if (expr.kind === "call" && expr.callee.kind === "member_access") {
    const ai = emitAssetIter(ctx, expr, "addr");
    if (ai !== null) return ai;
  }

  // qpi(X).method(...) returning an id/struct (proposerId): compile the real proxy method and materialize the result into its $ret slot
  if (expr.kind === "call" && qpiWrapperMethod(expr)) {
    const pa = emitProposalProxyAddr(ctx, expr);
    if (pa !== null) return pa;
  }

  // qpi.X(...) that returns an id/aggregate by value (computor(i), arbitrator(), nextId(x), prevId(x)): allocate a 32-byte slot, let emitQpiCall emit
  if (expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const desc = QPI_CALLS[expr.callee.member];
    if (desc && desc.ret === "out") {
      const s = allocSlot(ctx, desc.outSize ?? 32);
      const q = emitQpiCall(ctx, expr, s);
      if (q) ctx.lines.push(`    ${q.wat}`);
      return s;
    }
    // qpi.invocator() / qpi.originator(): arg-less id producers not in QPI_CALLS.
    const fwd = QPI_ID_PRODUCERS[expr.callee.member];
    if (fwd) {
      const s = allocSlotIr(ctx, 32);
      ctx.lines.push(`    ${ir.emit(ir.call(fwd, s))}`);
      return ir.emit(s);
    }
  }

  const n = resolveAddr(ctx, expr);
  return n ? n.addr : null;
}

// A call `obj.method(args)` where method is an inline member of obj's struct that returns a reference (the fluent
export function tryInlineStructMethod(ctx: FnCtx, expr: Expression & { kind: "call" }): AddrNode | null {
  if (expr.callee.kind !== "member_access") return null;
  const method = expr.callee.member;
  const objNode = resolveAddr(ctx, expr.callee.object);
  if (!objNode || !objNode.layout || !objNode.type) return null;
  const struct = ctx.cg.structOf(objNode.type, ctx.thisBind ?? NO_BIND);
  if (!struct) return null;
  const fn = struct.members.find(
    (m) => m.kind === "function" && (m as FunctionDecl).name === method && (m as FunctionDecl).body,
  ) as FunctionDecl | undefined;
  if (!fn) return null;
  // This address channel is only valid for fluent/reference-returning methods. Scalar methods
  // such as WinnerData::isValid() must flow through normal value-call compilation; inlining them
  const returnsAddress = (type: TypeSpec): boolean =>
    type.kind === "reference" || type.kind === "pointer" ||
    (type.kind === "const" && returnsAddress(type.valueType));
  if (!returnsAddress(fn.returnType)) return null;
  const addr = emitInlineStructMethod(ctx, objNode, fn, expr.args);
  return { addr, type: objNode.type, size: objNode.size, layout: objNode.layout };
}

function inlineMethodInfo(ctx: FnCtx, expr: Expression & { kind: "call" }): { object: AddrNode; fn: FunctionDecl } | null {
  if (expr.callee.kind !== "member_access") return null;
  const object = resolveAddr(ctx, expr.callee.object);
  if (!object?.type || !object.layout) return null;
  if (object.type.kind === "template_instance") return null;
  const struct = ctx.cg.structOf(object.type, ctx.thisBind ?? NO_BIND);
  const method = expr.callee.member;
  const fn = struct?.members.find(
    (member) => member.kind === "function" && (member as FunctionDecl).name === method && (member as FunctionDecl).body,
  ) as FunctionDecl | undefined;
  return fn ? { object, fn } : null;
}

export function emitInlineStructValue(ctx: FnCtx, expr: Expression & { kind: "call" }): ir.Ir | null {
  if (!ctx.cg.gtestMode) return null;
  const resolved = inlineMethodInfo(ctx, expr);
  if (!resolved || ctx.cg.isVoidType(resolved.fn.returnType) || ctx.cg.isAggregateType(ctx.cg.derefType(resolved.fn.returnType))) return null;
  const result = newTmp(ctx);
  ctx.localVars.set(result, { wasmType: "i64", type: ctx.cg.derefType(resolved.fn.returnType) });
  ctx.lines.push(`    ${setLocal(ctx, result, ir.i64c(0))}`);
  emitInlineStructMethod(ctx, resolved.object, resolved.fn, expr.args, { retValue: result });
  return ir.getL(result, "i64");
}

export function emitInlineStructStatement(ctx: FnCtx, expr: Expression & { kind: "call" }): boolean {
  if (!ctx.cg.gtestMode) return false;
  const resolved = inlineMethodInfo(ctx, expr);
  if (!resolved) return false;
  emitInlineStructMethod(ctx, resolved.object, resolved.fn, expr.args);
  return true;
}

function renameInlineLocals(body: Statement, suffix: string): Statement {
  const names = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.kind === "variable" && node.isMember === false && typeof node.name === "string") {
      names.set(node.name, `${node.name}${suffix}`);
    }
    for (const child of Object.values(node)) collect(child);
  };
  collect(body);
  const clone = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(clone);
    const node = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) out[key] = clone(child);
    if ((node.kind === "identifier" || (node.kind === "variable" && node.isMember === false)) && typeof node.name === "string") {
      out.name = names.get(node.name) ?? node.name;
    }
    return out;
  };
  return clone(body) as Statement;
}

// Emit a struct member method inline into the current function: stash the object address in a temp (used
export function emitInlineStructMethod(
  ctx: FnCtx,
  objNode: AddrNode,
  fn: FunctionDecl,
  args: Expression[],
  result: { retAddr?: string; retSize?: number; retValue?: string } = {},
): string {
  const self = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, self, addrIr(objNode.addr))}`);
  const bind = ctx.thisBind ?? NO_BIND;

  const params = new Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>();
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    const cls = classifyMethodParam(ctx.cg, p, bind);
    const slot = `marg${ctx.tmpCount++}`;
    ctx.localVars.set(slot, { wasmType: cls.wasmType });
    const arg = args[i] ?? p.defaultValue;
    const paramType = ctx.cg.substInBindings(ctx.cg.derefType(p.type), bind);
    if (arg) {
      const v = cls.isAddr
        ? addrIr(argAddr(ctx, arg, ctx.cg.sizeOfType(paramType, bind), paramType, cls.readOnlyRef === true))
        : emitValueIr(ctx, arg);
      ctx.lines.push(`    ${setLocal(ctx, slot, v)}`);
    }
    // Keep dependent fields concrete inside the inlined body. Leaving `T` here made a `const T&`
    // parameter fall back to a signed 32-bit load even when the owning container bound T=uint64.
    params.set(p.name, { wasmType: cls.wasmType, isAddr: cls.isAddr, type: paramType, local: slot });
  }

  const save = {
    thisLayout: ctx.thisLayout, thisType: ctx.thisType, thisAddr: ctx.thisAddr,
    params: ctx.params, inlineMethod: ctx.inlineMethod, retIsValue: ctx.retIsValue,
    retAddr: ctx.retAddr, retAggSize: ctx.retAggSize, retType: ctx.retType, inlineReturnLabel: ctx.inlineReturnLabel,
    inlineValueLocal: ctx.inlineValueLocal, retTypeName: ctx.retTypeName,
  };
  ctx.thisLayout = objNode.layout ?? undefined;
  ctx.thisType = objNode.type ?? undefined;
  ctx.thisAddr = `(local.get $${self})`;
  ctx.params = params;
  ctx.inlineMethod = true;
  ctx.retIsValue = false;
  ctx.retAddr = result.retAddr;
  ctx.retAggSize = result.retSize;
  ctx.retType = ctx.cg.derefType(fn.returnType);
  ctx.inlineValueLocal = result.retValue;
  ctx.retTypeName = fn.returnType.kind === "name" ? fn.returnType.name : undefined;
  const returnLabel = `$inline_return_${ctx.loopCount++}`;
  ctx.inlineReturnLabel = returnLabel;
  // Hoist the inlined body's own local declarations into the host function's local set — the top-level collectLocals never
  const body = fn.body ? renameInlineLocals(fn.body, `__inline${ctx.tmpCount++}`) : undefined;
  if (body) collectLocals(body, ctx);
  ctx.lines.push(`    (block ${returnLabel}`);
  if (body) emitStmt(ctx, body);
  ctx.lines.push("    )");
  Object.assign(ctx, save);

  return `(local.get $${self})`;
}

// Resolve a container element getter to an addressable node: Array.get(i) → T, HashMap value(i) → V / key(i)
export function resolveContainerElem(ctx: FnCtx, expr: Expression & { kind: "call" }): AddrNode | null {
  if (expr.callee.kind !== "member_access") return null;
  const cached = ctx.materializedCalls?.get(expr);
  if (cached) return cached;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || !node.type) return null;
  // Follow typedefs / template-param bindings to the concrete container instance (e.g. RevenueDonationT →
  let ct: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && ct?.kind === "name"; i++) {
    const next: TypeSpec | undefined = ctx.thisBind?.types.get(ct.name) ?? ctx.cg.typedefs.get(ct.name);
    if (!next) break;
    ct = next;
  }
  if (ct?.kind === "name" && (ctx.cg.globalStructs.has(ct.name) || ctx.cg.templateMethods.has(ct.name))) {
    ct = { kind: "template_instance", name: ct.name, args: [] };
  }
  if (!ct || ct.kind !== "template_instance") return null;
  const ctype = ct;
  const m = expr.callee.member;
  const mk = (addr: string, elemType: TypeSpec): AddrNode => ({
    addr, type: elemType, size: ctx.cg.sizeOfType(elemType), layout: ctx.cg.layoutOfType(elemType),
  });

  const method = compileContainerMethod(ctx.cg, ctype, m, expr.args.length);
  if (!method || (method.retKind !== "i32" && !method.retAgg)) return null;
  const compiled = callCompiled(ctx, ctype, m, node.addr, expr.args);
  if (!compiled?.cm.retType) {
    throw new Error(`authoritative aggregate/reference method ${ctype.name}::${m} could not be lowered`);
  }
  if (compiled.retDest) ctx.lines.push(`    ${compiled.call}`);
  const result = mk(compiled.retDest ?? compiled.call, compiled.cm.retType);
  if (compiled.retDest) (ctx.materializedCalls ??= new WeakMap()).set(expr, result);
  return result;
}

// qpi.* zero-arg accessors that return a 32-byte id by value, written to an out address.
export const QPI_ID_PRODUCERS: Record<string, string> = {
  getPrevSpectrumDigest: "$qpi_prevSpectrumDigest",
  getPrevUniverseDigest: "$qpi_prevUniverseDigest",
  getPrevComputerDigest: "$qpi_prevComputerDigest",
};

// Aggregate construction `Type{ a, b, c }` written into dstAddr: zero the target, then store each arg into
export function emitConstruct(ctx: FnCtx, dstAddr: string, type: TypeSpec, args: Expression[]): boolean {
  const resolved = ctx.cg.resolveType(type, ctx.thisBind ?? NO_BIND);
  const owner = resolved.kind === "name" ? resolved.name
    : resolved.kind === "template_instance" ? resolved.name
    : type.kind === "name" ? type.name : null;
  if (owner && ctx.cg.templateMethods.get(owner)?.has(owner)) {
    const instance: TypeSpec & { kind: "template_instance" } = {
      kind: "template_instance",
      name: owner,
      args: resolved.kind === "template_instance" ? resolved.args : [],
    };
    const compiled = callCompiled(ctx, instance, owner, dstAddr, args);
    if (!compiled || compiled.cm.retKind !== "void") {
      throw new Error(`authoritative ${owner} constructor could not be lowered`);
    }
    ctx.lines.push(`    ${compiled.call}`);
    return true;
  }
  const layout = ctx.cg.layoutOfType(type, ctx.thisBind ?? NO_BIND);
  if (!layout) return false;
  const fields = [...layout.fields.values()];
  const t = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, t, addrIr(dstAddr))}`);
  ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(t, "i32"), ir.i32c(layout.size), ir.i32c(0)))}`);
  for (let i = 0; i < args.length && i < fields.length; i++) {
    const f = fields[i];
    const fAddr = ir.addr0(ir.getL(t, "i32"), f.offset);
    if (isAggregate(ctx, f.type, f.size)) {
      const arg = args[i];
      const nestedArgs = arg.kind === "initializer_list" ? arg.exprs : arg.kind === "construct" ? arg.args : null;
      if (nestedArgs && emitConstruct(ctx, ir.emit(fAddr), f.type, nestedArgs)) continue;
      const src = emitAddr(ctx, arg);
      if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", fAddr, addrIr(src), ir.i32c(f.size)))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.storeScalar(fAddr, f.size, emitValueIr(ctx, args[i])))}`);
    }
  }
  return true;
}

// Materialize a 256-bit id/m256i from up to four 64-bit limb expressions into scratch; returns its addr.
export function materializeId(ctx: FnCtx, limbs: Expression[]): string {
  const s = allocSlotIr(ctx, 32);
  for (let i = 0; i < 4; i++) {
    const v = limbs[i] ? emitValueIr(ctx, limbs[i]) : ir.i64c(0);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(s, i * 8), v))}`);
  }
  return ir.emit(s);
}

// True if a type is an aggregate (id/m256i/struct/array) that lives in memory rather than an i64.
export function isAggregate(ctx: FnCtx, type: TypeSpec | null, size: number): boolean {
  if (!type) return size > 8;
  if (type.kind === "name" && (type.name === "id" || type.name === "m256i")) return true;
  if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance") return true;
  if (type.kind === "name" && ctx.cg.layoutOfType(type)) return true;
  return size > 8;
}

// Typed local.set line: the value's width is checked against the local's declared wasm type, so an i64 flowing
export function setLocal(ctx: FnCtx, name: string, v: ir.Ir): string {
  const lv = ctx.localVars.get(name) ?? ctx.params?.get(name);
  if (lv) {
    ir.assertTy(v, lv.wasmType, `local.set $${name}`);
  }
  return ir.emit(ir.setL(name, v));
}

// Allocate a fresh scratch block, stash its address in a new temp, return its `(local.get $tmp)` node.
export function allocSlotIr(ctx: FnCtx, size: number): ir.Ir {
  const t = newTmp(ctx);
  ctx.lines.push(`    ${ir.emit(ir.setL(t, ir.call("$qpiAllocLocals", ir.i32c(size))))}`);
  return ir.getL(t, "i32");
}

export function allocSlot(ctx: FnCtx, size: number): string {
  return ir.emit(allocSlotIr(ctx, size));
}

// Address of an argument: use an existing lvalue directly, or materialize a
// temporary according to the declaration's concrete parameter type.
export function argAddr(
  ctx: FnCtx,
  expr: Expression,
  size: number,
  type?: TypeSpec,
  copyConstScalar = false,
  convertScalarToAggregate = false,
): string {
  const targetAggregate = !!type && ctx.cg.isAggregateType(type);
  const source = convertScalarToAggregate ? resolveAddr(ctx, expr) : null;
  const sourceAggregate = (!!source && isAggregate(ctx, source.type, source.size))
    || (expr.kind === "construct" && ctx.cg.isAggregateType(expr.type))
    || isU128Expr(ctx, expr);
  const convertToAggregate = convertScalarToAggregate && targetAggregate && !sourceAggregate;
  const copyValue = copyConstScalar && !!type && !targetAggregate;
  if (!copyValue && !convertToAggregate) {
    const a = emitAddr(ctx, expr);
    if (a) return a;
  }
  const s = allocSlot(ctx, size);
  if (type && (convertToAggregate || expr.kind === "initializer_list" || expr.kind === "construct")) {
    const args = expr.kind === "initializer_list" ? expr.exprs : expr.kind === "construct" ? expr.args : [expr];
    if (!emitConstruct(ctx, s, type, args)) {
      throw new Error("aggregate argument initializer could not be constructed");
    }
    return s;
  }
  ctx.lines.push(`    ${storeAt(s, size, emitValue(ctx, expr))}`);
  return s;
}

export function addrOf(ptr: string, offset: number): string {
  return ir.emit(ir.addr0(ir.raw(ptr, "i32"), offset));
}

// Load a scalar into the i64 value model. Signed sub-64-bit fields MUST sign-extend — else a sint32 holding
export function loadAt(addr: string, size: number, signed = false): string {
  return ir.emit(loadAtIr(addr, size, signed));
}

// Same load, as a typed node — for value-channel callers holding a string address (resolveAddr/Lvalue stay string-typed until
export function loadAtIr(addr: string, size: number, signed = false): ir.Ir {
  return ir.loadScalar(addrIr(addr), size, signed);
}

// Wrap a string-typed address (the resolveAddr/emitAddr channel) as a typed i32 node.
export function addrIr(a: string): ir.Ir {
  return ir.raw(a, "i32", "lvalue address channel");
}

export const SIGNED_SCALARS = new Set([
  "sint8", "sint16", "sint32", "sint64",
  "signed char", "signed short", "signed int", "signed long long", "long long", "int", "short", "char",
]);
export function isSignedScalarType(t: TypeSpec | null | undefined, cg?: Codegen): boolean {
  if (!t) return false;
  if (t.kind === "const") return isSignedScalarType(t.valueType, cg);
  if (cg) t = cg.scalarStorageType(t);
  if (t.kind === "name") return SIGNED_SCALARS.has(t.name);
  return false;
}

export function storeAt(addr: string, size: number, value: string): string {
  return ir.emit(ir.storeScalar(ir.raw(addr, "i32"), size, ir.raw(value, "i64")));
}

// Narrow a 64-bit register value to a sub-64-bit scalar type, matching a C++ conversion: unsigned types mask to
export function narrowCastIr(inner: ir.Ir, typeName: string | undefined): ir.Ir {
  if (!typeName) return inner;
  const sz = SCALAR_SIZE[typeName];
  if (sz === undefined || sz >= 8) return inner;

  if (typeName === "bit" || typeName === "bool") {
    return ir.op("i64.extend_i32_u", ir.op("i64.ne", ir.i64c(0), inner));
  }
  if (typeName.startsWith("sint") || typeName.startsWith("signed")) {
    const op = sz === 4 ? "i64.extend32_s" : sz === 2 ? "i64.extend16_s" : "i64.extend8_s";
    return ir.op(op, inner);
  }
  const mask = sz === 4 ? "0xffffffff" : sz === 2 ? "0xffff" : "0xff";
  return ir.op("i64.and", inner, ir.i64c(mask));
}

export function narrowCast(inner: string, typeName: string | undefined): string {
  return ir.emit(narrowCastIr(ir.raw(inner, "i64"), typeName));
}
