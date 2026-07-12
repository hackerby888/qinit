import { emitCall } from "./calls/dispatch";
import { callCompiled, emitAssetIter } from "./calls/containers";
import { SCALAR_SIZE, C_SCALAR_NAMES } from "./tables";
import { isAutoType, resolveAliasType, emitValueIr, narrowLocalIr, emitValue, emitAssign, emitU128Ir } from "./value";
import { setLocal, castInfo, resolveAddr, emitAddr, addrIr, emitConstruct, emitInlineStructMethod, tryLvalueAddr, isUint128, allocSlotIr, loadAt, isSignedScalarType, storeAt, narrowCast } from "./addr";
import { Codegen } from "./cg";
import { FnCtx, StructLayout, HelperInfo, Bindings, NO_BIND } from "./types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";
import * as ir from "../ir";

function emitArrayInitializer(ctx: FnCtx, base: ir.Ir, type: TypeSpec & { kind: "array" }, init: Expression & { kind: "initializer_list" }): void {
  const b = ctx.thisBind ?? NO_BIND;
  const elemSize = ctx.cg.sizeOfType(type.elem, b);
  init.exprs.forEach((expr, index) => {
    const dst = ir.addr0(base, index * elemSize);
    if (type.elem.kind === "array" && expr.kind === "initializer_list") {
      emitArrayInitializer(ctx, dst, type.elem, expr);
    } else if (ctx.cg.isAggregateType(type.elem) && (expr.kind === "initializer_list" || expr.kind === "construct")) {
      const args = expr.kind === "initializer_list" ? expr.exprs : expr.args;
      emitConstruct(ctx, ir.emit(dst), type.elem, args);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.storeScalar(dst, elemSize, emitValueIr(ctx, expr)))}`);
    }
  });
}

// ---- function body codegen ----

// A scratch i32 local (holds an address). Declared lazily; emitted in the function's local list.
export function newTmp(ctx: FnCtx): string {
  let n: string;
  do n = `__qinit_tmp${ctx.tmpCount++}`;
  while (ctx.localVars.has(n) || ctx.params?.has(n));
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
  const contextType = fn?.params[0] ? cg.derefType(fn.params[0].type) : null;
  const qpiContext = contextType?.kind === "name" && contextType.name === "QpiContextProcedureCall" ? "procedure"
    : contextType?.kind === "name" && contextType.name === "QpiContextFunctionCall" ? "function"
    : undefined;
  const params = new Map(paramAliases ?? []);
  if (fn?.params[0]?.name === "qpi" && contextType && qpiContext) {
    params.set("qpi", { wasmType: "i32", isAddr: true, type: contextType, local: "__qinit_ctx" });
  }
  const lookup = cg.namespaceContextOf(fn);
  const ctx: FnCtx = {
    cg, state, in: inL, out: outL, locals: localsL, localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    hasStateParam: true, params, qpiContext,
    sourceNamespace: lookup.sourceNamespace, usingNamespaces: lookup.usingNamespaces,
  };

  // Pre-scan for local variable declarations (must be declared at function top in WAT)
  if (fn?.body) collectLocals(fn.body, ctx);

  const header = `  (func ${label} (param $__qinit_ctx i32) (param $__qinit_state i32) (param $__qinit_in i32) (param $__qinit_out i32) (param $__qinit_locals i32)`;

  if (fn?.body) {
    emitStmt(ctx, fn.body);
  }

  // Build local decls AFTER emit so scratch temps created during lowering are included.
  const localDecls = [...ctx.localVars.entries()].map(([n, t]) => `    (local $${n} ${t.wasmType})`);

  return [header, ...localDecls, ...ctx.lines, "  )"].join("\n");
}

// Emit a value-helper (e.g. toReturnCode) as a wasm function with its own scalar/address parameters
export function emitHelperFunction(cg: Codegen, info: HelperInfo, fn: { body?: Statement }, stateLayout: StructLayout, bind?: Bindings): string {
  const empty = { size: 0, align: 1, fields: new Map() };
  const ctx: FnCtx = {
    cg, state: stateLayout, in: empty, out: empty, locals: empty,
    localVars: new Map(), lines: [], tmpCount: 0, loops: [], loopCount: 0,
    params: new Map(), retIsValue: info.retIsValue,
    retTypeName: info.retType?.kind === "name" ? info.retType.name : undefined,
    // For an instantiated template free fn the body resolves T/L through these bindings (e.g. `L`→4).
    thisBind: bind,
    sourceNamespace: info.sourceNamespace,
    usingNamespaces: info.usingNamespaces,
  };
  // An aggregate-returning helper (`id liquidityPov(...)`) gets a leading $ret destination-address param; `return e` copies the 32/N-byte value there.
  if (info.retAgg) {
    ctx.retAddr = "(local.get $__qinit_ret)";
    ctx.retAggSize = info.retAgg;
    ctx.retType = info.retType;
  }
  for (const p of info.params) ctx.params!.set(p.name, { wasmType: p.wasmType, isAddr: p.isAddr, type: p.type });

  if (fn.body) collectLocals(fn.body, ctx);

  // By-value aggregate params: bind the name to a private copy, so callee writes stay local (C++ value semantics).
  for (const p of info.params) {
    if (!p.byValAgg) continue;
    const size = cg.sizeOfType(p.type, bind ?? NO_BIND);
    if (!(size > 0)) continue;
    let cp = `__qinit_bv_${p.name}`;
    while (ctx.localVars.has(cp) || ctx.params?.has(cp)) cp += "_";
    ctx.localVars.set(cp, { wasmType: "i32" });
    ctx.lines.push(`    ${setLocal(ctx, cp, ir.call("$qpiAllocLocals", ir.i32c(size)))}`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(cp, "i32"), ir.getL(p.name, "i32"), ir.i32c(size)))}`);
    ctx.params!.get(p.name)!.local = cp;
  }

  const retParam = info.retAgg ? "(param $__qinit_ret i32) " : "";
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
      // A struct declared inside a function body (QUTIL setupNewProposal's `struct Shareholder {...}`) isn't in globalStructs, so sizeof(Shareholder) and
      if (stmt.decl.kind === "struct") {
        const s = stmt.decl as StructDecl;
        if (s.name && !ctx.cg.globalStructs.has(s.name)) ctx.cg.globalStructs.set(s.name, s);
        break;
      }
      // Function-scope alias (`using Local = sint64;`): record it so locals declared with the alias name resolve as known
      if (stmt.decl.kind === "typedef_decl") {
        const td = stmt.decl as { name: string; type: TypeSpec };
        if (!ctx.cg.typedefs.has(td.name)) ctx.cg.typedefs.set(td.name, td.type);
        break;
      }
      if (stmt.decl.kind === "variable") {
        const v = stmt.decl as VariableDecl;
        // reference/pointer locals hold an address (i32); scalars use the i64 value model. A __ScopedScratchpad
        const holdsAddr = v.type.kind === "name" && /(ScopedScratchpad|Iterator)$/.test(v.type.name);
        const b = ctx.thisBind ?? NO_BIND;

        // `auto` locals take their shape from the initializer; casts supply full type (e.g., auto* queue = reinterpret_cast<sint64_4*>(...)).
        let dType = v.type;
        if (isAutoType(dType) && v.init) {
          const ci = castInfo(v.init);
          if (ci) {
            dType = ci.type;
          } else if (v.init.kind === "identifier") {
            dType = ctx.localVars.get(v.init.name)?.type ?? ctx.params?.get(v.init.name)?.type ?? dType;
          } else if (v.init.kind === "call" && v.init.callee.kind === "identifier") {
            dType = ctx.cg.helpers.get(v.init.callee.name)?.retType ?? dType;
          } else if (v.init.kind === "call" && v.init.callee.kind === "member_access"
              && v.init.callee.object.kind === "identifier") {
            const callee = v.init.callee;
            const objectName = v.init.callee.object.name;
            const objectType = ctx.localVars.get(objectName)?.type
              ?? ctx.params?.get(objectName)?.type;
            const objectStruct = objectType ? ctx.cg.structOf(objectType, b) : null;
            const named = objectStruct?.members.find((member) => member.kind === "function"
              && (member as FunctionDecl).name === callee.member) as FunctionDecl | undefined;
            dType = named?.returnType ?? dType;
          } else if (v.init.kind === "subscript" && v.init.object.kind === "identifier") {
            const ot = ctx.localVars.get(v.init.object.name)?.type;
            const op = ot ? resolveAliasType(ctx.cg, ot) : null;
            if (op?.kind === "pointer") {
              dType = op.pointee;
            }
          }
        }

        // A local of an unresolvable named type would silently corrupt the locals layout (size 0, scalar fallback) —
        if (dType.kind === "name" && !isAutoType(dType) && SCALAR_SIZE[dType.name] === undefined &&
            !C_SCALAR_NAMES.has(dType.name) && !dType.name.includes("::") &&
            !b.types.has(dType.name) && !ctx.cg.typedefs.has(dType.name) && !ctx.cg.enumNames.has(dType.name) &&
            !ctx.cg.structByName(dType.name, b)) {
          ctx.cg.error(`unknown type '${dType.name}' in declaration of '${v.name}'`, stmt.span.line);
        }

        // A struct-typed local (DateAndTime begin = *this) lives in an allocated slot; its wasm local holds the slot
        const concrete = dType.kind === "name" && b.types.has(dType.name) ? b.types.get(dType.name)! : dType;
        const isAgg = !holdsAddr && dType.kind !== "reference" && dType.kind !== "pointer" && ctx.cg.isAggregateType(concrete);
        const isRef = dType.kind === "reference" || dType.kind === "pointer" || holdsAddr || isAgg;
        // In a ProposalVoting proxy method the `pv`/`qpi` aliases (`ProposalVotingType& pv = this->pv`) are bound as the function's own
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

function emitScratchpadReleases(ctx: FnCtx, from: number, consume: boolean): void {
  if (!ctx.scratchpadScope || ctx.scratchpadScope.length <= from) return;
  for (let i = ctx.scratchpadScope.length - 1; i >= from; i--) {
    ctx.lines.push(`    ${ir.emit(ir.call("$releaseScratchpad", ir.getL(ctx.scratchpadScope[i], "i32")))}`);
  }
  if (consume) ctx.scratchpadScope.length = from;
}

// Emit a brace block, lowering forward gotos (relooper-lite). A `goto L` that jumps forward to a label
export function emitCompound(ctx: FnCtx, body: Statement[]): void {
  const spBase = ctx.scratchpadScope?.length ?? 0;
  const scratchDepthAt = (child: number): number => {
    let depth = spBase;
    for (let i = 0; i < child; i++) {
      const statement = body[i];
      if (statement.kind !== "declaration" || statement.decl.kind !== "variable") continue;
      const type = (statement.decl as VariableDecl).type;
      if (type.kind === "name" && /ScopedScratchpad$/.test(type.name)) depth++;
    }
    return depth;
  };
  // child index where each goto-targeted label is rooted
  const labelChild = new Map<string, number>();
  for (let i = 0; i < body.length; i++) {
    const labels = new Set<string>();
    collectLabelsIn(body[i], labels);
    for (const l of labels) if (!labelChild.has(l)) labelChild.set(l, i);
  }

  // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block that
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
  } else {
    if (!ctx.gotoLabels) ctx.gotoLabels = new Map();
    for (const [g, wl] of wasmLabel) {
      ctx.gotoLabels.set(g, { label: wl, scratchDepth: scratchDepthAt(labelChild.get(g) ?? 0) });
    }

    // WASM blocks must nest (LIFO). With multiple labels whose [firstGoto..closeAt] ranges OVERLAP without
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

    for (const g of wasmLabel.keys()) ctx.gotoLabels!.delete(g);
  }

  // Scope exit: run __ScopedScratchpad destructors declared in this compound (RAII, LIFO). Without the
  emitScratchpadReleases(ctx, spBase, true);
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
        // The collect pass stored the declared type with `auto` resolved from the initializer; classification here must agree with
        const declared = ctx.localVars.get(v.name)?.type ?? v.type;
        // __ScopedScratchpad scratchpad(size, initZero): bump a scratch buffer off the arena; the local holds its base address, read back
        if (v.type.kind === "name" && /ScopedScratchpad$/.test(v.type.name)) {
          const args = v.init && (v.init.kind === "construct" || v.init.kind === "call") ? v.init.args : [];
          const size = args[0] ? emitValueIr(ctx, args[0]) : ir.i64c(0);
          const initZero = args[1] ? ir.op("i64.ne", ir.i64c(0), emitValueIr(ctx, args[1])) : ir.i32c(0);
          ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$acquireScratchpad", size, initZero))}`);
          (ctx.scratchpadLocals ??= new Set()).add(v.name);
          (ctx.scratchpadScope ??= []).push(v.name);
          break;
        }
        // AssetOwnership/PossessionIterator iter(asset): an 8-byte iterator buffer (count@0, cursor@4); the constructor runs the enumerate. Track its type so iter.possessor()/reachedEnd()/next()
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
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it resolves through that address.
        if (declared.kind === "reference" || declared.kind === "pointer") {
          // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
          if (ctx.proxyClass && (v.name === "pv" || v.name === "qpi")) break;
          if (v.init) {
            const node = resolveAddr(ctx, v.init);
            // Fall back to emitAddr for initializers that aren't plain lvalues but still yield an address — an asset-iterator
            const addr = node?.addr ?? emitAddr(ctx, v.init);
            if (addr) {
              if (!ctx.refLocals) ctx.refLocals = new Map();
              // A pointer local keeps its pointer type so resolveAddr's subscript path fires (`shareholders[i]`); a reference binds to its
              const refType = declared.kind === "pointer" ? declared : (node?.type ?? declared.refereed);
              ctx.refLocals.set(v.name, refType);
              ctx.lines.push(`    ${setLocal(ctx, v.name, addrIr(addr))}`);
            } else {
              ctx.cg.warn(`unsupported reference initializer for '${v.name}'`, stmt.span.line);
            }
          }
          break;
        }
        // struct-typed local (DateAndTime begin = *this): allocate a slot the wasm local points at, so member reads and
        {
          const db = ctx.thisBind ?? NO_BIND;
          const concrete = declared.kind === "name" && db.types.has(declared.name) ? db.types.get(declared.name)! : declared;
          if (ctx.cg.isAggregateType(concrete)) {
            // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this branch must consume the declaration
            let aggSz = ctx.cg.sizeOfType(concrete, db);
            if (concrete.kind === "array" && aggSz <= 0 && v.init?.kind === "initializer_list") {
              aggSz = ctx.cg.sizeOfType(concrete.elem, db) * (((v.init as any).exprs ?? []).length);
            }
            const sz = Math.max(aggSz, 8);
            ctx.lines.push(`    ${setLocal(ctx, v.name, ir.call("$qpiAllocLocals", ir.i32c(sz)))}`);
            (ctx.refLocals ??= new Map()).set(v.name, concrete);
            // uint128_t is a class, not a pair of fields to initialize positionally: its two-argument
            // constructor accepts (high, low), while the resident layout is (low, high). Route every
            if (v.init && isUint128(ctx.cg, concrete)) {
              ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", ir.getL(v.name, "i32"), emitU128Ir(ctx, v.init), ir.i32c(16)))}`);
              break;
            }
            const ctorArgs = v.init && (v.init.kind === "construct" || (v.init.kind === "call" && v.init.callee.kind === "identifier" && (v.init.callee as any).name === (v.type.kind === "name" ? v.type.name : ""))) ? (v.init as any).args : null;
            if (ctorArgs && emitConstruct(ctx, `(local.get $${v.name})`, concrete, ctorArgs)) {
              break;
            }
            // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise; struct locals go field-wise through emitConstruct.
            if (v.init?.kind === "initializer_list") {
              if (concrete.kind === "array") {
                ctx.lines.push(`    ${ir.emit(ir.call("$setMem", ir.getL(v.name, "i32"), ir.i32c(sz), ir.i32c(0)))}`);
                emitArrayInitializer(ctx, ir.getL(v.name, "i32"), concrete, v.init);
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
            if (ctx.cg.gtestMode && !v.init && concrete.kind === "name") {
              const struct = ctx.cg.structOf(concrete, db);
              const constructor = struct?.members.find(
                (member) => member.kind === "function" && (member as FunctionDecl).name === concrete.name && (member as FunctionDecl).body,
              ) as FunctionDecl | undefined;
              const layout = ctx.cg.layoutOfType(concrete, db);
              if (constructor && layout) {
                emitInlineStructMethod(ctx, { addr: `(local.get $${v.name})`, type: concrete, size: sz, layout }, constructor, []);
              }
            }
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
      ctx.loops.push({ brk, cont, scratchDepth: ctx.scratchpadScope?.length ?? 0 });
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
      ctx.loops.push({ brk, cont, scratchDepth: ctx.scratchpadScope?.length ?? 0 });
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
      ctx.loops.push({ brk, cont, scratchDepth: ctx.scratchpadScope?.length ?? 0 });
      emitStmt(ctx, stmt.body);
      ctx.loops.pop();
      ctx.lines.push(`      )`);
      ctx.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${emitValue(ctx, stmt.cond)}))))`);
      break;
    }

    case "switch": {
      const n = ctx.loopCount++;
      const brk = `$swbrk${n}`;
      let sw = `__qinit_sw${n}`;
      while (ctx.localVars.has(sw) || ctx.params?.has(sw)) sw += "_";
      ctx.localVars.set(sw, { wasmType: "i64" });
      ctx.lines.push(`    ${setLocal(ctx, sw, emitValueIr(ctx, stmt.cond))}`);
      ctx.lines.push(`    (block ${brk}`);
      // break targets the switch; continue still targets the enclosing loop (if any).
      const cont = ctx.loops.length ? ctx.loops[ctx.loops.length - 1].cont : brk;
      ctx.loops.push({ brk, cont, scratchDepth: ctx.scratchpadScope?.length ?? 0 });
      const body = stmt.body.kind === "compound" ? stmt.body.body : [stmt.body];

      // Group statements by case/default markers. Each group gets a block label so
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

      // Open blocks from outermost to innermost so dispatch is placed inside all of them.
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
      if (ctx.loops.length) {
        const loop = ctx.loops[ctx.loops.length - 1];
        emitScratchpadReleases(ctx, loop.scratchDepth, false);
        ctx.lines.push(`    (br ${loop.brk})`);
      }
      else ctx.cg.warn(`break outside loop`, stmt.span.line);
      break;

    case "continue":
      if (ctx.loops.length) {
        const loop = ctx.loops[ctx.loops.length - 1];
        emitScratchpadReleases(ctx, loop.scratchDepth, false);
        ctx.lines.push(`    (br ${loop.cont})`);
      }
      else ctx.cg.warn(`continue outside loop`, stmt.span.line);
      break;

    case "return":
      if (ctx.inlineReturnLabel) {
        if (stmt.value && ctx.retAddr) {
          const src = emitAddr(ctx, stmt.value);
          if (src) {
            ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ctx.retAddr), addrIr(src), ir.i32c(ctx.retAggSize ?? 0)))}`);
          } else if (ctx.retType && (stmt.value.kind === "initializer_list" || stmt.value.kind === "construct")) {
            const args = stmt.value.kind === "initializer_list" ? stmt.value.exprs : stmt.value.args;
            if (!emitConstruct(ctx, ctx.retAddr, ctx.retType, args)) {
              throw new Error("aggregate return initializer could not be constructed");
            }
          } else {
            throw new Error("aggregate return expression from inline method is not addressable");
          }
        } else if (stmt.value && ctx.inlineValueLocal) {
          ctx.lines.push(`    ${setLocal(ctx, ctx.inlineValueLocal, narrowLocalIr(ctx, ctx.inlineValueLocal, emitValueIr(ctx, stmt.value)))}`);
        }
        ctx.lines.push(`    (br ${ctx.inlineReturnLabel})`);
        break;
      }
      // an inlined struct method's `return *this` carries no value out (the object flows via thisAddr); emitting a wasm
      if (ctx.inlineMethod) break;
      if (stmt.value && ctx.retAddr) {
        // aggregate-returning helper: copy the returned value into the caller-supplied dest, then return
        const src = emitAddr(ctx, stmt.value);
        if (src) {
          ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(ctx.retAddr!), addrIr(src), ir.i32c(ctx.retAggSize!)))}`);
        } else if (ctx.retType && (stmt.value.kind === "initializer_list" || stmt.value.kind === "construct")) {
          const args = stmt.value.kind === "initializer_list" ? stmt.value.exprs : stmt.value.args;
          if (!emitConstruct(ctx, ctx.retAddr, ctx.retType, args)) {
            throw new Error("aggregate return initializer could not be constructed");
          }
        } else {
          throw new Error("aggregate return expression is not addressable");
        }
        emitScratchpadReleases(ctx, 0, false);
        ctx.lines.push(`    (return)`);
      } else if (stmt.value && ctx.retIsAddr) {
        // Reference-returning compound operators commonly return their assignment
        // expression (`return *this += rhs`). Perform the write, then return the
        let addr: string | null;
        if (stmt.value.kind === "assign") {
          emitAssign(ctx, stmt.value);
          addr = emitAddr(ctx, stmt.value.left);
        } else {
          addr = emitAddr(ctx, stmt.value);
        }
        if (!addr) {
          ctx.cg.warn("reference return expression is not addressable", stmt.span.line);
          ctx.lines.push("    (return (i32.const 0))");
          break;
        }
        const result = newTmp(ctx);
        ctx.lines.push(`    (local.set $${result} ${addr})`);
        emitScratchpadReleases(ctx, 0, false);
        ctx.lines.push(`    (return (local.get $${result}))`);
      } else if (stmt.value && ctx.retIsValue) {
        // `return e` converts e to the declared return type (sub-64-bit returns truncate / sign-extend).
        const value = narrowCast(emitValue(ctx, stmt.value), ctx.retTypeName);
        if (ctx.scratchpadScope?.length) {
          const result = newTmp(ctx);
          ctx.localVars.set(result, { wasmType: "i64" });
          ctx.lines.push(`    (local.set $${result} ${value})`);
          emitScratchpadReleases(ctx, 0, false);
          ctx.lines.push(`    (return (local.get $${result}))`);
        } else {
          ctx.lines.push(`    (return ${value})`);
        }
      } else {
        emitScratchpadReleases(ctx, 0, false);
        ctx.lines.push(`    (return)`);
      }
      break;

    case "static_assert":
    case "empty":
    case "label":
      break;

    case "goto": {
      const target = ctx.gotoLabels?.get(stmt.label);
      if (target) {
        emitScratchpadReleases(ctx, target.scratchDepth, false);
        ctx.lines.push(`    (br ${target.label})`);
      }
      else ctx.cg.warn(`unsupported goto '${stmt.label}'`, stmt.span.line);
      break;
    }

    default:
      ctx.cg.warn(`unsupported statement '${stmt.kind}'`, stmt.span.line);
      break;
  }
}

// Emit an expression used as a statement (side effects only). Calls/assignments push their own
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
export function isScalarLocal(ctx: FnCtx, name: string): boolean {
  if (ctx.localVars.has(name)) return true;
  const p = ctx.params?.get(name);
  return !!p && !p.isAddr;
}

export function emitIncDec(ctx: FnCtx, expr: Expression): string {
  const arg = expr.kind === "postfix_op" || expr.kind === "prefix_op" ? expr.arg : expr;
  const op = (expr as any).op === "++" ? "i64.add" : "i64.sub";
  // A scalar local/value-param increments in place via local.set, narrowed back to its declared width so overflow wraps like
  if (arg.kind === "identifier" && isScalarLocal(ctx, arg.name)) {
    const next = ir.op(op, ir.getL(arg.name, "i64"), ir.i64c(1));
    return `(local.set $${arg.name} ${ir.emit(narrowLocalIr(ctx, arg.name, next))})`;
  }
  // Otherwise a member/element lvalue: load, adjust, store back.
  const addr = tryLvalueAddr(ctx, arg);
  if (addr) {
    // uint128 increment/decrement uses the source-compiled arithmetic operator.
    if (isUint128(ctx.cg, addr.type ?? null)) {
      if ((expr as any).op === "++") {
        const type = { kind: "template_instance", name: "uint128_t", args: [] } as TypeSpec & { kind: "template_instance" };
        const compiled = callCompiled(ctx, type, "operator++", addr.addr, []);
        if (!compiled || compiled.cm.retKind !== "i32") {
          throw new Error("authoritative uint128_t::operator++ could not be lowered");
        }
        return ir.emit(ir.op("drop", ir.callSig({ params: ["i32"], res: "i32" }, compiled.cm.label, addrIr(addr.addr))));
      }
      const one: Expression = { kind: "int_literal", value: "1", span: (expr as any).span };
      const res = emitU128Ir(ctx, {
        kind: "binary_op",
        op: op === "i64.add" ? "+" : "-",
        left: arg,
        right: one,
        span: (expr as any).span,
      });
      return ir.emit(ir.call("$copyMem", addrIr(addr.addr), res, ir.i32c(16)));
    }
    const load = loadAt(addr.addr, addr.size, isSignedScalarType(addr.type, ctx.cg));
    const stored = `(${op} ${load} (i64.const 1))`;
    return storeAt(addr.addr, addr.size, stored);
  }
  return "";
}
