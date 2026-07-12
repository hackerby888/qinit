import { newTmp } from "../stmt";
import { emitAddr, allocSlotIr, addrIr, resolveAddr, setLocal, allocSlot } from "../addr";
import { emitValue, emitValueIr, scalarTypeInfo } from "../value";
import { FnCtx, NO_BIND } from "../types";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../../ast";
import * as ir from "../../ir";
import { LHOST_ABI, type LhostImportName } from "@qinit/core";

// qpi.* host calls taking args / returning values. Arg kinds map to forwarder param types:
export type ArgKind = "i64" | "i32" | "addr" | "cidx" | "asset" | "ownsel" | "possel" | "sized" | "assetref";
export interface QpiBinding {
  source: string;
  context: "function" | "procedure" | "both";
  fwd: string;
  args: ArgKind[];
  ret: "i64" | "i32" | "void" | "out";
  channel: "value" | "address" | "void";
  host?: LhostImportName;
  outSize?: number;
  recipeMode?: "generic" | "oracle" | "inter-contract" | "asset-adapter";
}

const binding = (source: string, fwd: string, args: ArgKind[], ret: QpiBinding["ret"], context: QpiBinding["context"] = "both"): QpiBinding => ({
  source, context, fwd, args, ret, channel: ret === "out" ? "address" : ret === "void" ? "void" : "value",
});

type RawQpiBinding = Pick<QpiBinding, "fwd" | "args" | "ret"> & Partial<Omit<QpiBinding, "fwd" | "args" | "ret">>;

const RAW_QPI_BINDINGS: Record<string, RawQpiBinding> = {
  epoch: { fwd: "$qpi_epoch", args: [], ret: "i32" },
  tick: { fwd: "$qpi_tick", args: [], ret: "i32" },
  numberOfTickTransactions: { fwd: "$qpi_numberOfTickTransactions", args: [], ret: "i32" },
  day: { fwd: "$qpi_day", args: [], ret: "i32" },
  year: { fwd: "$qpi_year", args: [], ret: "i32" },
  hour: { fwd: "$qpi_hour", args: [], ret: "i32" },
  minute: { fwd: "$qpi_minute", args: [], ret: "i32" },
  month: { fwd: "$qpi_month", args: [], ret: "i32" },
  second: { fwd: "$qpi_second", args: [], ret: "i32" },
  millisecond: { fwd: "$qpi_millisecond", args: [], ret: "i32" },
  transfer: binding("QpiContextProcedureCall::transfer", "$qpi_transfer", ["addr", "i64"], "i64", "procedure"),
  K12: binding("QpiContext::K12", "$qpi_k12", ["sized"], "out"),
  now: binding("QpiContext::now", "$qpi_now", [], "out"),
  burn: binding("QpiContextProcedureCall::burn", "$qpi_burn", ["i64", "cidx"], "i64", "procedure"),
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
  initMiningSeed: binding("QpiContext::initMiningSeed", "$qpi_initMiningSeed", ["addr"], "void"),
  setShareholderProposal: binding("QpiContextProcedureCall::setShareholderProposal", "$lh_liteSetShareholderProposal", ["i32", "addr", "i64"], "i32", "procedure"),
  setShareholderVotes: binding("QpiContextProcedureCall::setShareholderVotes", "$lh_liteSetShareholderVotes", ["i32", "sized", "i64"], "i32", "procedure"),
  __queryOracle: { source: "QpiContextFunctionCall::__qpiQueryOracle", context: "both", fwd: "$lh_queryOracle", args: ["i32", "addr", "i32", "i32", "i32", "i64"], ret: "i64", host: "queryOracle", recipeMode: "oracle" },
  __subscribeOracle: { source: "QpiContextFunctionCall::__qpiSubscribeOracle", context: "both", fwd: "$lh_subscribeOracle", args: ["i32", "addr", "i32", "i32", "i32", "i32", "i64"], ret: "i32", host: "subscribeOracle", recipeMode: "oracle" },
  __getOracleQuery: { source: "QpiContextFunctionCall::getOracleQuery", context: "both", fwd: "$lh_getOracleQuery", args: ["i64", "addr", "i32"], ret: "i32", host: "getOracleQuery", recipeMode: "oracle" },
  __getOracleReply: { source: "QpiContextFunctionCall::getOracleReply", context: "both", fwd: "$lh_getOracleReply", args: ["i64", "addr", "i32"], ret: "i32", host: "getOracleReply", recipeMode: "oracle" },
  __callOther: { source: "CALL_OTHER_CONTRACT_FUNCTION", context: "both", fwd: "$liteCallFunction", args: ["i32", "i32", "addr", "i32", "addr", "i32"], ret: "i32", host: "liteCallFunction", recipeMode: "inter-contract" },
  __invokeOther: { source: "INVOKE_OTHER_CONTRACT_PROCEDURE", context: "procedure", fwd: "$liteInvokeProcedure", args: ["i32", "i32", "addr", "i32", "addr", "i32", "i64"], ret: "i32", host: "liteInvokeProcedure", recipeMode: "inter-contract" },
  __assetEnumerate: { source: "AssetOwnershipIterator/AssetPossessionIterator", context: "both", fwd: "$lh_assetEnumerate", args: ["i32", "addr", "addr", "addr", "addr", "i32"], ret: "i32", host: "assetEnumerate", recipeMode: "asset-adapter" },
};

// Complete descriptors above use the compact literal shape for readability; normalize it once and ratchet names/symbols.
export const QPI_BINDINGS: Readonly<Record<string, QpiBinding>> = Object.freeze(Object.fromEntries(
  Object.entries(RAW_QPI_BINDINGS).map(([name, descriptor]) => [name, Object.freeze({
    ...descriptor,
    source: descriptor.source ?? `QpiContext::${name}`,
    context: descriptor.context ?? ([
      "transferShareOwnershipAndPossession", "releaseShares", "acquireShares", "distributeDividends",
      "issueAsset", "bidInIPO", "unsubscribeOracle",
    ].includes(name) ? "procedure" : "both"),
    channel: descriptor.channel ?? (descriptor.ret === "out" ? "address" : descriptor.ret === "void" ? "void" : "value"),
    host: descriptor.host ?? (name === "K12" ? "k12" : name in LHOST_ABI ? name : undefined) as LhostImportName | undefined,
    outSize: descriptor.ret === "out" ? (name === "now" ? 8 : 32) : undefined,
    recipeMode: descriptor.recipeMode ?? "generic",
  } satisfies QpiBinding)]),
));
const qpiSymbols = new Map<string, string>();
const recipeAbi = (kind: ArgKind): readonly ("i32" | "i64")[] => {
  if (kind === "i64") return ["i64"];
  if (kind === "asset") return ["i64", "i32"];
  if (kind === "sized") return ["i32", "i32"];
  return ["i32"];
};
for (const [name, descriptor] of Object.entries(QPI_BINDINGS)) {
  const previous = qpiSymbols.get(descriptor.fwd);
  if (previous && previous !== name) throw new Error(`duplicate QPI compiler symbol '${descriptor.fwd}' (${previous}, ${name})`);
  qpiSymbols.set(descriptor.fwd, name);
  if (descriptor.host) {
    const expected = LHOST_ABI[descriptor.host];
    const params = [...descriptor.args.flatMap(recipeAbi), ...(descriptor.ret === "out" ? ["i32" as const] : [])];
    const results = descriptor.ret === "i32" || descriptor.ret === "i64" ? [descriptor.ret] : [];
    if (params.join(",") !== expected.params.join(",") || results.join(",") !== expected.results.join(",")) {
      throw new Error(`QPI binding '${name}' is incompatible with lhost.${descriptor.host}: (${params}) -> (${results}) != (${expected.params}) -> (${expected.results})`);
    }
  }
}

// Scalar context accessors share call dispatch with zero-argument host bindings. Only the context-memory
// fields remain declared here; every host-backed getter is selected from QPI_BINDINGS.
export const QPI_GETTERS: Readonly<Record<string, { fwd: string; ret: "i64" | "i32" }>> = Object.freeze({
  ...Object.fromEntries(Object.entries(QPI_BINDINGS)
    .filter(([, descriptor]) => descriptor.args.length === 0 && (descriptor.ret === "i32" || descriptor.ret === "i64"))
    .map(([name, descriptor]) => [name, Object.freeze({ fwd: descriptor.fwd, ret: descriptor.ret as "i64" | "i32" })])),
  contractIndex: Object.freeze({ fwd: "$qpi_contractIndex", ret: "i32" as const }),
});

/** @deprecated internal compatibility name while callers migrate to QPI_BINDINGS. */
export const QPI_CALLS = QPI_BINDINGS;

export const QPI_AGGREGATE_LAYOUTS = Object.freeze({
  Asset: Object.freeze({ size: 40, fields: Object.freeze({ issuer: 0, assetName: 32 }) }),
  AssetSelect: Object.freeze({ size: 40, fields: Object.freeze({ id: 0, managingContract: 32, anyId: 34, anyManagingContract: 35 }) }),
});

// Map a single qpi argument to a forwarder operand by its declared kind.
export function qpiOperand(ctx: FnCtx, expr: Expression, kind: ArgKind): string {
  if (kind === "i64") return emitValue(ctx, expr);
  if (kind === "i32") return `(i32.wrap_i64 ${emitValue(ctx, expr)})`;
  const a = emitAddr(ctx, expr);
  if (a) return a;
  throw new Error(`qpi argument is not an addressable id/struct at line ${(expr as any).span?.line ?? 0}`);
}

// Build the forwarder operand list. "cidx" is injected; every other kind consumes one call arg.
export function materializeSelect(ctx: FnCtx, e: Expression | undefined): string {
  const layout = QPI_AGGREGATE_LAYOUTS.AssetSelect;
  const s = allocSlotIr(ctx, layout.size);
  ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(layout.size), ir.i32c(0)))}`);
  const flag = (off: number, v: number) => ctx.lines.push(`    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(s, off), ir.i32c(v)))}`);
  const clamp = (e2: Expression, mnemonic: string, off: number, mask: string) =>
    ctx.lines.push(`    ${ir.emit(ir.storeRaw(mnemonic, null, ir.addr0(s, off), ir.op("i32.and", ir.op("i32.wrap_i64", emitValueIr(ctx, e2)), ir.i32c(mask))))}`);
  const staticName = e && e.kind === "call"
    ? (e.callee.kind === "qualified_name" ? e.callee.name : e.callee.kind === "member_access" ? e.callee.member : null)
    : null;
  if (!e || staticName === "any") {
    flag(layout.fields.anyId, 1);
    flag(layout.fields.anyManagingContract, 1);
  } else if (staticName === "byOwner" || staticName === "byPossessor") {
    const idSrc = e.kind === "call" && e.args[0] ? emitAddr(ctx, e.args[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    if (!idSrc) throw new Error(`${staticName} selector id is not addressable`);
    flag(layout.fields.anyManagingContract, 1);
  } else if (staticName === "byManagingContract") {
    if (!(e.kind === "call" && e.args[0])) throw new Error("byManagingContract selector is missing its contract index");
    clamp(e.args[0], "i32.store16", layout.fields.managingContract, "0xffff");
    flag(layout.fields.anyId, 1);
  } else if (e.kind === "initializer_list") {
    const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
    if (idSrc) ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    if (e.exprs[0] && !idSrc) throw new Error("asset selector id is not addressable");
    if (e.exprs[1]) clamp(e.exprs[1], "i32.store16", layout.fields.managingContract, "0xffff");
    if (e.exprs[2]) clamp(e.exprs[2], "i32.store8", layout.fields.anyId, "1");
    if (e.exprs[3]) clamp(e.exprs[3], "i32.store8", layout.fields.anyManagingContract, "1");
  } else {
    const a = emitAddr(ctx, e);
    if (a) {
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(a), ir.i32c(layout.size)))}`);
    } else {
      throw new Error("asset selector is not addressable");
    }
  }
  return ir.emit(s);
}

export function materializeAssetAddress(ctx: FnCtx, e: Expression | undefined, bindingName: string): string {
  if (e?.kind === "initializer_list") {
    const assetLayout = QPI_AGGREGATE_LAYOUTS.Asset;
    const s = allocSlotIr(ctx, assetLayout.size);
    ctx.lines.push(`    ${ir.emit(ir.call("$setMem", s, ir.i32c(assetLayout.size), ir.i32c(0)))}`);
    const idSrc = e.exprs[0] ? emitAddr(ctx, e.exprs[0]) : null;
    if (!idSrc) throw new Error(`${bindingName} asset issuer is not addressable`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", s, addrIr(idSrc), ir.i32c(32)))}`);
    if (!e.exprs[1]) throw new Error(`${bindingName} asset name is missing`);
    ctx.lines.push(`    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(s, assetLayout.fields.assetName), emitValueIr(ctx, e.exprs[1])))}`);
    return ir.emit(s);
  }
  const address = e ? (resolveAddr(ctx, e)?.addr ?? emitAddr(ctx, e)) : null;
  if (!address) throw new Error(`${bindingName} asset argument is missing or not addressable`);
  return address;
}

export function emitQpiOperands(ctx: FnCtx, args: Expression[], kinds: ArgKind[], bindingName = "qpi call"): string[] {
  const ops: string[] = [];
  let ai = 0;
  for (const k of kinds) {
    if (k === "cidx") {
      // The authoritative declaration may supply an explicit/defaulted target. Older snapshots omit
      // that source operand; preserve their established current-contract injection without a null/zero ABI fallback.
      const explicit = args[ai];
      if (explicit) {
        ops.push(`(i32.wrap_i64 ${emitValue(ctx, explicit)})`);
        ai++;
      } else {
        ops.push("(call $qpi_contractIndex)");
      }
      continue;
    }
    const e = args[ai++];
    if (k === "ownsel" || k === "possel") {
      // Selector is passed by address (i32). A missing arg is the C++ default `::any()`, so this must run
      ops.push(materializeSelect(ctx, e));
      continue;
    }
    if (k === "assetref") {
      // const Asset& — 40 bytes {id issuer @0, uint64 assetName @32}. Accepts a `{issuer, name}`
      ops.push(materializeAssetAddress(ctx, e, bindingName));
      continue;
    }
    if (k === "sized") {
      // data passed as (addr, sizeof(data)) — the host hashes/copies raw bytes (qpi.K12(const T&)).
      if (!e) {
        throw new Error(`${bindingName} sized-buffer argument is missing`);
      }
      const node = resolveAddr(ctx, e);
      let addr = node?.addr ?? emitAddr(ctx, e);
      let sz = e.kind === "construct"
        ? ctx.cg.sizeOfType(e.type, ctx.thisBind ?? NO_BIND)
        : node?.type ? ctx.cg.sizeOfType(node.type, ctx.thisBind ?? NO_BIND) : (scalarTypeInfo(ctx, e)?.width ?? 32);
      if (!addr) {
        // A const-reference parameter may bind to a scalar temporary. Materialize its exact object
        // representation instead of substituting a null pointer.
        sz = sz > 0 && sz <= 8 ? sz : 8;
        const temporary = allocSlotIr(ctx, sz);
        ctx.lines.push(`    ${ir.emit(ir.storeScalar(temporary, sz, emitValueIr(ctx, e)))}`);
        addr = ir.emit(temporary);
      }
      ops.push(addr, `(i32.const ${sz || 32})`);
      continue;
    }
    if (!e) {
      throw new Error(`${bindingName} is missing required argument ${ai}`);
    }
    if (k === "asset") {
      const a = materializeAssetAddress(ctx, e, bindingName);
      const t = newTmp(ctx);
      ctx.lines.push(`    ${setLocal(ctx, t, addrIr(a))}`);
      ops.push(ir.emit(ir.loadRaw("i64.load", null, ir.addr0(ir.getL(t, "i32"), QPI_AGGREGATE_LAYOUTS.Asset.fields.assetName))));
      ops.push(ir.emit(ir.getL(t, "i32")));
      continue;
    }
    ops.push(qpiOperand(ctx, e, k));
  }
  if (args.length > ai) throw new Error(`${bindingName} expects at most ${ai} source argument(s), got ${args.length}`);
  return ops;
}

export interface QpiResult {
  wat: string;
  ret: "i64" | "i32" | "void" | "out";
}

// Lower a qpi.host(...) call. For "out" producers, outAddr receives the result (a scratch slot is
export function emitQpiCall(ctx: FnCtx, expr: Expression & { kind: "call" }, outAddr?: string): QpiResult | null {
  if (!(expr.callee.kind === "member_access" && expr.callee.object.kind === "identifier" && expr.callee.object.name === "qpi")) {
    return null;
  }
  const desc = QPI_BINDINGS[expr.callee.member];
  if (!desc) {
    const contextType = ctx.params?.get("qpi")?.type;
    if (contextType?.kind === "name" && ctx.cg.hasInstanceMethod(contextType.name, expr.callee.member)) return null;
    if (QPI_GETTERS[expr.callee.member] || [
      "getPrevSpectrumDigest", "getPrevUniverseDigest", "getPrevComputerDigest",
    ].includes(expr.callee.member)) return null;
    throw new Error(`unknown QPI binding '${expr.callee.member}'`);
  }
  if (ctx.qpiContext === "function" && desc.context === "procedure") {
    throw new Error(`${desc.source} is not allowed in a function context`);
  }

  const ops = emitQpiOperands(ctx, expr.args, desc.args, desc.source);
  if (desc.ret === "out") {
    ops.push(outAddr ?? allocSlot(ctx, desc.outSize ?? 32));
  }
  return { wat: `(call ${desc.fwd} ${ops.join(" ")})`, ret: desc.ret };
}
