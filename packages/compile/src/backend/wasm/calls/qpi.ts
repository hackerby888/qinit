import { addrIr } from "../memory/memory-operations";
import { EMPTY_TEMPLATE_BINDINGS, FunctionEmissionContext } from "../types";
import type { Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
function parsedAggregateLayout(context: FunctionEmissionContext, name: string) {
    const layout = context.programAnalysis.layoutOfType({ kind: "name", name }, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    if (!layout)
        throw new Error(`core QPI aggregate '${name}' has no parsed layout`);
    const field = (fieldName: string): number => {
        const value = layout.fields.get(fieldName);
        if (!value)
            throw new Error(`core QPI aggregate '${name}' is missing field '${fieldName}'`);
        return value.offset;
    };
    const firstField = (...fieldNames: string[]): number => {
        const fieldName = fieldNames.find((candidate) => layout.fields.has(candidate));
        if (!fieldName)
            throw new Error(`core QPI aggregate '${name}' is missing fields '${fieldNames.join("' or '")}'`);
        return field(fieldName);
    };
    return { layout, field, firstField };
}
export function materializeSelect(context: FunctionEmissionContext, expression: Expression | undefined): string {
    const parsed = parsedAggregateLayout(context, "AssetOwnershipSelect");
    const slot = context.lowering.allocateScratchSlotNode(context, parsed.layout.size);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", slot, watIr.i32Constant(parsed.layout.size), watIr.i32Constant(0)))}`);
    const flag = (offset: number, value: number) => context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store8", null, watIr.addressWithOffset(slot, offset), watIr.i32Constant(value)))}`);
    const clamp = (value: Expression, mnemonic: string, offset: number, mask: string) => context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore(mnemonic, null, watIr.addressWithOffset(slot, offset), watIr.operation("i32.and", watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, value)), watIr.i32Constant(mask))))}`);
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
    }
    else if (staticName === "byOwner" || staticName === "byPossessor") {
        const source = callExpression?.callArguments[0] ? context.lowering.emitAddress(context, callExpression.callArguments[0]) : null;
        if (!source)
            throw new Error(`${staticName} selector id is not addressable`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", slot, addrIr(source), watIr.i32Constant(32)))}`);
        flag(parsed.field("anyManagingContract"), 1);
    }
    else if (staticName === "byManagingContract") {
        if (!callExpression?.callArguments[0])
            throw new Error("byManagingContract selector is missing its contract index");
        clamp(callExpression.callArguments[0], "i32.store16", parsed.field("managingContract"), "0xffff");
        flag(parsed.firstField("anyOwner", "anyPossessor", "anyId"), 1);
    }
    else if (expression.kind === "initializer_list") {
        const source = expression.expressions[0] ? context.lowering.emitAddress(context, expression.expressions[0]) : null;
        if (source)
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", slot, addrIr(source), watIr.i32Constant(32)))}`);
        else if (expression.expressions[0])
            throw new Error("asset selector id is not addressable");
        if (expression.expressions[1])
            clamp(expression.expressions[1], "i32.store16", parsed.field("managingContract"), "0xffff");
        if (expression.expressions[2])
            clamp(expression.expressions[2], "i32.store8", parsed.firstField("anyOwner", "anyPossessor", "anyId"), "1");
        if (expression.expressions[3])
            clamp(expression.expressions[3], "i32.store8", parsed.field("anyManagingContract"), "1");
    }
    else {
        const source = context.lowering.emitAddress(context, expression);
        if (!source)
            throw new Error("asset selector is not addressable");
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", slot, addrIr(source), watIr.i32Constant(parsed.layout.size)))}`);
    }
    return watIr.serializeWatNode(slot);
}
export function materializeAssetAddress(context: FunctionEmissionContext, expression: Expression | undefined, bindingName: string): string {
    if (expression?.kind === "initializer_list") {
        const parsed = parsedAggregateLayout(context, "Asset");
        const slot = context.lowering.allocateScratchSlotNode(context, parsed.layout.size);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", slot, watIr.i32Constant(parsed.layout.size), watIr.i32Constant(0)))}`);
        const issuer = expression.expressions[0] ? context.lowering.emitAddress(context, expression.expressions[0]) : null;
        if (!issuer)
            throw new Error(`${bindingName} asset issuer is not addressable`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", slot, addrIr(issuer), watIr.i32Constant(32)))}`);
        if (!expression.expressions[1])
            throw new Error(`${bindingName} asset name is missing`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, watIr.addressWithOffset(slot, parsed.field("assetName")), context.lowering.lowerValueExpression(context, expression.expressions[1])))}`);
        return watIr.serializeWatNode(slot);
    }
    const address = expression
        ? (context.lowering.resolveExpressionAddress(context, expression)?.addr ?? context.lowering.emitAddress(context, expression))
        : null;
    if (!address)
        throw new Error(`${bindingName} asset argument is missing or not addressable`);
    return address;
}
/** Fail closed when a qpi method is absent from the parsed context inheritance hierarchy. */
export function emitQpiCall(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): null {
    if (!(expression.callee.kind === "member_access" &&
        expression.callee.object.kind === "identifier" &&
        expression.callee.object.name === "qpi"))
        return null;
    const contextType = context.params?.get("qpi")?.type;
    if (contextType?.kind === "name" &&
        context.programAnalysis.hasInstanceMethod(contextType.name, expression.callee.member))
        return null;
    if (contextType?.kind === "name" &&
        /QpiContextFunctionCall$/.test(contextType.name) &&
        context.programAnalysis.hasInstanceMethod("QpiContextProcedureCall", expression.callee.member)) {
        throw new Error(`QPI method '${expression.callee.member}' is unavailable in a function context`);
    }
    throw new Error(`unknown QPI method '${expression.callee.member}' in parsed core source`);
}
