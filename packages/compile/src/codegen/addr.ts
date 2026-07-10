import { SCALAR_SIZE } from "./tables";
import { emitProposalProxyAddr } from "./calls/proxy";
import { qpiWrapperMethod } from "./calls/dispatch";
import { emitAssetIter, classifyMethodParam } from "./calls/containers";
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

// id/m256i expose their 32 bytes as fixed-width limb views (`.u64`/`.u32`/`.u16`/`.u8`) with named limbs
// `_0.._N` at element-sized strides. Each view is a synthetic struct layout.
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
  return d.kind === "name" && (d.name === "uint128" || d.name === "uint128_t");
}

// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
// Normalize a cast expression to its target type + operand. C++ casts parse either as a dedicated node
// (c_cast / static_cast / reinterpret_cast) or as a `template_call` to the cast name (static_cast<T>(e)).
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
  // __ScopedScratchpad.ptr → the held scratch buffer base (the local's value). `reinterpret_cast<T*>(sp.ptr)`
  // then retypes this address; `sp.ptr` used as a value reads the same local.
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
    // an aggregate value-helper / container-method parameter holds the address of its argument; its
    // type may reference template params (KeyT, ValueT), so resolve sizes through the binding. Params
    // shadow the entry-fn input/output/locals names (a helper may name its own params `input`/`output`).
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) {
      const b = ctx.thisBind ?? NO_BIND;
      return { addr: `(local.get $${p.local ?? expr.name})`, type: p.type, size: ctx.cg.sizeOfType(p.type, b), layout: ctx.cg.layoutOfType(p.type, b) };
    }
    if (p) return null;   // a scalar param has no address; don't let it fall through to the entry-fn names
    if (expr.name === "input") return { addr: "(local.get $__qinit_in)", type: null, size: ctx.in.size, layout: ctx.in };
    if (expr.name === "output") return { addr: "(local.get $__qinit_out)", type: null, size: ctx.out.size, layout: ctx.out };
    if (expr.name === "locals") return { addr: "(local.get $__qinit_locals)", type: null, size: ctx.locals.size, layout: ctx.locals };
    // bare `state` (a static helper taking ContractState& — QTF's enableBuyTicket(state, flag)): the
    // resident state region. Only meaningful where the function carries a $state param (entry/private fns).
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

  // ptr + n / ptr - n: pointer arithmetic — the address n elements away, staying pointer-typed
  // (feeds reinterpret_cast<T*>(p + k) in the qpi.h container maintenance bodies).
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

  if (expr.kind === "paren") return resolveAddr(ctx, expr.expr);

  // inside a compiled container method: `this` (the object) and `*this` both address the instance.
  if (expr.kind === "this" && ctx.thisLayout) {
    return { addr: ctx.thisAddr ?? "(local.get $this)", type: ctx.thisType ?? null, size: ctx.thisLayout.size, layout: ctx.thisLayout };
  }
  // A pointer/reference cast reinterprets the same address as the target type (the base subobject of a
  // single-inheritance derived object is at offset 0): `static_cast<const ProposalDataType*>(&derived)`,
  // `(ProposalDataType*)this`, `reinterpret_cast<T&>(x)`. Casts parse either as a dedicated node or as a
  // `template_call` to static_cast/reinterpret_cast/const_cast; castInfo normalizes both.
  {
    const ci = castInfo(expr);
    if (ci) {
      const inner = resolveAddr(ctx, ci.operand);
      if (!inner) return null;
      const b = ctx.thisBind ?? NO_BIND;
      const t = stripPtrRefConst(ci.type);
      return { addr: inner.addr, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
    }
  }

  // &lvalue (address-of) and *this (deref) are identity at the addressing level — the node already
  // carries the operand's address.
  if (expr.kind === "unary_op" && expr.op === "&") return resolveAddr(ctx, expr.arg);
  if (expr.kind === "unary_op" && expr.op === "*") {
    if (expr.arg.kind === "this") return resolveAddr(ctx, expr.arg);
    // *cast<T*>(&X): the deref of a pointer cast is the cast operand's address, retyped to the pointee.
    const ci = castInfo(expr.arg);
    if (ci && ci.type.kind === "pointer") {
      const inner = resolveAddr(ctx, ci.operand);
      if (inner) {
        const b = ctx.thisBind ?? NO_BIND;
        const t = stripPtrRefConst(ci.type);
        return { addr: inner.addr, type: t, size: ctx.cg.sizeOfType(t, b), layout: ctx.cg.layoutOfType(t, b) };
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
    // Inside a compiled struct/template method `state` is a ContractState& PARAM (NextEpochData::apply); the
    // wasm local of the same name is the passed address, and the layout comes from the contract's StateData
    // (the ctx there carries an empty state layout).
    const layout = ctx.state.size > 0 ? ctx.state : ctx.cg.contractStateLayout;
    const stateParam = ctx.params?.get("state");
    const addr = stateParam?.isAddr ? `(local.get $${stateParam.local ?? "state"})` : "(local.get $__qinit_state)";
    return { addr, type: null, size: layout.size, layout };
  }

  // a container element getter (arr.get(i), map.value(i)/key(i)) is an lvalue we can keep chaining from
  if (expr.kind === "call") {
    const ce = resolveContainerElem(ctx, expr);
    if (ce) return ce;
    // obj.method(args) where method is an inline member of obj's struct returning a reference (the fluent
    // `Element& init(...) { ...; return *this; }` pattern) — emit it inline, resolve to the object address.
    return tryInlineStructMethod(ctx, expr);
  }

  // member access: resolve the object, then index its field
  if (expr.kind === "member_access") {
    let parent = resolveAddr(ctx, expr.object);
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
    // Member of an id-producing qpi call (`qpi.K12(x).u64._0`): resolveAddr has no lvalue for the call, but
    // emitAddr materializes an id out-producer into a 32-byte slot — chain the limb views off that.
    if (!parent && expr.object.kind === "call" && expr.object.callee.kind === "member_access"
      && expr.object.callee.object.kind === "identifier" && expr.object.callee.object.name === "qpi"
      && (QPI_CALLS[expr.object.callee.member]?.ret === "out" || QPI_ID_PRODUCERS[expr.object.callee.member])) {
      const addr = emitAddr(ctx, expr.object);
      if (addr) parent = { addr, type: { kind: "name", name: "id" }, size: 32, layout: null };
    }
    if (!parent) return null;
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
    // ProposalVoting's `proposals` element ProposalAndVotesDataType) is resolved to a concrete type so the
    // member can itself be dispatched as a container / instance. The parent may be spelled through a
    // typedef (NotifyX_input = OracleNotificationInput<OI::Price>) — follow it to the instance first.
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

// Resolve a field type spelled in its declaring struct's own scope — Array<Order,256> where Order is a
// sibling nested struct of the callee-typed parent (QX::AssetAskOrders_output). The parent's layout was
// computed WITH that scope, so sizes already match; this carries the element declaration inline so a
// downstream element getter (orders.get(i).price) can lay it out without the scope.
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
// SELF expands (in the preprocessor) to id(CONTRACT_INDEX,0,0,0), so id/m256i constructors and
// id::zero() are materialized here into a 32-byte scratch slot.
export function emitAddr(ctx: FnCtx, expr: Expression): string | null {
  if (expr.kind === "identifier" && expr.name === "SELF") return "(call $self_id)";
  // an aggregate value-helper parameter is passed by address
  if (expr.kind === "identifier") {
    const p = ctx.params?.get(expr.name);
    if (p && p.isAddr) return `(local.get $${p.local ?? expr.name})`;
  }
  if (expr.kind === "paren") return emitAddr(ctx, expr.expr);
  if (expr.kind === "c_cast" || expr.kind === "static_cast") return emitAddr(ctx, expr.expr);

  // a uint128-valued expression (constructor / arithmetic / div) materializes into a 16-byte slot
  if ((expr.kind === "call" || expr.kind === "binary_op") && isU128Expr(ctx, expr)) {
    return emitU128(ctx, expr);
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot
  // aggregate ternary (`cond ? roomA : roomB`) selects between the two branch addresses; both branches
  // materialize eagerly (same policy as the value-context ternary), fine for the lvalue selects it serves.
  if (expr.kind === "ternary") {
    const ta = resolveAddr(ctx, expr.then)?.addr ?? emitAddr(ctx, expr.then);
    const ea = ta ? (resolveAddr(ctx, expr.else_)?.addr ?? emitAddr(ctx, expr.else_)) : null;
    if (ta && ea) {
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, ir.selectV(addrIr(ta), addrIr(ea), ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, expr.cond))))}`);
      return `(local.get $${t})`;
    }
  }

  // min/max over id/m256i operands select an address by the 256-bit lexicographic compare (mirroring the
  // contract-defined `const T&`-returning template helpers); scalar min/max stays in emitMathCall.
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

  // id(a,b,c,d) / m256i(a,b,c,d) constructor → materialize the four 64-bit limbs (missing ones = 0).
  if (expr.kind === "call" && expr.callee.kind === "identifier" && (expr.callee.name === "id" || expr.callee.name === "m256i")) {
    return materializeId(ctx, expr.args);
  }

  // _mm256_set_epi64x(e3, e2, e1, e0): build a 32-byte m256i. The intrinsic takes the qwords high→low (e0 is
  // the lowest), so store reversed — byte offset i*8 holds args[3-i]. (qpi.h's ID(...) returns one of these.)
  if (expr.kind === "call" && expr.callee.kind === "identifier" && expr.callee.name === "_mm256_set_epi64x" && expr.args.length === 4) {
    const s = allocSlotIr(ctx, 32);
    for (let i = 0; i < 4; i++) {
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", i * 8, s, emitValueIr(ctx, expr.args[3 - i])))}`);
    }
    return ir.emit(s);
  }
  // id::zero() / m256i::zero() → 32 zero bytes (X::y parses as one qualified identifier "X::y")
  if (expr.kind === "call" && expr.callee.kind === "identifier" &&
    (expr.callee.name === "id::zero" || expr.callee.name === "m256i::zero")) {
    return materializeId(ctx, []);
  }

  // AssetOwnershipSelect / AssetPossessionSelect constructors → materialize the 40-byte selector the engine
  // reads (id @0, managingContract u16 @32, anyId u8 @34, anyManagingContract u8 @35). byOwner/byPossessor
  // set the id + anyMgmt; any() sets both any flags; byManagingContract sets the index + anyId.
  if (expr.kind === "call" && expr.callee.kind === "identifier" && /^(AssetOwnershipSelect|AssetPossessionSelect)::/.test(expr.callee.name)) {
    const method = expr.callee.name.split("::")[1];
    const s = allocSlotIr(ctx, 40);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
    if (method === "byOwner" || method === "byPossessor") {
      const src = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
      if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(src), ir.i32c(32)))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 35), ir.i32c(1)))}`);
    } else if (method === "any") {
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 34), ir.i32c(1)))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 35), ir.i32c(1)))}`);
    } else if (method === "byManagingContract") {
      const mc = ir.op("i32.and", ir.op("i32.wrap_i64", expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0)), ir.i32c("0xffff"));
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store16", null, ir.addr0(s, 32), mc))}`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, 34), ir.i32c(1)))}`);
    }
    return ir.emit(s);
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot.
  // Runs AFTER the dedicated factory lowerings above — a generic instantiation of e.g.
  // AssetOwnershipSelect::byOwner (reachable since lookupHelper resolves qualified statics) must not
  // shadow the hand-tuned selector shape the engine reads.
  if (expr.kind === "call" && expr.callee.kind === "identifier") {
    const hinfo = lookupHelper(ctx, expr);
    if (hinfo?.retAgg) return emitAggHelperCall(ctx, expr, hinfo);
  }

  // AssetOwnership/PossessionIterator.possessor()/owner() → address of the id in the current buffer record.
  if (expr.kind === "call" && expr.callee.kind === "member_access") {
    const ai = emitAssetIter(ctx, expr, "addr");
    if (ai !== null) return ai;
  }

  // qpi(X).method(...) returning an id/struct (proposerId): compile the real proxy method and
  // materialize the result into its $ret slot — the slot address is the lvalue.
  if (expr.kind === "call" && qpiWrapperMethod(expr)) {
    const pa = emitProposalProxyAddr(ctx, expr);
    if (pa !== null) return pa;
  }

  // qpi.X(...) that returns an id/aggregate by value (computor(i), arbitrator(), nextId(x), prevId(x)):
  // allocate a 32-byte slot, let emitQpiCall emit the host fill (with its args) into it, return the slot.
  // Without this an id-valued qpi getter used as an operand (qpi.computor(i) == voterId) never materializes.
  if (expr.kind === "call" && expr.callee.kind === "member_access" &&
    expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const desc = QPI_CALLS[expr.callee.member];
    if (desc && desc.ret === "out") {
      const s = allocSlot(ctx, 32);
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

// A call `obj.method(args)` where method is an inline member of obj's struct that returns a reference
// (the fluent `Element& init(...) { this->x = ...; return *this; }` pattern). Emit the method body inline
// with `this` bound to the object's address, then resolve to that address (the returned *this).
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
  const addr = emitInlineStructMethod(ctx, objNode, fn, expr.args);
  return { addr, type: objNode.type, size: objNode.size, layout: objNode.layout };
}

// Emit a struct member method inline into the current function: stash the object address in a temp (used
// as `this` and returned), materialize each argument into its own slot, then lower the body with `this`
// rebound and `return` suppressed. The this-context is swapped on the shared ctx and restored after.
export function emitInlineStructMethod(ctx: FnCtx, objNode: AddrNode, fn: FunctionDecl, args: Expression[]): string {
  const self = newTmp(ctx);
  ctx.lines.push(`    ${setLocal(ctx, self, addrIr(objNode.addr))}`);
  const bind = ctx.thisBind ?? NO_BIND;

  const params = new Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>();
  for (let i = 0; i < fn.params.length; i++) {
    const p = fn.params[i];
    const cls = classifyMethodParam(ctx.cg, p, bind);
    const slot = `marg${ctx.tmpCount++}`;
    ctx.localVars.set(slot, { wasmType: cls.wasmType });
    const arg = args[i];
    if (arg) {
      const v = cls.isAddr
        ? addrIr(argAddr(ctx, arg, ctx.cg.sizeOfType(ctx.cg.derefType(p.type), bind)))
        : emitValueIr(ctx, arg);
      ctx.lines.push(`    ${setLocal(ctx, slot, v)}`);
    }
    params.set(p.name, { wasmType: cls.wasmType, isAddr: cls.isAddr, type: ctx.cg.derefType(p.type), local: slot });
  }

  const save = {
    thisLayout: ctx.thisLayout, thisType: ctx.thisType, thisAddr: ctx.thisAddr,
    params: ctx.params, inlineMethod: ctx.inlineMethod, retIsValue: ctx.retIsValue,
  };
  ctx.thisLayout = objNode.layout ?? undefined;
  ctx.thisType = objNode.type ?? undefined;
  ctx.thisAddr = `(local.get $${self})`;
  ctx.params = params;
  ctx.inlineMethod = true;
  ctx.retIsValue = false;
  // Hoist the inlined body's own local declarations into the host function's local set — the top-level
  // collectLocals never saw them (the method body is a separate AST pulled in at call time), so without
  // this their `local.set` would reference an undeclared `$name`.
  if (fn.body) collectLocals(fn.body, ctx);
  if (fn.body) emitStmt(ctx, fn.body);
  Object.assign(ctx, save);

  return `(local.get $${self})`;
}

// Resolve a container element getter to an addressable node: Array.get(i) → T, HashMap value(i) → V /
// key(i) → K, HashSet key(i) → K. The element address is an lvalue into the backing store, and the
// element TYPE lets resolveAddr keep chaining (e.g. arr.get(i).field). Element type + offsets are
// derived from the template args, never hardcoded.
export function resolveContainerElem(ctx: FnCtx, expr: Expression & { kind: "call" }): AddrNode | null {
  if (expr.callee.kind !== "member_access") return null;
  const node = resolveAddr(ctx, expr.callee.object);
  if (!node || !node.type || !expr.args[0]) return null;
  // Follow typedefs / template-param bindings to the concrete container instance (e.g. RevenueDonationT →
  // Array<RevenueDonationEntry, 128>), mirroring emitContainerCall. Without this an element getter on a
  // typedef'd container stays unresolved, so `entry = table.get(i)` can't address the element and the
  // aggregate copy is silently dropped.
  let ct: TypeSpec | null = node.type;
  for (let i = 0; i < 8 && ct?.kind === "name"; i++) ct = ctx.thisBind?.types.get(ct.name) ?? ctx.cg.typedefs.get(ct.name) ?? null;
  if (!ct || ct.kind !== "template_instance") return null;
  const ctype = ct;
  const m = expr.callee.member;
  const C = (n: number) => `(i32.const ${n})`;
  const mk = (addr: string, elemType: TypeSpec): AddrNode => ({
    addr, type: elemType, size: ctx.cg.sizeOfType(elemType), layout: ctx.cg.layoutOfType(elemType),
  });

  if (ctype.name === "Array" && m === "get") {
    const info = ctx.cg.arrayInfo(ctype.args);
    if (!info) return null;
    const addr = `(i32.add ${node.addr} (i32.mul (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)}))`;
    return mk(addr, ctype.args[0]);
  }
  if (ctype.name === "HashMap" || ctype.name === "HashSet") {
    // Only the element getters are lvalues here. The member check must come BEFORE evaluating the
    // argument: this resolver runs on speculative probes (isU128Expr → resolveAddr), and eagerly
    // emitting a non-getter's argument (contains(qpi.invocator())) produced spurious fidelity
    // warnings for code the real path lowers correctly.
    if (m !== "key" && !(m === "value" && ctype.name === "HashMap")) return null;
    const info = ctype.name === "HashSet" ? ctx.cg.hashsetInfo(ctype.args) : ctx.cg.hashmapInfo(ctype.args);
    if (!info) return null;
    const elem = `(call $hm_elem ${node.addr} (i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)}) ${C(info.elemSize)})`;
    if (m === "key") return mk(elem, ctype.args[0]);
    if (m === "value" && ctype.name === "HashMap") return mk(`(i32.add ${elem} ${C(info.valOff!)})`, ctype.args[1]);
  }
  // Collection.element(i) → &_elements[i & (L-1)].value: an lvalue of element type T, so element(i).field
  // chains. (A scalar T also flows as a value through emitContainerCall's compiled getter.)
  if (ctype.name === "Collection" && m === "element") {
    const info = ctx.cg.collectionInfo(ctype.args);
    if (!info) return null;
    const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)})`;
    const addr = `(i32.add ${node.addr} (i32.add ${C(info.elementsOff + info.valueOff)} (i32.mul ${idx} ${C(info.stride)})))`;
    return mk(addr, info.elemType);
  }
  // LinkedList.element(i) → &_nodes[i & (L-1)].value — same lvalue chaining as Collection.
  if (ctype.name === "LinkedList" && m === "element") {
    const info = ctx.cg.linkedListInfo(ctype.args);
    if (!info) return null;
    const idx = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[0])}) ${C(info.L - 1)})`;
    const addr = `(i32.add ${node.addr} (i32.add ${C(info.nodesOff + info.valueOff)} (i32.mul ${idx} ${C(info.stride)})))`;
    return mk(addr, info.elemType);
  }
  return null;
}

// qpi.* zero-arg accessors that return a 32-byte id by value, written to an out address.
export const QPI_ID_PRODUCERS: Record<string, string> = {
  invocator: "$qpi_invocator",
  originator: "$qpi_originator",
  getPrevSpectrumDigest: "$qpi_prevSpectrumDigest",
  getPrevUniverseDigest: "$qpi_prevUniverseDigest",
  getPrevComputerDigest: "$qpi_prevComputerDigest",
};

// Aggregate construction `Type{ a, b, c }` written into dstAddr: zero the target, then store each arg into
// the corresponding field (declaration order). Scalars store by value, aggregate fields copy by address.
// Returns false if the type has no resolvable layout.
export function emitConstruct(ctx: FnCtx, dstAddr: string, type: TypeSpec, args: Expression[]): boolean {
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

// Typed local.set line: the value's width is checked against the local's declared wasm type, so an
// i64 flowing into an i32 address temp (or vice versa) throws at the emission site.
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

// Address of an argument: an lvalue/SELF directly, else materialize the scalar value into scratch.
export function argAddr(ctx: FnCtx, expr: Expression, size: number): string {
  const a = emitAddr(ctx, expr);
  if (a) return a;
  const s = allocSlot(ctx, size);
  ctx.lines.push(`    ${storeAt(s, size, emitValue(ctx, expr))}`);
  return s;
}

export function addrOf(ptr: string, offset: number): string {
  return ir.emit(ir.addr0(ir.raw(ptr, "i32"), offset));
}

// Load a scalar into the i64 value model. Signed sub-64-bit fields MUST sign-extend — else a sint32 holding
// -1 reads back as 4294967295, and `>= 0` guards (e.g. the proposal-index iteration `while ((i = next()) >=
// 0)`) never go false → infinite loop. Default unsigned (the common case + back-compat).
export function loadAt(addr: string, size: number, signed = false): string {
  return ir.emit(loadAtIr(addr, size, signed));
}

// Same load, as a typed node — for value-channel callers holding a string address (resolveAddr/Lvalue
// stay string-typed until the statement channel converts).
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

// Narrow a 64-bit register value to a sub-64-bit scalar type, matching a C++ conversion: unsigned types mask
// to width, signed types sign-extend from width, bit/bool collapse to 0/1. 64-bit and non-scalar targets are
// identity. A store to a typed field already truncates on write (storeAt); this covers in-register uses of a
// cast result — a compare or arithmetic on `static_cast<uint8>(x)` before any store — that must observe the
// narrowed value, e.g. `static_cast<uint8>(300) == 44` is true natively.
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
