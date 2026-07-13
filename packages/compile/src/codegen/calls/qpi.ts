import { allocSlotIr, addrIr, emitAddr, resolveAddr } from "../addr";
import { emitValueIr } from "../value";
import { NO_BIND, type FnCtx } from "../types";
import type { Expression } from "../../ast";
import * as ir from "../../ir";

function parsedAggregateLayout(ctx: FnCtx, name: string) {
  const layout = ctx.cg.layoutOfType({ kind: "name", name }, ctx.thisBind ?? NO_BIND);
  if (!layout) throw new Error(`core QPI aggregate '${name}' has no parsed layout`);
  const field = (fieldName: string): number => {
    const value = layout.fields.get(fieldName);
    if (!value) throw new Error(`core QPI aggregate '${name}' is missing field '${fieldName}'`);
    return value.offset;
  };
  const firstField = (...fieldNames: string[]): number => {
    const fieldName = fieldNames.find((candidate) => layout.fields.has(candidate));
    if (!fieldName)
      throw new Error(
        `core QPI aggregate '${name}' is missing fields '${fieldNames.join("' or '")}'`,
      );
    return field(fieldName);
  };
  return { layout, field, firstField };
}

export function materializeSelect(ctx: FnCtx, expression: Expression | undefined): string {
  const parsed = parsedAggregateLayout(ctx, "AssetOwnershipSelect");
  const slot = allocSlotIr(ctx, parsed.layout.size);
  ctx.lines.push(
    `    ${ir.emit(ir.call("$setMem", slot, ir.i32c(parsed.layout.size), ir.i32c(0)))}`,
  );
  const flag = (offset: number, value: number) =>
    ctx.lines.push(
      `    ${ir.emit(ir.storeRaw("i32.store8", null, ir.addr0(slot, offset), ir.i32c(value)))}`,
    );
  const clamp = (value: Expression, mnemonic: string, offset: number, mask: string) =>
    ctx.lines.push(
      `    ${ir.emit(ir.storeRaw(mnemonic, null, ir.addr0(slot, offset), ir.op("i32.and", ir.op("i32.wrap_i64", emitValueIr(ctx, value)), ir.i32c(mask))))}`,
    );
  const callExpression = expression?.kind === "call" ? expression : undefined;
  const staticName = callExpression
    ? callExpression.callee.kind === "qualified_name"
      ? callExpression.callee.name
      : callExpression.callee.kind === "member_access"
        ? callExpression.callee.member
        : null
    : null;
  if (!expression || staticName === "any") {
    flag(parsed.firstField("anyOwner", "anyPossessor", "anyId"), 1);
    flag(parsed.field("anyManagingContract"), 1);
  } else if (staticName === "byOwner" || staticName === "byPossessor") {
    const source = callExpression?.args[0] ? emitAddr(ctx, callExpression.args[0]) : null;
    if (!source) throw new Error(`${staticName} selector id is not addressable`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", slot, addrIr(source), ir.i32c(32)))}`);
    flag(parsed.field("anyManagingContract"), 1);
  } else if (staticName === "byManagingContract") {
    if (!callExpression?.args[0])
      throw new Error("byManagingContract selector is missing its contract index");
    clamp(callExpression.args[0], "i32.store16", parsed.field("managingContract"), "0xffff");
    flag(parsed.firstField("anyOwner", "anyPossessor", "anyId"), 1);
  } else if (expression.kind === "initializer_list") {
    const source = expression.exprs[0] ? emitAddr(ctx, expression.exprs[0]) : null;
    if (source)
      ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", slot, addrIr(source), ir.i32c(32)))}`);
    else if (expression.exprs[0]) throw new Error("asset selector id is not addressable");
    if (expression.exprs[1])
      clamp(expression.exprs[1], "i32.store16", parsed.field("managingContract"), "0xffff");
    if (expression.exprs[2])
      clamp(
        expression.exprs[2],
        "i32.store8",
        parsed.firstField("anyOwner", "anyPossessor", "anyId"),
        "1",
      );
    if (expression.exprs[3])
      clamp(expression.exprs[3], "i32.store8", parsed.field("anyManagingContract"), "1");
  } else {
    const source = emitAddr(ctx, expression);
    if (!source) throw new Error("asset selector is not addressable");
    ctx.lines.push(
      `    ${ir.emit(ir.call("$copyMem", slot, addrIr(source), ir.i32c(parsed.layout.size)))}`,
    );
  }
  return ir.emit(slot);
}

export function materializeAssetAddress(
  ctx: FnCtx,
  expression: Expression | undefined,
  bindingName: string,
): string {
  if (expression?.kind === "initializer_list") {
    const parsed = parsedAggregateLayout(ctx, "Asset");
    const slot = allocSlotIr(ctx, parsed.layout.size);
    ctx.lines.push(
      `    ${ir.emit(ir.call("$setMem", slot, ir.i32c(parsed.layout.size), ir.i32c(0)))}`,
    );
    const issuer = expression.exprs[0] ? emitAddr(ctx, expression.exprs[0]) : null;
    if (!issuer) throw new Error(`${bindingName} asset issuer is not addressable`);
    ctx.lines.push(`    ${ir.emit(ir.call("$copyMem", slot, addrIr(issuer), ir.i32c(32)))}`);
    if (!expression.exprs[1]) throw new Error(`${bindingName} asset name is missing`);
    ctx.lines.push(
      `    ${ir.emit(ir.storeRaw("i64.store", null, ir.addr0(slot, parsed.field("assetName")), emitValueIr(ctx, expression.exprs[1])))}`,
    );
    return ir.emit(slot);
  }
  const address = expression
    ? (resolveAddr(ctx, expression)?.addr ?? emitAddr(ctx, expression))
    : null;
  if (!address) throw new Error(`${bindingName} asset argument is missing or not addressable`);
  return address;
}

/** Fail closed when a qpi method is absent from the parsed context inheritance hierarchy. */
export function emitQpiCall(ctx: FnCtx, expression: Expression & { kind: "call" }): null {
  if (!(
    expression.callee.kind === "member_access" &&
    expression.callee.object.kind === "identifier" &&
    expression.callee.object.name === "qpi"
  ))
    return null;
  const contextType = ctx.params?.get("qpi")?.type;
  if (
    contextType?.kind === "name" &&
    ctx.cg.hasInstanceMethod(contextType.name, expression.callee.member)
  )
    return null;
  if (
    contextType?.kind === "name" &&
    /QpiContextFunctionCall$/.test(contextType.name) &&
    ctx.cg.hasInstanceMethod("QpiContextProcedureCall", expression.callee.member)
  ) {
    throw new Error(
      `QPI method '${expression.callee.member}' is unavailable in a function context`,
    );
  }
  throw new Error(`unknown QPI method '${expression.callee.member}' in parsed core source`);
}
