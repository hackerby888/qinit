import { MATH_INTRINSIC_NAMES, SCALAR_SIZE } from "../tables";
import { QPI_GETTERS, QPI_CALLS, emitQpiCall } from "./qpi";
import { emitHelperCall } from "./libfn";
import { emitProxySiblingCall, emitProposalProxyCall } from "./proxy";
import { newTmp } from "../stmt";
import { compileContainerMethod, emitAssetIter, emitContainerCall } from "./containers";
import { emitValueIr, emitValue } from "../value";
import { emitAddr, emitInlineStructStatement, addrIr, allocSlotIr, setLocal, narrowCastIr, resolveAddr } from "../addr";
import { FnCtx, NO_BIND } from "../types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

export function emitThisCall(ctx: FnCtx, expr: Expression & { kind: "call" }, valueWanted: boolean): string | null {
  if (!ctx.thisType || ctx.thisType.kind !== "template_instance" || expr.callee.kind !== "identifier") return null;
  const name = expr.callee.name;

  // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
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

  // Resolve the dependent static call through the actual HashFunc template binding. This is important
  // both for the default HashFunction<KeyT> body and for contract-provided custom hashers.
  if (name.endsWith("::hash")) {
    const bound = ctx.thisBind?.types.get(name.slice(0, name.lastIndexOf("::")));
    const target: (TypeSpec & { kind: "template_instance" }) | null = bound?.kind === "template_instance"
      ? bound
      : bound?.kind === "name"
        ? { kind: "template_instance", name: bound.name, args: [] }
        : null;
    if (!target) throw new Error(`dependent hash target '${name}' is not bound`);
    const cm = compileContainerMethod(ctx.cg, target, "hash", expr.args.length);
    if (!cm || cm.retKind !== "i64") {
      throw new Error(`authoritative QPI method ${target.name}::hash could not be lowered`);
    }
    const ops = cm.fnParams.map((fp, index) => {
      const arg = expr.args[index] ?? fp.defaultValue;
      if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
      if (!fp.isAddr) return emitValue(ctx, arg);
      const direct = emitAddr(ctx, arg);
      if (direct) return direct;
      const spill = allocSlotIr(ctx, Math.max(8, ctx.cg.sizeOfType(ctx.cg.derefType(fp.type), ctx.thisBind ?? NO_BIND)));
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, spill, emitValueIr(ctx, arg)))}`);
      return ir.emit(spill);
    });
    return `(call ${cm.label} (local.get $this)${ops.length ? " " + ops.join(" ") : ""})`;
  }

  // a sibling method of this container instance — compile it and call with $this + args. An
  const mname = name.startsWith(`${ctx.thisType.name}::`) ? name.slice(ctx.thisType.name.length + 2) : name;
  const cm = compileContainerMethod(ctx.cg, ctx.thisType, mname, expr.args.length);
  if (!cm) return null;
  // A reference-scalar argument that is a plain wasm local (addAndComputeCarry(newMicrosec, carry, ...)) has no address: spill it to
  const writeBacks: string[] = [];
  const ops = cm.fnParams.map((fp, i) => {
    const arg = expr.args[i] ?? fp.defaultValue;
    if (!arg) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (arg.kind === "nullptr_literal") return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (!fp.isAddr) return emitValue(ctx, arg);
    const a = emitAddr(ctx, arg);
    if (a) return a;
    // `&x` (pointer out-param) and parens unwrap to the same scalar-local spill as a bare `x`.
    let root: Expression = arg;
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

// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method, or a math
export function emitCallValueIr(ctx: FnCtx, expr: Expression & { kind: "call" }): ir.Ir {
  if (ctx.cg.gtestMode && expr.callee.kind === "identifier" && expr.callee.name === "getBalance") {
    const who = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
    if (!who) throw new Error("gtest getBalance account must be addressable");
    return ir.call("$qt_balance", addrIr(who));
  }
  // MSVC widening-multiply intrinsics used by authoritative math_lib bodies. Wasm supplies the
  // low limb directly; the frontend primitive computes and writes the high limb.
  if (expr.callee.kind === "identifier" && (expr.callee.name === "_mul128" || expr.callee.name === "_umul128")) {
    const left = expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0);
    const right = expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0);
    const high = ir.call(expr.callee.name === "_mul128" ? "$intr_mulhi_s" : "$intr_mulhi_u", left, right);
    let output: Expression | undefined = expr.args[2];
    while (output?.kind === "paren" || (output?.kind === "unary_op" && output.op === "&")) {
      output = output.kind === "paren" ? output.expr : output.arg;
    }
    if (output?.kind === "identifier" && ctx.localVars.get(output.name)?.wasmType === "i64") {
      ctx.lines.push(`    ${setLocal(ctx, output.name, high)}`);
    } else {
      const out = expr.args[2] ? emitAddr(ctx, expr.args[2]) : null;
      if (!out) throw new Error(`${expr.callee.name} high-limb output is not addressable`);
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, addrIr(out), high))}`);
    }
    return ir.op("i64.mul", left, right);
  }

  // x86 count intrinsics used by the authoritative container cleanup bodies. Wasm defines clz/ctz(0)
  // as the operand width (64), which is the same contract as the core-lite intrinsics.
  if (expr.callee.kind === "identifier" && expr.args.length === 1) {
    const intrinsic = expr.callee.name.includes("::")
      ? expr.callee.name.slice(expr.callee.name.lastIndexOf("::") + 2)
      : expr.callee.name;
    if (intrinsic === "_tzcnt_u64" || intrinsic === "_tzcnt64") {
      return ir.op("i64.ctz", emitValueIr(ctx, expr.args[0]));
    }
    if (intrinsic === "_lzcnt_u64" || intrinsic === "__lzcnt64") {
      return ir.op("i64.clz", emitValueIr(ctx, expr.args[0]));
    }
  }

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

  // ProposalVoting proxy `qpi(state.proposals).method(...)` — compile the real qpi.h proxy method against the wrapped ProposalVoting instance. A sibling proxy
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

  // Inter-contract call in value context — the _E forms capture the InterContractCallError into a variable (`InterContractCallError err =
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
    const name = expr.callee.kind === "identifier" ? expr.callee.name : expr.callee.name;
    const base = name.includes("::") ? name.slice(name.lastIndexOf("::") + 2) : name;
    if (MATH_INTRINSIC_NAMES.has(base)) {
      throw new Error(`authoritative QPI math function '${name}' could not be lowered`);
    }
  }

  if (expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi") {
    const g = QPI_GETTERS[expr.callee.member];
    if (g) return g.ret === "i64" ? ir.call(g.fwd) : ir.op("i64.extend_i32_u", ir.call(g.fwd));
    // qpi out-producer used as a scalar value (`qpi.now() < endDate`): materialize the out struct and read its leading
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
  if (expr.callee.kind === "identifier" && SCALAR_SIZE[expr.callee.name] !== undefined && expr.args.length === 1) {
    return narrowCastIr(emitValueIr(ctx, expr.args[0]), expr.callee.name);
  }

  // The same cast through a template parameter: T(x) inside a qpi.h template body where T binds to a
  if (expr.callee.kind === "identifier" && expr.args.length === 1) {
    const bound = ctx.thisBind?.types.get(expr.callee.name);
    if (bound?.kind === "name" && SCALAR_SIZE[bound.name] !== undefined) {
      return narrowCastIr(emitValueIr(ctx, expr.args[0]), bound.name);
    }
  }

  // uint128(i_high, i_low) two-arg constructor as a scalar value: the i64-collapsed model carries the low 64 bits, so the
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
  if (isInvoke) {
    const reward = expr.args[4] ? emitValue(ctx, expr.args[4]) : "(i64.const 0)";
    return `(call $liteInvokeProcedure ${dims} ${reward})`;
  }
  return `(call $liteCallFunction ${dims})`;
}

// The ProposalVoting wrapper call shape: `qpi(<aggregate>).<method>(...)` — a member call whose object is a `qpi(...)` call. Returns the
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

// QUERY_ORACLE / SUBSCRIBE_ORACLE (qpi.h:3290/3327): qpi.__qpiQueryOracle<OI::Price>(query, proc, __id_proc, timeout) lowers like native lite_wasm_tu.h — the host import takes (ifaceIdx,
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

// qpi.getOracleQuery<OI>(queryId, query) / qpi.getOracleReply<OI>(queryId, reply): the host copies sizeof(OI::OracleQuery / OI::OracleReply) bytes into the out lvalue and reports
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
  if (ctx.cg.gtestMode && expr.callee.kind === "identifier") {
    const name = expr.callee.name;
    if (name === "__qtest_noop" || name === "initEmptySpectrum" || name === "initEmptyUniverse") return;

    if (name === "invokeUserProcedure") {
      const input = expr.args[2] ? resolveAddr(ctx, expr.args[2]) : null;
      const output = expr.args[3] ? resolveAddr(ctx, expr.args[3]) : null;
      const origin = expr.args[4] ? emitAddr(ctx, expr.args[4]) : null;
      if (!input || !output || !origin) throw new Error("gtest invokeUserProcedure requires addressable input, output, and origin");
      const slot = ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[0]));
      const inputType = ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[1]));
      const amount = expr.args[5] ? emitValueIr(ctx, expr.args[5]) : ir.i64c(0);
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.call("$qt_invoke", slot, inputType, addrIr(input.addr), ir.i32c(input.size), addrIr(output.addr), amount, addrIr(origin))))}`);
      return;
    }
    if (name === "callFunction") {
      const input = expr.args[2] ? resolveAddr(ctx, expr.args[2]) : null;
      const output = expr.args[3] ? resolveAddr(ctx, expr.args[3]) : null;
      if (!input || !output) throw new Error("gtest callFunction requires addressable input and output");
      const slot = ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[0]));
      const inputType = ir.op("i32.wrap_i64", emitValueIr(ctx, expr.args[1]));
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.call("$qt_query", slot, inputType, addrIr(input.addr), ir.i32c(input.size), addrIr(output.addr), ir.i32c(output.size))))}`);
      return;
    }
    if (name === "increaseEnergy") {
      const who = expr.args[0] ? emitAddr(ctx, expr.args[0]) : null;
      if (!who) throw new Error("gtest increaseEnergy account must be addressable");
      ctx.lines.push(`    ${ir.emit(ir.call("$qt_fund", addrIr(who), expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0)))}`);
      return;
    }
    if (name === "callSystemProcedure") {
      const slot = ir.op("i32.wrap_i64", expr.args[0] ? emitValueIr(ctx, expr.args[0]) : ir.i64c(0));
      const procedure = ir.op("i32.wrap_i64", expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0));
      ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.call("$qt_system", slot, procedure)))}`);
      return;
    }

    const assertion = name.match(/^__qtest_(expect|assert)_(eq|ne|lt|le|gt|ge|true|false)$/);
    if (assertion) {
      const fatal = assertion[1] === "assert";
      const operation = assertion[2];
      const left = expr.args[0] ?? ({ kind: "int_literal", value: "0", span: expr.span } as Expression);
      const right = operation === "true" || operation === "false"
        ? ({ kind: "int_literal", value: operation === "true" ? "0" : "0", span: expr.span } as Expression)
        : (expr.args[1] ?? ({ kind: "int_literal", value: "0", span: expr.span } as Expression));
      const op = operation === "true" ? "!=" : operation === "false" ? "==" : ({ eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" } as const)[operation as "eq" | "ne" | "lt" | "le" | "gt" | "ge"];
      const comparison = emitValueIr(ctx, { kind: "binary_op", op, left, right, span: expr.span });
      const code = ["eq", "ne", "lt", "le", "gt", "ge", "true", "false"].indexOf(operation);
      ctx.lines.push(`    (if (i64.eqz ${ir.emit(comparison)}) (then`);
      ctx.lines.push(`      ${ir.emit(ir.call("$qt_fail", ir.i32c(code), ir.i32c(fatal ? 1 : 0)))}`);
      if (fatal) ctx.lines.push("      (return)");
      ctx.lines.push("    ))");
      return;
    }
  }

  // The generic HashFunction<KeyT> source body calls core-lite's KangarooTwelve primitive with an
  // explicit output length. The lite host exposes K12 as a 32-byte producer, so hash into a private
  // 32-byte slot and then copy/assign the requested prefix.
  if (expr.callee.kind === "identifier" && expr.callee.name === "KangarooTwelve") {
    const input = expr.args[0] ? (emitAddr(ctx, expr.args[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const inputSize = expr.args[1] ? emitValueIr(ctx, expr.args[1]) : ir.i64c(0);
    const digest = allocSlotIr(ctx, 32);
    ctx.lines.push(`    ${ir.emit(ir.call("$qpi_k12", addrIr(input), ir.op("i32.wrap_i64", inputSize), digest))}`);

    let output: Expression | undefined = expr.args[2];
    while (output?.kind === "paren" || (output?.kind === "unary_op" && output.op === "&")) {
      output = output.kind === "paren" ? output.expr : output.arg;
    }
    if (output?.kind === "identifier" && ctx.localVars.get(output.name)?.wasmType === "i64") {
      ctx.lines.push(`    ${setLocal(ctx, output.name, ir.loadRaw("i64.load", null, digest))}`);
    } else {
      const outAddr = expr.args[2] ? emitAddr(ctx, expr.args[2]) : null;
      if (!outAddr) throw new Error("KangarooTwelve output is not addressable");
      const outputSize = expr.args[3] ? emitValueIr(ctx, expr.args[3]) : ir.i64c(32);
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", addrIr(outAddr), digest, ir.op("i32.wrap_i64", outputSize)))}`);
    }
    return;
  }

  if (expr.callee.kind === "identifier" && expr.callee.name.startsWith("__qinit_log_")) {
    const levels: Record<string, number> = {
      __qinit_log_error: 4,
      __qinit_log_warning: 5,
      __qinit_log_info: 6,
      __qinit_log_debug: 7,
    };
    const level = levels[expr.callee.name];
    if (level !== undefined) {
      const payload = expr.args[0] ? resolveAddr(ctx, expr.args[0]) : null;
      if (!payload) throw new Error(`${expr.callee.name} payload must be an addressable aggregate`);
      if (!payload.layout) throw new Error(`${expr.callee.name} payload must be a struct`);
      const terminator = payload.layout.fields.get("_terminator");
      if (!terminator) throw new Error(`${expr.callee.name} payload struct must contain _terminator`);
      if (terminator.offset < 8) throw new Error(`${expr.callee.name} payload _terminator offset must be at least 8 bytes`);
      const address = addrIr(payload.addr);
      ctx.lines.push(`    ${ir.emit(ir.call("$qpi_logBytes", ir.i32c(ctx.cg.slot), ir.i32c(level), address, ir.i32c(terminator.offset)))}`);
      // Native qpi.h restores the host-stamped contract index so logging cannot alter contract state.
      ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store", null, address, ir.i32c(0)))}`);
      return;
    }
    if (expr.callee.name === "__qinit_log_pause") {
      ctx.lines.push("    (call $lh_pauseLog)");
      return;
    }
    if (expr.callee.name === "__qinit_log_resume") {
      ctx.lines.push("    (call $lh_resumeLog)");
      return;
    }
    throw new Error(`unknown logging intrinsic '${expr.callee.name}'`);
  }

  // ASSERT is ((void)0) in release builds (platform/assert.h) — the argument is not even evaluated, so dropping the statement
  if (expr.callee.kind === "identifier" && expr.callee.name === "ASSERT") return;

  if (expr.callee.kind === "member_access" && emitInlineStructStatement(ctx, expr)) return;

  // ProposalVoting proxy `qpi(state.proposals).method(...)` as a statement (e.g. getProposal/vote write
  if (ctx.proxyClass && emitProxySiblingCall(ctx, expr, false) !== null) return;
  if (qpiWrapperMethod(expr)) {
    emitProposalProxyCall(ctx, expr, false);
    return;
  }

  // AssetOwnership/PossessionIterator.begin()/next() — statement forms.
  if (emitAssetIter(ctx, expr, "stmt") !== null) return;

  // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract, passing the caller's in/out
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

  // Direct PRIVATE_ function call: `priv(qpi, state, in, out, locals)` — QUtil calls its helpers this way (get_voter_balance/get_qubic_balance) instead
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

  // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a host-mediated call into the contract at C's index. Needs C's callee IDL (index
  if (expr.callee.kind === "identifier" && (expr.callee.name === "__qpi_call_other" || expr.callee.name === "__qpi_invoke_other")) {
    const wat = emitInterContract(ctx, expr, expr.callee.name === "__qpi_invoke_other");
    if (wat) ctx.lines.push(`    ${ir.emit(ir.op("drop", ir.raw(wat, "i32", "unconverted: inter-contract call")))}`);
    else ctx.cg.warn(`unsupported inter-contract call to '${expr.args[0]?.kind === "identifier" ? expr.args[0].name : "?"}' (no callee IDL)`, expr.span.line);
    return;
  }

  // QPI memory wrappers: setMemory(dst,val) / copyMemory(dst,src) / copyFromBuffer(dst,src) / copyToBuffer(dst,src,tailZero). Lowered at the call site so the byte
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
