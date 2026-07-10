import { newTmp } from "../stmt";
import { emitAddr, allocSlotIr, addrIr, resolveAddr, setLocal, allocSlot } from "../addr";
import { emitValue, emitValueIr } from "../value";
import { FnCtx, NO_BIND } from "../types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";

// qpi.* zero-arg getters → forwarder + scalar return width.
export const QPI_GETTERS: Record<string, { fwd: string; ret: "i64" | "i32" }> = {
  invocationReward: { fwd: "$qpi_invocationReward", ret: "i64" },
  epoch: { fwd: "$qpi_epoch", ret: "i32" },
  tick: { fwd: "$qpi_tick", ret: "i32" },
  numberOfTickTransactions: { fwd: "$qpi_numberOfTickTransactions", ret: "i32" },
  day: { fwd: "$qpi_day", ret: "i32" },
  year: { fwd: "$qpi_year", ret: "i32" },
  hour: { fwd: "$qpi_hour", ret: "i32" },
  minute: { fwd: "$qpi_minute", ret: "i32" },
  month: { fwd: "$qpi_month", ret: "i32" },
  second: { fwd: "$qpi_second", ret: "i32" },
  millisecond: { fwd: "$qpi_millisecond", ret: "i32" },
  contractIndex: { fwd: "$qpi_contractIndex", ret: "i32" },
};

// qpi.* host calls taking args / returning values. Arg kinds map to forwarder param types:
//   i64 = scalar value, i32 = scalar truncated, addr = address of an id/struct lvalue (or SELF),
//   cidx = the contract's own index (SELF_INDEX, injected, not taken from the call's args).
// ret "out" = void forwarder whose LAST param is an output address the produced id/struct is written
// into — used as an assignment RHS (e.g. output.next = qpi.nextId(input.cur)).
// "asset" consumes ONE Asset argument (id issuer; uint64 assetName) but emits TWO operands — the assetName
// (i64, loaded from offset 32) then the issuer address — matching the lhost share calls' (name, issuer, …).
export type ArgKind = "i64" | "i32" | "addr" | "cidx" | "asset" | "ownsel" | "possel" | "sized" | "assetref";
export interface QpiCallDesc {
  fwd: string;
  args: ArgKind[];
  ret: "i64" | "i32" | "void" | "out";
}

export const QPI_CALLS: Record<string, QpiCallDesc> = {
  transfer: { fwd: "$qpi_transfer", args: ["addr", "i64"], ret: "i64" },
  K12: { fwd: "$qpi_k12", args: ["sized"], ret: "out" },
  now: { fwd: "$qpi_now", args: [], ret: "out" },
  burn: { fwd: "$qpi_burn", args: ["i64", "cidx"], ret: "i64" },
  issueAsset: { fwd: "$qpi_issueAsset", args: ["i64", "addr", "i32", "i64", "i64"], ret: "i64" },
  isAssetIssued: { fwd: "$qpi_isAssetIssued", args: ["addr", "i64"], ret: "i32" },
  transferShareOwnershipAndPossession: { fwd: "$qpi_transferShares", args: ["i64", "addr", "addr", "addr", "i64", "addr"], ret: "i64" },
  numberOfShares: { fwd: "$qpi_numberOfShares", args: ["assetref", "ownsel", "possel"], ret: "i64" },
  numberOfPossessedShares: { fwd: "$qpi_numberOfPossessedShares", args: ["i64", "addr", "addr", "addr", "i32", "i32"], ret: "i64" },
  releaseShares: { fwd: "$qpi_releaseShares", args: ["asset", "addr", "addr", "i64", "i32", "i32", "i64"], ret: "i64" },
  acquireShares: { fwd: "$qpi_acquireShares", args: ["asset", "addr", "addr", "i64", "i32", "i32", "i64"], ret: "i64" },
  distributeDividends: { fwd: "$qpi_distributeDividends", args: ["i64"], ret: "i32" },
  dayOfWeek: { fwd: "$qpi_dayOfWeek", args: ["i32", "i32", "i32"], ret: "i32" },
  getEntity: { fwd: "$qpi_getEntity", args: ["addr", "addr"], ret: "i32" },
  isContractId: { fwd: "$qpi_isContractId", args: ["addr"], ret: "i32" },
  nextId: { fwd: "$qpi_nextId", args: ["addr"], ret: "out" },
  prevId: { fwd: "$qpi_prevId", args: ["addr"], ret: "out" },
  arbitrator: { fwd: "$qpi_arbitrator", args: [], ret: "out" },
  computor: { fwd: "$qpi_computor", args: ["i32"], ret: "out" },
  queryFeeReserve: { fwd: "$qpi_queryFeeReserve", args: ["i32"], ret: "i64" },
  bidInIPO: { fwd: "$qpi_bidInIPO", args: ["i32", "i64", "i32"], ret: "i64" },
  ipoBidPrice: { fwd: "$qpi_ipoBidPrice", args: ["i32", "i32"], ret: "i64" },
  ipoBidId: { fwd: "$qpi_ipoBidId", args: ["i32", "i32"], ret: "out" },
  unsubscribeOracle: { fwd: "$qpi_unsubscribeOracle", args: ["i32"], ret: "i32" },
  getOracleQueryStatus: { fwd: "$qpi_getOracleQueryStatus", args: ["i64"], ret: "i32" },
  signatureValidity: { fwd: "$qpi_signatureValidity", args: ["addr", "addr", "addr"], ret: "i32" },
  computeMiningFunction: { fwd: "$qpi_computeMiningFunction", args: ["addr", "addr", "addr"], ret: "out" },
  initMiningSeed: { fwd: "$qpi_initMiningSeed", args: ["addr"], ret: "void" },
  setShareholderProposal: { fwd: "$lh_liteSetShareholderProposal", args: ["i32", "addr", "i64"], ret: "i32" },
  setShareholderVotes: { fwd: "$lh_liteSetShareholderVotes", args: ["i32", "sized", "i64"], ret: "i32" },
};

// Map a single qpi argument to a forwarder operand by its declared kind.
export function qpiOperand(ctx: FnCtx, expr: Expression, kind: ArgKind): string {
  if (kind === "i64") return emitValue(ctx, expr);
  if (kind === "i32") return `(i32.wrap_i64 ${emitValue(ctx, expr)})`;
  const a = emitAddr(ctx, expr);
  if (a) return a;
  ctx.cg.warn(`qpi argument is not an addressable id/struct`, (expr as any).span?.line ?? 0);
  return "(i32.const 0)";
}

// Build the forwarder operand list. "cidx" is injected; every other kind consumes one call arg.
// Materialize a 40-byte AssetOwnershipSelect / AssetPossessionSelect and return its address (i32). These have
// no inferred type at the call site (brace-init or a static-factory result), so emitAddr can't lower them.
// Layout: id owner/possessor @0 (32), managingContract u16 @32, anyOwner/anyPossessor bool @34,
// anyManagingContract bool @35. Forms handled: a missing argument (the C++ default `::any()`), the static
// factories any()/byOwner()/byPossessor()/byManagingContract(), a `{id, mgmt}` brace-init, and an addressable
// select lvalue. any() = { zero, 0, true, true }; byOwner/byPossessor = { id, 0, false, true };
// byManagingContract = { zero, mgmt, true, false } (see qpi.h AssetOwnershipSelect).
export function materializeSelect(ctx: FnCtx, e: Expression | undefined): string {
  const s = allocSlotIr(ctx, 40);
  ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
  const flag = (off: number, v: number) => ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, off), ir.i32c(v)))}`);
  const clamp = (e2: Expression, mnemonic: string, off: number, mask: string) =>
    ctx.lines.push(`    ${ir.emit(ir.storeRaw(mnemonic, null, ir.addr0(s, off), ir.op("i32.and", ir.op("i32.wrap_i64", emitValueIr(ctx, e2)), ir.i32c(mask))))}`);
  const staticName = e && e.kind === "call"
    ? (e.callee.kind === "qualified_name" ? e.callee.name : e.callee.kind === "member_access" ? e.callee.member : null)
    : null;
  if (!e || staticName === "any") {
    flag(34, 1);
    flag(35, 1);
  } else if (staticName === "byOwner" || staticName === "byPossessor") {
    const idSrc = e.kind === "call" && e.args[0] ? emitAddr(ctx, e.args[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    flag(35, 1);
  } else if (staticName === "byManagingContract") {
    if (e.kind === "call" && e.args[0]) clamp(e.args[0], "i32.store16", 32, "0xffff");
    flag(34, 1);
  } else if (e.kind === "initializer_list") {
    const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    if (e.exprs[1]) clamp(e.exprs[1], "i32.store16", 32, "0xffff");
    if (e.exprs[2]) clamp(e.exprs[2], "i32.store8", 34, "1");
    if (e.exprs[3]) clamp(e.exprs[3], "i32.store8", 35, "1");
  } else {
    const a = emitAddr(ctx, e);
    if (a) {
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(a), ir.i32c(40)))}`);
    } else {
      flag(34, 1);
      flag(35, 1);
    }
  }
  return ir.emit(s);
}

export function emitQpiOperands(ctx: FnCtx, args: Expression[], kinds: ArgKind[]): string[] {
  const ops: string[] = [];
  let ai = 0;
  for (const k of kinds) {
    if (k === "cidx") {
      ops.push("(call $qpi_contractIndex)");
      continue;
    }
    const e = args[ai++];
    if (k === "ownsel" || k === "possel") {
      // Selector is passed by address (i32). A missing arg is the C++ default `::any()`, so this must run
      // before the generic missing-arg fallback below (which would push an i64 0 and break wasm validation).
      ops.push(materializeSelect(ctx, e));
      continue;
    }
    if (k === "assetref") {
      // const Asset& — 40 bytes {id issuer @0, uint64 assetName @32}. Accepts a `{issuer, name}`
      // brace-init (Escrow's numberOfShares calls) or an addressable Asset lvalue.
      if (e?.kind === "initializer_list") {
        const s = allocSlotIr(ctx, 40);
        ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(40), ir.i32c(0)))}`);
        const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
        if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
        if (e.exprs[1]) ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(s, 32), emitValueIr(ctx, e.exprs[1])))}`);
        ops.push(ir.emit(s));
        continue;
      }
      const a = e ? (resolveAddr(ctx, e)?.addr ?? emitAddr(ctx, e)) : null;
      if (a) {
        ops.push(a);
      } else {
        if (e) ctx.cg.warn(`qpi argument is not an addressable id/struct`, (e as any).span?.line ?? 0);
        ops.push("(i32.const 0)");
      }
      continue;
    }
    if (k === "sized") {
      // data passed as (addr, sizeof(data)) — the host hashes/copies raw bytes (qpi.K12(const T&)).
      if (!e) {
        ops.push("(i32.const 0)", "(i32.const 0)");
        continue;
      }
      const node = resolveAddr(ctx, e);
      const addr = node?.addr ?? emitAddr(ctx, e);
      if (!addr) {
        ctx.cg.warn(`qpi argument is not an addressable value`, (e as any).span?.line ?? 0);
        ops.push("(i32.const 0)", "(i32.const 0)");
        continue;
      }
      const sz = e.kind === "construct"
        ? ctx.cg.sizeOfType(e.type, ctx.thisBind ?? NO_BIND)
        : node?.type ? ctx.cg.sizeOfType(node.type, ctx.thisBind ?? NO_BIND) : 32;
      ops.push(addr, `(i32.const ${sz || 32})`);
      continue;
    }
    if (!e) {
      ops.push(k === "addr" ? "(i32.const 0)" : "(i64.const 0)");
      continue;
    }
    if (k === "asset") {
      const a = emitAddr(ctx, e);
      if (a) {
        const t = newTmp(ctx);
        ctx.lines.push(`    ${setLocal(ctx, t, addrIr(a))}`);
        ops.push(ir.emit(ir.loadRaw("i64.load", null, ir.addr0(ir.getL(t, "i32"), 32))));   // assetName
        ops.push(ir.emit(ir.getL(t, "i32")));                                               // issuer addr
      } else {
        ctx.cg.warn(`qpi argument is not an addressable id/struct`, (e as any).span?.line ?? 0);
        ops.push("(i64.const 0)", "(i32.const 0)");
      }
      continue;
    }
    ops.push(qpiOperand(ctx, e, k));
  }
  return ops;
}

export interface QpiResult {
  wat: string;
  ret: "i64" | "i32" | "void" | "out";
}

// Lower a qpi.host(...) call. For "out" producers, outAddr receives the result (a scratch slot is
// allocated when none is supplied). Returns null if the call isn't a known qpi host call.
export function emitQpiCall(ctx: FnCtx, expr: Expression & { kind: "call" }, outAddr?: string): QpiResult | null {
  if (!(expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi")) {
    return null;
  }
  const desc = QPI_CALLS[expr.callee.member];
  if (!desc) return null;

  const ops = emitQpiOperands(ctx, expr.args, desc.args);
  if (desc.ret === "out") {
    ops.push(outAddr ?? allocSlot(ctx, 32));
  }
  return { wat: `(call ${desc.fwd} ${ops.join(" ")})`, ret: desc.ret };
}
