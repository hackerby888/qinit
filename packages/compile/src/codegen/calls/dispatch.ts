import { SCALAR_SIZE } from "../tables";
import { QPI_GETTERS, QPI_CALLS, emitQpiCall } from "./qpi";
import { emitHelperCall, emitMathCallIr } from "./libfn";
import { emitProxySiblingCall, emitProposalProxyCall } from "./proxy";
import { newTmp } from "../stmt";
import { compileContainerMethod, emitAssetIter, emitContainerCall } from "./containers";
import { emitValueIr, emitValue } from "../value";
import { emitAddr, addrIr, allocSlotIr, setLocal, narrowCastIr, resolveAddr } from "../addr";
import { FnCtx, NO_BIND } from "../types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

export function emitThisCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.thisType || ctx.thisType.kind !== "template_instance" || expr.callee.kind !== "identifier") return null;
  const name = expr.callee.name;

  // Collection cleanup variants stay stubbed (the compaction path needs _tzcnt intrinsics); the
  // store remains a correct, just uncompacted, BST. _rebuild compiles from its real qpi.h body via
  // the sibling-method dispatch below — its balanced result is contract state and feeds the digest.
  if ((name === "cleanup" || name === "cleanupIfNeeded") && !valueWanted) return "";
  if (name === "needsCleanup" && valueWanted) return "(i64.const 0)";

  // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
  // Kept out of the contract surface (qpi.h hides them from contracts); valid only as statements here.
  if ((name === "setMem" || name === "copyMem") && !valueWanted) {
    const dst = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    if (name === "copyMem") {
      const src = emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)";
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[2]))))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[1])), ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[2]))))}`);
    }
    return "";
  }

  // HashFunc::hash(key) — for an id/m256i key the hash is its first 8 bytes; otherwise K12(key).
  if (name.endsWith("::hash")) {
    const keyAddr = emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)";
    const keyT = ctx.thisBind?.types.get("KeyT") ?? ctx.thisBind?.types.get("T");
    const keySize = keyT ? ctx.cg.sizeOfType(keyT, ctx.thisBind) : 32;
    if (keySize === 32) return `(i64.load ${keyAddr})`;
    const s = allocSlotIr(ctx, 8);
    ctx.lines.push(`    ${ir.emit(ir.call("$qpi_k12", addrIr(keyAddr), ir.i32c(keySize), s))}`);
    return `(i64.load ${ir.emit(s)})`;
  }

  // a sibling method of this container instance — compile it and call with $this + args. An
  // own-class-qualified static (DateAndTime::isLeapYear(y) inside another DateAndTime method)
  // is the same dispatch with the class prefix stripped; the static body never reads $this.
  const mname = name.startsWith(`${ctx.thisType.name}::`) ? name.slice(ctx.thisType.name.length + 2) : name;
  const cm = compileContainerMethod(ctx.cg, ctx.thisType, mname, expr.args.length);
  if (!cm) return null;
  // A reference-scalar argument that is a plain wasm local (addAndComputeCarry(newMicrosec, carry, ...))
  // has no address: spill it to a slot, pass the slot, and write the slot back after the call so
  // out-parameter writes reach the local.
  const writeBacks: string[] = [];
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i];
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (!fp.isAddr) return emitValue(ctx, arg);
    const a = emitAddr(ctx, arg);
    if (a) return a;
    // `&x` (pointer out-param) and parens unwrap to the same scalar-local spill as a bare `x`.
    let root = arg;
    while (root.kind === "paren" || (root.kind === "unary_op" && root.op === "&")) {
      root = root.kind === "paren" ? root.expr : root.arg;
    }
    const s = allocSlotIr(ctx, 8);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, s, emitValueIr(ctx, root)))}`);
    if (root.kind === "identifier" && ctx.localVars.get(root.name)?.wasmType === "i64") {
      writeBacks.push(`    ${setLocal(ctx, root.name, ir.loadRaw("i64.load", null, s))}`);
    }
    return ir.emit(s);
  });
  const call = `(call ${cm.label} (local.get $this) ${ops.join(" ")})`;
  if (valueWanted) {
    if (cm.retKind !== "i64") {
      ctx.lines.push(`    ${call}`);
      ctx.lines.push(...writeBacks);
      return "(i64.const 0)";
    }
    if (!writeBacks.length) return call;
    const r = `tmp${ctx.tmpCount++}`;
    ctx.localVars.set(r, { wasmType: "i64" });
    ctx.lines.push(`    ${setLocal(ctx, r, ir.raw(call, "i64", "unconverted: container method call"))}`);
    ctx.lines.push(...writeBacks);
    return `(local.get $${r})`;
  }
  ctx.lines.push(cm.retKind === "i64" ? `    ${ir.emit(ir.op("drop", ir.raw(call, "i64", "unconverted: container method call")))}` : `    ${call}`);
  ctx.lines.push(...writeBacks);
  return "";
}

// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method,
// or a math helper.
export function emitCallValueIr(ctx: FnCtx, expr: Expression & { kind: "call" }): ir.Ir {
  // isZero(id) / id.isZero() — true iff all 32 bytes are zero (OR the four 64-bit limbs, test for zero).
  {
    const idObj = expr.callee.kind === "identifier" && expr.callee.name === "isZero" ? expr.args[0]
      : (expr.callee.kind === "member_access" && expr.callee.member === "isZero") ? expr.callee.object
      : null;
    if (idObj) {
      const addr = emitAddr(ctx, idObj);
      if (addr) {
        const t = newTmp(ctx);
        ctx.lines.push(`    ${setLocal(ctx, t, addrIr(addr))}`);
        const a = ir.getL(t, "i32");
        const limb = (off: number) => ir.loadRaw("i64.load", null, ir.addr0(a, off));
        const ors = ir.op("i64.or", ir.op("i64.or", limb(0), limb(8)), ir.op("i64.or", limb(16), limb(24)));
        return ir.op("i64.extend_i32_u", ir.op("i64.eqz", ors));
      }
    }
  }

  // ProposalVoting proxy `qpi(state.proposals).method(...)` — compile the real qpi.h proxy method against
  // the wrapped ProposalVoting instance. A sibling proxy call inside a proxy body (clearProposal) resolves
  // here too. Falls back to the terminating stub if the instance/method can't be compiled.
  if (ctx.proxyClass) {
    const sib = emitProxySiblingCall(ctx, expr, true);
    if (sib !== null) return ir.raw(sib, "i64", "unconverted: proxy sibling call");
  }
  {
    const m = qpiWrapperMethod(expr);
    if (m) {
      const real = emitProposalProxyCall(ctx, expr, true);
      if (real !== null) return ir.raw(real, "i64", "unconverted: proposal proxy call");
      if (m === "nextProposalIndex" || m === "nextFinishedProposalIndex") return ir.i64c(-1);
      if (m === "setProposal") return ir.i64c(ctx.cg.resolveConst("INVALID_PROPOSAL_INDEX") ?? 65535n);
      return ir.i64c(0);
    }
  }

  // Inter-contract call in value context — the _E forms capture the InterContractCallError into a variable
  // (`InterContractCallError err = __qpi_..._other(...)`). Same lowering as the statement form, but the i32
  // error result flows out instead of being dropped.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) return ir.op("i64.extend_i32_s", ir.raw(wat, "i32", "unconverted: inter-contract call"));
    ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return ir.i64c(0);
  }

  const ai = emitAssetIter(ctx, expr, "value");
  if (ai !== null) return ir.raw(ai, "i64", "unconverted: asset iterator");

  const tc = emitThisCall(ctx, expr, true);
  if (tc !== null) return ir.raw(tc, "i64", "unconverted: this-call");

  const h = emitHelperCall(ctx, expr, true);
  if (h !== null) return ir.raw(h, "i64", "unconverted: helper call");

  if (expr.callee.kind === "identifier" || expr.callee.kind === "qualified_name") {
    const nm = expr.callee.kind === "identifier" ? expr.callee.name : `${expr.callee.namespace}::${expr.callee.name}`;
    const m = emitMathCallIr(ctx, nm, expr.args);
    if (m !== null) return m;
  }
  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const g = QPI_GETTERS[expr.callee.member];
    if (g) return g.ret === "i64" ? ir.call(g.fwd) : ir.op("i64.extend_i32_u", ir.call(g.fwd));
    // qpi out-producer used as a scalar value (`qpi.now() < endDate`): materialize the out struct and read
    // its leading 8 bytes — the scalar-context out producers are 8-byte packed values (DateAndTime.value).
    const desc = QPI_CALLS[expr.callee.member];
    if (desc && desc.ret === "out") {
      const a = emitAddr(ctx, expr);
      if (a) return ir.loadRaw("i64.load", null, ir.raw(a, "i32", "lvalue address channel"));
    }
  }

  const q = emitQpiCall(ctx, expr);
  if (q) {
    if (q.ret === "i64") return ir.raw(q.wat, "i64", "unconverted: qpi call");
    if (q.ret === "i32") return ir.op("i64.extend_i32_u", ir.raw(q.wat, "i32", "unconverted: qpi call"));
  }

  const c = emitContainerCall(ctx, expr, true);
  if (c !== null) return ir.raw(c, "i64", "unconverted: container call");

  // Functional-style scalar cast: uint64(x) / sint64(x) / uint8(x) / bit(x) ... — narrowed to the target
  // width (matching the c_cast/static_cast lowering); a store to a typed field additionally truncates.
  if (expr.callee.kind === "identifier" && SCALAR_SIZE[expr.callee.name] !== undefined && expr.args.length === 1) {
    return narrowCastIr(emitValueIr(ctx, expr.args[0]), expr.callee.name);
  }

  // The same cast through a template parameter: T(x) inside a qpi.h template body where T binds to a
  // scalar type. Aggregate bindings fall through to the construct/materialize paths.
  if (expr.callee.kind === "identifier" && expr.args.length === 1) {
    const bound = ctx.thisBind?.types.get(expr.callee.name);
    if (bound?.kind === "name" && SCALAR_SIZE[bound.name] !== undefined) {
      return narrowCastIr(emitValueIr(ctx, expr.args[0]), bound.name);
    }
  }

  // uint128(i_high, i_low) two-arg constructor as a scalar value: the i64-collapsed model carries the low
  // 64 bits, so the value is the LOW arg (arg[1]). The high arg is dropped — fine for the values this is used
  // on (shift counts and small magnitudes that fit 64 bits, e.g. QSWAP's `uint128(0, 126)` = 126). Without
  // this it fell through to the unsupported-call fallback and became 0 — so `z >>= uint128(0, 2)` shifted by
  // 0 and the integer-sqrt loop never terminated.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "uint128" || expr.callee.name === "uint128_t") && expr.args.length === 2) {
    return emitValueIr(ctx, expr.args[1]);
  }

  ctx.cg.warn(`unsupported call as value [${describeShape(expr)}]`, expr.span.line);
  return ir.i64c(0);
}

export function emitCallValue(ctx: FnCtx, expr: Expression & { kind: "call" }): string {
  return ir.emit(emitCallValueIr(ctx, expr));
}

// statement call: a container mutation or a side-effecting qpi host call.
// Lower an inter-contract call to the host forwarder ($liteCallFunction / $liteInvokeProcedure). The
// callee contract index comes from the provided callee IDL (or a <NAME>_CONTRACT_INDEX constant); the
// entry's input-type number selects the function/procedure at that contract. IO sizes come from the
// in/out lvalues (falling back to the IDL). Returns null when the callee can't be resolved.
export function emitInterContract(ctx: FnCtx, expr: Expression & { kind: "call" }, isInvoke: boolean): string | null {
  const cArg = expr.args[0], fArg = expr.args[1];
  if (cArg?.kind !== "identifier" || fArg?.kind !== "identifier") return null;
  const callee = ctx.cg.callees.get(cArg.name);
  let idx: number | null = callee?.index ?? null;
  if (idx === null) {
    const c = ctx.cg.resolveConst(`${cArg.name}_CONTRACT_INDEX`);
    if (c !== null) idx = Number(c);
  }
  const entry = isInvoke ? callee?.procedures[fArg.name] : callee?.functions[fArg.name];
  if (idx === null || !entry) return null;

  const inAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
  const outAddr = expr.args[3] ? (emitAddr(ctx, expr.args[3]) ?? "(i32.const 0)") : "(i32.const 0)";
  const inSize = (expr.args[2] ? resolveAddr(ctx, expr.args[2])?.size : undefined) ?? entry.inSize;
  const outSize = (expr.args[3] ? resolveAddr(ctx, expr.args[3])?.size : undefined) ?? entry.outSize;
  const dims = `(i32.const ${idx}) (i32.const ${entry.inputType}) ${inAddr} (i32.const ${inSize}) ${outAddr} (i32.const ${outSize})`;
  // Returns the bare i32 call expression (the InterContractCallError). The statement caller drops it; the
  // _E forms capture it into their errorVar (value context).
  if (isInvoke) {
    const reward = expr.args[4] ? emitValue(ctx, expr.args[4]) : "(i64.const 0)";
    return `(call $liteInvokeProcedure ${dims} ${reward})`;
  }
  return `(call $liteCallFunction ${dims})`;
}

// The ProposalVoting wrapper call shape: `qpi(<aggregate>).<method>(...)` — a member call whose object is a
// `qpi(...)` call. Returns the method name, or null if this isn't that shape.
export function qpiWrapperMethod(expr: Expression & { kind: "call" }): string | null {
  const c = expr.callee;
  if (c.kind !== "member_access") return null;
  const o = c.object;
  if (o.kind === "call" && o.callee.kind === "identifier" && o.callee.name === "qpi") return c.member;
  return null;
}

export function describeShape(e: Expression): string {
  if (!e) return "?";
  if (e.kind === "identifier") return e.name;
  if (e.kind === "member_access") return `${describeShape(e.object)}.${e.member}`;
  if (e.kind === "call") return `${describeShape(e.callee)}(${e.args.length})`;
  if (e.kind === "subscript") return `${describeShape(e.object)}[]`;
  return e.kind;
}

// QUERY_ORACLE / SUBSCRIBE_ORACLE (qpi.h:3290/3327): qpi.__qpiQueryOracle<OI::Price>(query, proc, __id_proc,
// timeout) lowers like native lite_wasm_tu.h — the host import takes (ifaceIdx, &query, sizeof(OracleQuery),
// procId, timeout/period[, notifyPrev], fee), the fee computed in-wasm by the interface's static fee function.
// The function-pointer arg only type-checks the callback natively and is dropped; procId is the synthetic
// __id_<proc> = (CONTRACT_INDEX << 22) | defLine, whose low 16 bits also key the dispatch entry.
export function emitOracleQueryCall(ctx: FnCtx, expr: Expression & { kind: "template_call" }): string | null {
  const subscribe = expr.callee.kind === "member_access" && expr.callee.member === "__qpiSubscribeOracle";
  const t = expr.templateArgs[0];
  if (!t || t.kind !== "name") return null;

  const sd = ctx.cg.structOf(t, ctx.thisBind ?? NO_BIND);
  const iface = ctx.cg.resolveConst(`${t.name}::oracleInterfaceIndex`);
  const q = sd?.members.find((m): m is StructDecl => m.kind === "struct" && m.name === "OracleQuery");
  const qSize = q ? ctx.cg.layoutOfType({ kind: "inline_struct", struct: q })?.size : undefined;
  const qAddr = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
  const idArg = expr.args[2];
  const procName = idArg?.kind === "identifier" && idArg.name.startsWith("__id_") ? idArg.name.slice(5) : null;
  const defLine = procName ? ctx.cg.memberFnLine.get(procName) : undefined;
  if (iface === null || !q || !qSize || !qAddr || defLine === undefined) return null;
  const procId = (ctx.cg.slot << 22) | (defLine & 0x3fffff);

  const feeCall = {
    kind: "call",
    callee: { kind: "identifier", name: `${t.name}::${subscribe ? "getSubscriptionFee" : "getQueryFee"}`, span: expr.span },
    args: subscribe ? [expr.args[0], expr.args[3]] : [expr.args[0]],
    span: expr.span,
  } as Expression & { kind: "call" };
  const fee = emitCallValue(ctx, feeCall);

  if (subscribe) {
    const period = `(i32.wrap_i64 ${emitValue(ctx, expr.args[3])})`;
    const prev = `(i32.and (i32.wrap_i64 ${emitValue(ctx, expr.args[4])}) (i32.const 1))`;
    return `(i64.extend_i32_s (call $lh_subscribeOracle (i32.const ${iface}) ${qAddr} (i32.const ${qSize}) (i32.const ${procId}) ${period} ${prev} ${fee}))`;
  }
  const timeout = `(i32.wrap_i64 ${emitValue(ctx, expr.args[3])})`;
  return `(call $lh_queryOracle (i32.const ${iface}) ${qAddr} (i32.const ${qSize}) (i32.const ${procId}) ${timeout} ${fee})`;
}

// qpi.getOracleQuery<OI>(queryId, query) / qpi.getOracleReply<OI>(queryId, reply): the host copies
// sizeof(OI::OracleQuery / OI::OracleReply) bytes into the out lvalue and reports whether the queryId
// matched — lite_wasm_tu.h's lh_getOracleQuery(queryId, &out, sizeof(...)) != 0. The size comes from
// the template argument's nested struct, like the native sizeof, not from the passed lvalue.
export function emitOracleReadCall(ctx: FnCtx, expr: Expression & { kind: "template_call" }): ir.Ir | null {
  const reply = expr.callee.kind === "member_access" && expr.callee.member === "getOracleReply";
  const t = expr.templateArgs[0];
  if (!t || t.kind !== "name") return null;

  const sd = ctx.cg.structOf(t, ctx.thisBind ?? NO_BIND);
  const m = sd?.members.find((x): x is StructDecl => x.kind === "struct" && x.name === (reply ? "OracleReply" : "OracleQuery"));
  const size = m ? ctx.cg.layoutOfType({ kind: "inline_struct", struct: m })?.size : undefined;
  const outAddr = expr.args[1] ? emitAddr(ctx, expr.args[1]) : null;
  if (!size || !outAddr) return null;

  const qid = emitValueIr(ctx, expr.args[0]);
  return ir.op("i64.extend_i32_u",
    ir.call(reply ? "$lh_getOracleReply" : "$lh_getOracleQuery", qid, addrIr(outAddr), ir.i32c(size)));
}

export function emitCall(ctx: FnCtx, expr: Expression & { kind: "call" }): void {
  // LOG_* macros expand to __logContract{Info,Debug,...}Message — a side channel that does not affect
  // state or the digest, so dropping it is behaviorally faithful.
  if (expr.callee.kind === "identifier" && expr.callee.name.startsWith("__logContract")) return;

  // ASSERT is ((void)0) in release builds (platform/assert.h) — the argument is not even evaluated,
  // so dropping the statement is behaviorally faithful.
  if (expr.callee.kind === "identifier" && expr.callee.name === "ASSERT") return;

  // LOG_PAUSE/LOG_RESUME expand to __pauseLogMessage()/__resumeLogMessage() — same log side channel
  // as __logContract*, no effect on state or the digest.
  if (expr.callee.kind === "identifier" &&
      (expr.callee.name === "__pauseLogMessage" || expr.callee.name === "__resumeLogMessage")) return;

  // ProposalVoting proxy `qpi(state.proposals).method(...)` as a statement (e.g. getProposal/vote write
  // through an out-param). Compile the real proxy method; fall back to a drop if it can't be compiled.
  if (ctx.proxyClass && emitProxySiblingCall(ctx, expr, false) !== null) return;
  if (qpiWrapperMethod(expr)) {
    emitProposalProxyCall(ctx, expr, false);
    return;
  }

  // AssetOwnership/PossessionIterator.begin()/next() — statement forms.
  if (emitAssetIter(ctx, expr, "stmt") !== null) return;

  // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract,
  // passing the caller's in/out lvalues and a freshly bumped locals frame.
  if (expr.callee.kind === "identifier" && expr.callee.name === "__qpi_call_self") {
    const fnArg = expr.args[0];
    const info = fnArg?.kind === "identifier" ? (ctx.cg.privates.get(fnArg.name) ?? ctx.cg.registered.get(fnArg.name)) : undefined;
    if (info) {
      const inAddr = expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      const outAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
      const locals = `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      ctx.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${locals})`);
      return;
    }
  }

  // Direct PRIVATE_ function call: `priv(qpi, state, in, out, locals)` — QUtil calls its helpers this way
  // (get_voter_balance/get_qubic_balance) instead of via the CALL macro. The callee is a registered private;
  // pass the caller's explicit in/out/locals lvalues (the locals sub-struct the caller reserved), not a fresh
  // frame. Without this the call was dropped ("unsupported call statement"), so out params stayed zero.
  if (expr.callee.kind === "identifier" && expr.args[0]?.kind === "identifier" && expr.args[0].name === "qpi") {
    // Registered PUBLIC entries are callable the same way (MsVault's isShareHolder(qpi, state, ...)).
    const info = ctx.cg.privates.get(expr.callee.name) ?? ctx.cg.registered.get(expr.callee.name);
    if (info) {
      const inAddr = expr.args[2] ? (emitAddr(ctx, expr.args[2]) ?? "(i32.const 0)") : "(i32.const 0)";
      const outAddr = expr.args[3] ? (emitAddr(ctx, expr.args[3]) ?? "(i32.const 0)") : "(i32.const 0)";
      const localsAddr = expr.args[4] ? (emitAddr(ctx, expr.args[4]) ?? `(call $qpiAllocLocals (i32.const ${info.localsSize}))`) : `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      ctx.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${localsAddr})`);
      return;
    }
  }

  // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a
  // host-mediated call into the contract at C's index. Needs C's callee IDL (index + entry input type).
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(wat, "i32", "unconverted: inter-contract call")))}`);
    else ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return;
  }

  // QPI memory wrappers: setMemory(dst,val) / copyMemory(dst,src) / copyFromBuffer(dst,src) /
  // copyToBuffer(dst,src,tailZero). Lowered at the call site so the byte count is sizeof(dst|src) under the
  // CALLER's bindings (where a dependent member array like VoteStorageType[numOfVotes] is concrete), rather
  // than via a generic lib-fn instantiation that loses those bindings and sizes to 0.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "setMemory" || expr.callee.name === "copyMemory" || expr.callee.name === "copyFromBuffer" || expr.callee.name === "copyToBuffer")) {
    const name = expr.callee.name;
    const dstNode = expr.args[0] ? resolveAddr(ctx, expr.args[0]) : null;
    const dst = dstNode?.addr ?? (expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)");
    if (name === "setMemory") {
      const val = expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0);
      // $setMem is (dst, size, val).
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), ir.i32c(dstNode?.size ?? 0), ir.op("i32.wrap_i64", val)))}`);
      return;
    }
    const srcNode = expr.args[1] ? resolveAddr(ctx, expr.args[1]) : null;
    const src = srcNode?.addr ?? (expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)");
    // copyToBuffer copies sizeof(src) (the smaller object into a larger buffer); the others copy sizeof(dst).
    const size = name === "copyToBuffer" ? (srcNode?.size ?? 0) : (dstNode?.size ?? 0);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), ir.i32c(size)))}`);
    return;
  }

  // Low-level memory intrinsics copyMem(dst,src,n) / setMem(dst,val,n). Handled here (not only in
  // emitThisCall, which requires a `this` context) so they also lower inside lib-fn instances such as
  // copyMemory<T1,T2>'s body `copyMem(&dst, &src, sizeof(dst))` — otherwise that body emits nothing.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "copyMem" || expr.callee.name === "setMem")) {
    const dst = expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const wrapArg = (e: Expression | undefined) => ir.op("i32.wrap_i64", e ? emitValueIr(ctx, e) : ir.i64c(0));
    if (expr.callee.name === "copyMem") {
      const src = expr.args[1] ? (emitAddr(ctx, expr.args[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(dst), addrIr(src), wrapArg(expr.args[2])))}`);
    } else {
      ctx.lines.push(`    ${ir.emit(ir.call("$setMem", addrIr(dst), wrapArg(expr.args[1]), wrapArg(expr.args[2])))}`);
    }
    return;
  }

  const tc = emitThisCall(ctx, expr, false);
  if (tc !== null) return;

  const h = emitHelperCall(ctx, expr, false);
  if (h !== null) return;

  const c = emitContainerCall(ctx, expr, false);
  if (c !== null) return;

  const q = emitQpiCall(ctx, expr);
  if (q) {
    if (q.ret === "void" || q.ret === "out") ctx.lines.push(`    ${q.wat}`);
    else ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(q.wat, q.ret === "i32" ? "i32" : "i64", "unconverted: qpi call")))}`);
    return;
  }

  ctx.cg.warn(`unsupported call statement [${describeShape(expr)}]`, expr.span.line);
}
