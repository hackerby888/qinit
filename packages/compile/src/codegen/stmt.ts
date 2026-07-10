import { emitCall } from "./calls/dispatch";
import { emitAssetIter } from "./calls/containers";
import { SCALAR_SIZE, C_SCALAR_NAMES } from "./tables";
import { isAutoType, resolveAliasType, emitValueIr, narrowLocalIr, emitValue, emitAssign } from "./value";
import { setLocal, castInfo, resolveAddr, emitAddr, addrIr, emitConstruct, tryLvalueAddr, isUint128, allocSlotIr, loadAt, isSignedScalarType, storeAt } from "./addr";
import { Codegen } from "./cg";
import { FnCtx, StructLayout, HelperInfo, Bindings, NO_BIND } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import * as ir from "../ir";

// ---- function body codegen ----

// A scratch i32 local (holds an address). Declared lazily; emitted in the function's local list.
export function newTmp(ctx: FnCtx): string {
  const n = `tmp${ctx.tmpCount++}`;
  ctx.localVars.set(n, { wasmType: "i32" });
  return n;
}

export function emitFunction(
  cg: Codegen,
  label: string,
  fn: FunctionDecl | null,
  state: StructLayout,
  inL: StructLayout,
  outL: StructLayout,
  localsL: StructLayout,
  paramAliases?: Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>,
): string {
  const ctx: FnCtx = { cg, state, in: inL, out: outL, locals: localsL, localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0, hasStateParam: true, params: paramAliases };

  // Pre-scan for local variable declarations (must be declared at function top in WAT)
  if (fn?.body) collectLocals(fn.body, ctx);

  const header = `  (func ${label} (param $ctx i32) (param $state i32) (param $in i32) (param $out i32) (param $locals i32)`;

  if (fn?.body) {
    emitStmt(ctx, fn.body);
  }

  // Build local decls AFTER emit so scratch temps created during lowering are included.
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);

  return [header, ...localDecls, ...ctx.lines, "  )"].join("\n");
}

// Emit a value-helper (e.g. toReturnCode) as a wasm function with its own scalar/address parameters
// and an optional i64 result. Helpers are static and pure — they take no ctx/state/in/out/locals.
export function emitHelperFunction(cg: Codegen, info: HelperInfo, fn: { body?: Statement }, stateLayout: StructLayout, bind?: Bindings): string {
  const empty = { size: 0, align: 1, fields: new Map() };
  const ctx: FnCtx = {
    cg, state: stateLayout, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: info.retIsValue,
    // For an instantiated template free fn the body resolves T/L through these bindings (e.g. `L`→4).
    thisBind: bind,
  };
  // An aggregate-returning helper (`id liquidityPov(...)`) gets a leading $ret destination-address param;
  // `return e` copies the 32/N-byte value there. The caller allocates the slot and passes its address.
  if (info.retAgg) {
    ctx.retAddr = "(local.get $ret)";
    ctx.retAggSize = info.retAgg;
  }
  for (const p of info.params) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: p.type });

  if (fn.body) collectLocals(fn.body, ctx);

  // By-value aggregate params: bind the name to a private copy, so callee writes stay local (C++ value
  // semantics). The `local` override is honored at every param-address read.
  for (const p of info.params) {
    if (!p.byValAgg) continue;
    const size = cg.sizeOfType(p.type, bind ?? NO_BIND);
    if (!(size > 0)) continue;
    const cp = `bv_${p.name}`;
    ctx.localVars.set(cp, { wasmType: "i32" });
    ctx.lines.push(`    ${setLocal(ctx, cp, ir.call("$qpiAllocLocals", ir.i32c(size)))}`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(cp, "i32"), ir.getL(p.name, "i32"), ir.i32c(size)))}`);
    ctx.params!.get(p.name)!.local = cp;
  }

  const retParam = info.retAgg ? "(param $ret i32) " : "";
  const paramDecls = info.params.map((p) => `(param $${p.name} ${p.wasmType})`).join(" ");
  const result = info.retIsValue ? " (result i64)" : "";
  const header = `  (func ${info.label} ${retParam}${paramDecls}${result}`.replace(/\s+\)/, ")");

  if (fn.body) emitStmt(ctx, fn.body);

  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);
  // A value helper needs a fallthrough result for control paths that do not hit a return.
  const tail = info.retIsValue ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...ctx.lines, ...tail, "  )"].join("\n");
}

export function collectLocals(stmt: Statement, ctx: FnCtx): void {
  switch (stmt.kind) {
    case "compound":
      for (const s of stmt.body) collectLocals(s, ctx);
      break;
    case "if":
      collectLocals(stmt.then, ctx);
      if (stmt.else_) collectLocals(stmt.else_, ctx);
      break;
    case "for":
      if (stmt.init) collectLocals(stmt.init, ctx);
      collectLocals(stmt.body, ctx);
      break;
    case "while":
      collectLocals(stmt.body, ctx);
      break;
    case "do_while":
      collectLocals(stmt.body, ctx);
      break;
    case "switch":
      collectLocals(stmt.body, ctx);
      break;
    case "declaration": {
      // A struct declared inside a function body (QUTIL setupNewProposal's `struct Shareholder {...}`) isn't in
      // globalStructs, so sizeof(Shareholder) and member offsets wouldn't resolve. Register it so the body's
      // pointer/subscript/member accesses see its layout. (Global registration is fine — names are unique here.)
      if (stmt.decl.kind === "struct") {
        const s = stmt.decl as StructDecl;
        if (s.name && !ctx.cg.globalStructs.has(s.name)) ctx.cg.globalStructs.set(s.name, s);
        break;
      }
      // Function-scope alias (`using Local = sint64;`): record it so locals declared with the
      // alias name resolve as known types.
      if (stmt.decl.kind === "typedef_decl") {
        const td = stmt.decl as { name: string; type: TypeSpec };
        if (!ctx.cg.typedefs.has(td.name)) ctx.cg.typedefs.set(td.name, td.type);
        break;
      }
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        // reference/pointer locals hold an address (i32); scalars use the i64 value model. A __ScopedScratchpad
        // or an Asset*Iterator local also holds an address (its scratch / iterator buffer base).
        const holdsAddr = v.type.kind === "name" && /(ScopedScratchpad|Iterator)$/.test(v.type.name);
        const b = ctx.thisBind ?? NO_BIND;

        // `auto` locals take their shape from the initializer: a cast supplies the full type
        // (auto* queue = reinterpret_cast<sint64_4*>(...)), a subscript of a typed pointer supplies
        // the element type (auto curRange = queue[i]). Undeduced auto stays a scalar.
        let dType = v.type;
        if (isAutoType(dType) && v.init) {
          const ci = castInfo(v.init);
          if (ci) {
            dType = ci.type;
          } else if (v.init.kind === "subscript" && v.init.object.kind === "identifier") {
            const ot = ctx.localVars.get(v.init.object.name)?.type;
            const op = ot ? resolveAliasType(ctx.cg, ot) : null;
            if (op?.kind === "pointer") {
              dType = op.pointee;
            }
          }
        }

        // A local of an unresolvable named type would silently corrupt the locals layout (size 0,
        // scalar fallback) — reject it here, where every declaration passes exactly once.
        if (dType.kind === "name" && !isAutoType(dType) && SCALAR_SIZE[dType.name] === undefined &&
            !C_SCALAR_NAMES.has(dType.name) && !dType.name.includes("::") &&
            !b.types.has(dType.name) && !ctx.cg.typedefs.has(dType.name) && !ctx.cg.enumNames.has(dType.name) &&
            !ctx.cg.structByName(dType.name, b)) {
          ctx.cg.error(`unknown type '${dType.name}' in declaration of '${v.name}'`, stmt.span.line);
        }

        // A struct-typed local (DateAndTime begin = *this) lives in an allocated slot; its wasm local
        // holds the slot address so member reads and method dispatch resolve through it.
        const concrete = dType.kind === "name" && b.types.has(dType.name) ? b.types.get(dType.name)! : dType;
        const isAgg = !holdsAddr && dType.kind !== "reference" && dType.kind !== "pointer" && ctx.cg.isAggregateType(concrete);
        const isRef = dType.kind === "reference" || dType.kind === "pointer" || holdsAddr || isAgg;
        // In a ProposalVoting proxy method the `pv`/`qpi` aliases (`ProposalVotingType& pv = this->pv`) are
        // bound as the function's own parameters, not locals — skip them here.
        if (ctx.proxyClass && isRef && (v.name === "pv" || v.name === "qpi")) break;
        const wasmType: "i32" | "i64" = isRef ? "i32" : "i64";
        if (!ctx.localVars.has(v.name)) {
          ctx.localVars.set(v.name, { wasmType, type: resolveAliasType(ctx.cg, concrete) });
        }
      }
      break;
    }
  }
}

// Collect goto-target label names appearing anywhere in a statement subtree.
export function collectGotosIn(stmt: Statement, out: Set<string>): void {
  switch (stmt.kind) {
    case "goto": out.add(stmt.label); break;
    case "compound": for (const s of stmt.body) collectGotosIn(s, out); break;
    case "if": collectGotosIn(stmt.then, out); if (stmt.else_) collectGotosIn(stmt.else_, out); break;
    case "for": case "while": case "do_while": case "switch": collectGotosIn(stmt.body, out); break;
  }
}

// Collect label names defined anywhere in a statement subtree.
export function collectLabelsIn(stmt: Statement, out: Set<string>): void {
  switch (stmt.kind) {
    case "label": out.add(stmt.name); break;
    case "compound": for (const s of stmt.body) collectLabelsIn(s, out); break;
    case "if": collectLabelsIn(stmt.then, out); if (stmt.else_) collectLabelsIn(stmt.else_, out); break;
    case "for": case "while": case "do_while": case "switch": collectLabelsIn(stmt.body, out); break;
  }
}

// Emit a brace block, lowering forward gotos (relooper-lite). A `goto L` that jumps forward to a label
// L rooted in a later sibling becomes a `br` out of a synthesized block wrapping the siblings between
// the goto and L; control lands right before L's sibling, reproducing the jump via natural fall-through.
// (qpi.h's HashMap::set is the canonical case: `goto reuse_slot` exits both probing loops.)
export function emitCompound(ctx: FnCtx, body: Statement[]): void {
  const spBase = ctx.scratchpadScope?.length ?? 0;
  // child index where each goto-targeted label is rooted
  const labelChild = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const labels = new Set<string>();
    collectLabelsIn(body[i], labels);
    for (const l of labels) if (!labelChild.has(l)) labelChild.set(l, i);
  }

  // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block that ends right
  // before the label-bearing sibling; a `goto L` becomes `br $goto_L`. The block must enclose every goto to
  // L (so it opens at or before the earliest such goto) and close at the label.
  const wasmLabel = new Map<string, string>();
  const blocks: { wl: string; firstGoto: number; closeAt: number }[] = [];
  for (let i = 0; i < body.length; i++) {
    const gotos = new Set<string>();
    collectGotosIn(body[i], gotos);
    for (const g of gotos) {
      const lc = labelChild.get(g);
      if (lc === undefined || lc <= i || wasmLabel.has(g)) continue;
      const wl = `$goto_${g}_${ctx.loopCount++}`;
      wasmLabel.set(g, wl);
      blocks.push({ wl, firstGoto: i, closeAt: lc });
    }
  }

  if (wasmLabel.size === 0) {
    for (const s of body) emitStmt(ctx, s);
    return;
  }

  if (!ctx.gotoLabels) ctx.gotoLabels = new Map();
  for (const [g, wl] of wasmLabel) ctx.gotoLabels.set(g, wl);

  // WASM blocks must nest (LIFO). With multiple labels whose [firstGoto..closeAt] ranges OVERLAP without
  // containment (e.g. TransferSharesToManyV1's interleaved `goto insufficientShares` / `goto transferFailed`),
  // opening each at its own firstGoto produces an outer block that closes before an inner one — illegal, and
  // the earlier-closing block silently never closes at its label. Open ALL of them together at the earliest
  // firstGoto, ordered by closeAt descending (latest close = outermost). Wrapping a few extra leading siblings
  // is harmless (they fall through), and the nesting is always valid.
  const openChild = Math.min(...blocks.map((b) => b.firstGoto));
  blocks.sort((a, b) => b.closeAt - a.closeAt);
  const closeStack: number[] = [];
  for (let i = 0; i < body.length; i++) {
    while (closeStack.length && closeStack[closeStack.length - 1] === i) {
      ctx.lines.push(`    )`);
      closeStack.pop();
    }
    if (i === openChild) {
      for (const b of blocks) {
        ctx.lines.push(`    (block ${b.wl}`);
        closeStack.push(b.closeAt);
      }
    }
    emitStmt(ctx, body[i]);
  }
  while (closeStack.length) {
    ctx.lines.push(`    )`);
    closeStack.pop();
  }

  // Scope exit: run __ScopedScratchpad destructors declared in this compound (RAII, LIFO). Without the
  // release, sequential container cleanups within one dispatch sum their scratch instead of reusing it and
  // overrun the arena. (An early `return` skips these lines — that leak is bounded by the per-dispatch
  // arena reset.)
  if (ctx.scratchpadScope && ctx.scratchpadScope.length > spBase) {
    for (let i = ctx.scratchpadScope.length - 1; i >= spBase; i--) {
      ctx.lines.push(`    ${ir.emit(ir.call("$releaseScratchpad", ir.getL(ctx.scratchpadScope[i], "i32")))}`);
    }
    ctx.scratchpadScope.length = spBase;
  }

  for (const g of wasmLabel.keys()) ctx.gotoLabels!.delete(g);
}

export function emitStmt(ctx: FnCtx, stmt: Statement): void {
  switch (stmt.kind) {
    case "compound":
      emitCompound(ctx, stmt.body);
      break;

    case "expression": {
      const w = emitExprDrop(ctx, stmt.expr);
      if (w) ctx.lines.push(`    ${w}`);
      break;
    }

    case "declaration": {
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        // The collect pass stored the declared type with `auto` resolved from the initializer;
        // classification here must agree with the wasm local type it chose.
        const declared = ctx.localVars.get(v.name)?.type ?? v.type;
        // __ScopedScratchpad scratchpad(size, initZero): bump a scratch buffer off the arena; the local holds
        // its base address, read back by `.ptr`. (release is a no-op — the arena resets per dispatch.)
        if (v.type.kind === "name" && /ScopedScratchpad$/.test(v.type.name)) {
          const args = v.init && (v.init.kind === "construct" || v.init.kind === "call") ? v.init.args : [];
          const size = args[0] ? emitValueIr(ctx, args[0]) : ir.i64c(0);
          const initZero = args[1] ? ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, args[1])) : ir.i32c(0);
          ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$acquireScratchpad", size, initZero))}`);
          (ctx.scratchpadLocals ??= new Set()).add(v.name);
          (ctx.scratchpadScope ??= []).push(v.name);
          break;
        }
        // AssetOwnership/PossessionIterator iter(asset): an 8-byte iterator buffer (count@0, cursor@4); the
        // constructor runs the enumerate. Track its type so iter.possessor()/reachedEnd()/next() dispatch.
        if (v.type.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(v.type.name)) {
          ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$qpiAllocLocals", ir.i32c(8)))}`);
          (ctx.refLocals ??= new Map()).set(v.name, v.type);
          const arg = v.init && (v.init.kind === "construct" || v.init.kind === "call") ? v.init.args[0] : undefined;
          if (arg) {
            emitAssetIter(ctx, {
              kind: "call", span: stmt.span, args: [arg],
              callee: { kind: "member_access", span: stmt.span, object: { kind: "identifier", name: v.name, span: stmt.span }, member: "begin" },
            } as Expression & { kind: "call" }, "stmt");
          }
          break;
        }
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it
        // resolves through that address. The referent type (Element, PoV, ...) drives field offsets. A pointer
        // keeps its pointer type (not the pointee) so `p[i]` subscripts.
        if (declared.kind === "reference" || declared.kind === "pointer") {
          // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
          if (ctx.proxyClass && (v.name === "pv" || v.name === "qpi")) break;
          if (v.init) {
            const node = resolveAddr(ctx, v.init);
            // Fall back to emitAddr for initializers that aren't plain lvalues but still yield an address —
            // an asset-iterator getter (`const id& possessor = iter.possessor()`), an id producer, etc.
            const addr = node?.addr ?? emitAddr(ctx, v.init);
            if (addr) {
              if (!ctx.refLocals) ctx.refLocals = new Map();
              // A pointer local keeps its pointer type so resolveAddr's subscript path fires (`shareholders[i]`);
              // a reference binds to its referent type for direct member access.
              const refType = declared.kind === "pointer" ? declared : (node?.type ?? declared.refereed);
              ctx.refLocals.set(v.name, refType);
              ctx.lines.push(`    ${setLocal(ctx, v.name, addrIr(addr))}`);
            } else {
              ctx.cg.warn(`unsupported reference initializer for '${v.name}'`, stmt.span.line);
            }
          }
          break;
        }
        // struct-typed local (DateAndTime begin = *this): allocate a slot the wasm local points at, so
        // member reads and method dispatch on it resolve through an address. Copy-init from an lvalue /
        // materialized rvalue; a constructor-style init runs emitConstruct; otherwise zero-init (every
        // qpi.h default constructor zeroes its storage).
        {
          const db = ctx.thisBind ?? NO_BIND;
          const concrete = declared.kind === "name" && db.types.has(declared.name) ? db.types.get(declared.name)! : declared;
          if (ctx.cg.isAggregateType(concrete)) {
            // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this
            // branch must consume the declaration even when the size is unknown. An unsized array
            // (`const int daysInMonth[] = {...}`) takes its length from the initializer.
            let aggSz = ctx.cg.sizeOfType(concrete, db);
            if (concrete.kind === "array" && aggSz <= 0 && v.init?.kind === "initializer_list") {
              aggSz = ctx.cg.sizeOfType(concrete.elem, db) * (((v.init as any).exprs ?? []).length);
            }
            const sz = Math.max(aggSz, 8);
            ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$qpiAllocLocals", ir.i32c(sz)))}`);
            (ctx.refLocals ??= new Map()).set(v.name, concrete);
            const ctorArgs = v.init && (v.init.kind === "construct" || (v.init.kind === "call" && v.init.callee.kind === "identifier" && (v.init.callee as any).name === (v.type.kind === "name" ? v.type.name : ""))) ? (v.init as any).args : null;
            if (ctorArgs && emitConstruct(ctx, `(local.get $${v.name})`, concrete, ctorArgs)) {
              break;
            }
            // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise;
            // struct locals go field-wise through emitConstruct.
            if (v.init?.kind === "initializer_list") {
              if (concrete.kind === "array") {
                const esz = ctx.cg.sizeOfType(concrete.elem, db);
                ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(v.name, "i32"), ir.i32c(sz), ir.i32c(0)))}`);
                ((v.init as any).exprs ?? []).forEach((e: Expression, i: number) => {
                  ctx.lines.push(`    ${ir.emit(ir.storeScalar(ir.addr0(ir.getL(v.name, "i32"), i * esz), esz, emitValueIr(ctx, e)))}`);
                });
                break;
              }
              if (emitConstruct(ctx, `(local.get $${v.name})`, concrete, (v.init as any).exprs ?? [])) {
                break;
              }
            }
            if (v.init) {
              const src = resolveAddr(ctx, v.init)?.addr ?? emitAddr(ctx, v.init);
              if (src) {
                ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(v.name, "i32"), addrIr(src), ir.i32c(sz)))}`);
                break;
              }
              ctx.cg.warn(`unsupported struct-local initializer for '${v.name}'`, stmt.span.line);
            }
            ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(v.name, "i32"), ir.i32c(sz), ir.i32c(0)))}`);
            break;
          }
        }
        if (v.init) {
          ctx.lines.push(`    ${setLocal(ctx, v.name, narrowLocalIr(ctx, v.name, emitValueIr(ctx, v.init)))}`);
        }
      }
      break;
    }

    case "if": {
      const cond = emitValue(ctx, stmt.cond);
      ctx.lines.push(`    (if (i64.ne (i64.const 0) ${cond}) (then`);
      emitStmt(ctx, stmt.then);
      if (stmt.else_) {
        ctx.lines.push(`    ) (else`);
        emitStmt(ctx, stmt.else_);
      }
      ctx.lines.push(`    ))`);
      break;
    }

    case "for": {
      if (stmt.init) emitStmt(ctx, stmt.init);
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      if (stmt.cond) {
        ctx.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(ctx, stmt.cond)}))`);
      }
      // continue jumps out of the $cont block to run the update, then loops — matching C semantics.
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      if (stmt.update) {
        const u = emitExprDrop(ctx, stmt.update);
        if (u) ctx.lines.push(`      ${u}`);
      }
      ctx.lines.push(`      (br ${loop})))`);
      break;
    }

    case "while": {
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      ctx.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(ctx, stmt.cond)}))`);
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      ctx.lines.push(`      (br ${loop})))`);
      break;
    }

    case "do_while": {
      const n = ctx.loopCount++;
      const brk = `$brk${n}`, loop = `$loop${n}`, cont = `$cont${n}`;
      ctx.lines.push(`    (block ${brk} (loop ${loop}`);
      ctx.lines.push(`      (block ${cont}`);
      ctx.loops.push({ brk, cont });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      ctx.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${emitValue(ctx, stmt.cond)}))))`);
      break;
    }

    case "switch": {
      const n = ctx.loopCount++;
      const brk = `$swbrk${n}`, sw = `sw${n}`;
      ctx.localVars.set(sw, { wasmType: "i64" });
      ctx.lines.push(`    ${setLocal(ctx, sw, emitValueIr(ctx, stmt.cond))}`);
      ctx.lines.push(`    (block ${brk}`);
      // break targets the switch; continue still targets the enclosing loop (if any).
      const cont = ctx.loops.length ? ctx.loops[ctx.loops.length - 1].cont : brk;
      ctx.loops.push({ brk, cont });
      const body = stmt.body.kind === "compound" ? stmt.body.body : [stmt.body];

      // Group statements by case/default markers. Each group gets a block label so
      // dispatch can branch to it, and fallthrough works naturally: a body without an
      // explicit break exits its enclosing block and lands on the next body in source order.
      const groups: { test: string | null; stmts: Statement[]; label: string }[] = [];
      let caseIdx = 0;
      for (const s of body) {
        if (s.kind === "case") {
          groups.push({
            test: `(i64.eq (local.get $${sw}) ${emitValue(ctx, s.value)})`,
            stmts: [],
            label: `$swcase${n}_${caseIdx++}`,
          });
        } else if (s.kind === "default") {
          groups.push({ test: null, stmts: [], label: `$swdef${n}` });
        } else if (groups.length) {
          groups[groups.length - 1].stmts.push(s);
        }
      }

      // Open blocks from last group (outermost) to first (innermost) so that the
      // dispatch, placed inside all of them, can br to any case/default label.
      for (let i = groups.length - 1; i >= 0; i--) {
        ctx.lines.push(`      (block ${groups[i].label}`);
      }

      // Dispatch chain — one conditional branch per non-default case.
      for (const g of groups) {
        if (g.test) {
          ctx.lines.push(`        (if ${g.test} (then (br ${g.label})))`);
        }
      }

      // No match falls through to default group if one exists, otherwise breaks.
      const defaultGroup = groups.find((g) => g.test === null);
      ctx.lines.push(`        (br ${defaultGroup ? defaultGroup.label : brk})`);

      // Close blocks in source order, emitting each body between block boundaries.
      // After a body without a break, control naturally exits the enclosing block
      // and reaches the next body — reproducing C++ fallthrough.
      for (const g of groups) {
        ctx.lines.push(`      )`);
        for (const s of g.stmts) {
          emitStmt(ctx, s);
        }
      }

      ctx.loops.pop();
      ctx.lines.push(`    )`);
      break;
    }

    case "break":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].brk})`);
      else ctx.cg.warn(`break outside loop`, stmt.span.line);
      break;

    case "continue":
      if (ctx.loops.length) ctx.lines.push(`    (br ${ctx.loops[ctx.loops.length - 1].cont})`);
      else ctx.cg.warn(`continue outside loop`, stmt.span.line);
      break;

    case "return":
      // an inlined struct method's `return *this` carries no value out (the object flows via thisAddr);
      // emitting a wasm return here would wrongly exit the enclosing function.
      if (ctx.inlineMethod) break;
      if (stmt.value && ctx.retAddr) {
        // aggregate-returning helper: copy the returned value into the caller-supplied dest, then return
        const src = emitAddr(ctx, stmt.value);
        if (src) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ctx.retAddr!), addrIr(src), ir.i32c(ctx.retAggSize!)))}`);
        ctx.lines.push(`    (return)`);
      } else if (stmt.value && ctx.retIsValue) {
        ctx.lines.push(`    (return ${emitValue(ctx, stmt.value)})`);
      } else {
        ctx.lines.push(`    (return)`);
      }
      break;

    case "static_assert":
    case "empty":
    case "label":
      break;

    case "goto": {
      const wl = ctx.gotoLabels?.get(stmt.label);
      if (wl) ctx.lines.push(`    (br ${wl})`);
      else ctx.cg.warn(`unsupported goto '${stmt.label}'`, stmt.span.line);
      break;
    }

    default:
      ctx.cg.warn(`unsupported statement '${stmt.kind}'`, stmt.span.line);
      break;
  }
}

// Emit an expression used as a statement (side effects only). Calls/assignments push their own
// lines to ctx; only inc/dec returns a WAT string for the caller to push.
export function emitExprDrop(ctx: FnCtx, expr: Expression): string {
  if (expr.kind === "assign") return emitAssign(ctx, expr);
  if (expr.kind === "call") {
    emitCall(ctx, expr);
    return "";
  }
  if (expr.kind === "postfix_op" || expr.kind === "prefix_op") return emitIncDec(ctx, expr);
  // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
  if (expr.kind === "sequence") {
    for (const e of expr.exprs) {
      const w = emitExprDrop(ctx, e);
      if (w) ctx.lines.push(`    ${w}`);
    }
    return "";
  }
  return "";
}

// A name held in a wasm local slot: a body-declared local OR a scalar (by-value) parameter. Both are
// read via local.get and written via local.set (wasm parameters are mutable locals).
export function isScalarLocal(ctx: FnCtx, name: string): boolean {
  if (ctx.localVars.has(name)) return true;
  const p = ctx.params?.get(name);
  return !!p && !p.isAddr;
}

export function emitIncDec(ctx: FnCtx, expr: Expression): string {
  const arg = expr.kind === "postfix_op" || expr.kind === "prefix_op" ? expr.arg : expr;
  const op = (expr as any).op === "++" ? "i64.add" : "i64.sub";
  // A scalar local/value-param increments in place via local.set.
  if (arg.kind === "identifier" && isScalarLocal(ctx, arg.name)) {
    return `(local.set $${arg.name} (${op} (local.get $${arg.name}) (i64.const 1)))`;
  }
  // Otherwise a member/element lvalue: load, adjust, store back.
  const addr = tryLvalueAddr(ctx, arg);
  if (addr) {
    // uint128: a scalar load-modify-store touches only the low limb and loses the carry/borrow —
    // route through the $u128_* helpers instead (uint128.h operator++ carries across limbs).
    if (isUint128(ctx.cg, addr.type ?? null)) {
      const one = allocSlotIr(ctx, 16);
      ctx.lines.push(`    ${ir.emit(ir.call("$u128_set", one, ir.i64c(1), ir.i64c(0)))}`);
      const res = allocSlotIr(ctx, 16);
      ctx.lines.push(`    ${ir.emit(ir.call(op === "i64.add" ? "$u128_add" : "$u128_sub", res, addrIr(addr.addr), one))}`);
      return ir.emit(ir.call("$copyMem", addrIr(addr.addr), res, ir.i32c(16)));
    }
    const load = loadAt(addr.addr, addr.size, isSignedScalarType(addr.type));
    const stored = `(${op} ${load} (i64.const 1))`;
    return storeAt(addr.addr, addr.size, stored);
  }
  return "";
}
