import { AstKind, WatNodeType } from "../../../enums";
import { SCALAR_SIZE } from "../abi/tables";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
// True if a type is an aggregate (id/m256i/struct/array) that lives in memory rather than an i64.
export function isAggregate(context: FunctionEmissionContext, type: TypeSpec | null, size: number): boolean {
    if (!type)
        return size > 8;
    if (type.kind === AstKind.NAME && (type.name === "id" || type.name === "m256i"))
        return true;
    if (type.kind === AstKind.ARRAY || type.kind === AstKind.INLINE_STRUCT || type.kind === AstKind.TEMPLATE_INSTANCE)
        return true;
    if (type.kind === AstKind.NAME && context.programAnalysis.layoutOfType(type))
        return true;
    return size > 8;
}
// Verify local assignments against their declared Wasm types.
export function setLocal(context: FunctionEmissionContext, name: string, value: watIr.WatNode): string {
    const lv = context.localVars.get(name) ?? context.params?.get(name);
    if (lv) {
        watIr.assertWatType(value, lv.wasmType, `local.set $${name}`);
    }
    return watIr.serializeWatNode(watIr.localSet(name, value));
}
// Allocate a fresh scratch block, stash its address in a temporary local, and return its local.get node.
export function allocateScratchSlotNode(context: FunctionEmissionContext, size: number): watIr.WatNode {
    const temporaryAddress = context.lowering.allocateTemporaryLocalName(context);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.localSet(temporaryAddress, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(size))))}`);
    return watIr.localGet(temporaryAddress, WatNodeType.I32);
}
export function allocateScratchSlot(context: FunctionEmissionContext, size: number): string {
    return watIr.serializeWatNode(allocateScratchSlotNode(context, size));
}
// Address of an argument: use an existing lvalue directly, or materialize a
// temporary according to the declaration's concrete parameter type.
export function argAddr(context: FunctionEmissionContext, expression: Expression, size: number, type?: TypeSpec, copyConstScalar = false, convertScalarToAggregate = false): string {
    const targetAggregate = !!type && context.programAnalysis.isAggregateType(type);
    const source = convertScalarToAggregate ? context.lowering.resolveExpressionAddress(context, expression) : null;
    const sourceAggregate = (!!source && isAggregate(context, source.type, source.size)) ||
        (expression.kind === AstKind.CONSTRUCT && context.programAnalysis.isAggregateType(expression.type)) ||
        context.lowering.isU128Expr(context, expression);
    const convertToAggregate = convertScalarToAggregate && targetAggregate && !sourceAggregate;
    const copyValue = copyConstScalar && !!type && !targetAggregate;
    if (!copyValue && !convertToAggregate) {
        const emittedAddress = context.lowering.emitAddress(context, expression);
        if (emittedAddress)
            return emittedAddress;
    }
    const scratchAddress = allocateScratchSlot(context, size);
    if (type &&
        (convertToAggregate || expression.kind === AstKind.INITIALIZER_LIST || expression.kind === AstKind.CONSTRUCT)) {
        const callArguments = expression.kind === AstKind.INITIALIZER_LIST
            ? expression.expressions
            : expression.kind === AstKind.CONSTRUCT
                ? expression.callArguments
                : [expression];
        if (!context.lowering.emitConstruct(context, scratchAddress, type, callArguments)) {
            throw new Error("aggregate argument initializer could not be constructed");
        }
        return scratchAddress;
    }
    context.lines.push(`    ${emitScalarStore(scratchAddress, size, context.lowering.emitValue(context, expression))}`);
    return scratchAddress;
}
export function addressAtOffset(ptr: string, offset: number): string {
    return watIr.serializeWatNode(watIr.addressWithOffset(watIr.rawWatNode(ptr, WatNodeType.I32), offset));
}
// Sign-extend narrow signed loads into the i64 value model.
export function emitScalarLoad(addr: string, size: number, signed = false): string {
    return watIr.serializeWatNode(lowerScalarLoad(addr, size, signed));
}
// Return a typed scalar load for callers holding string-form addresses.
export function lowerScalarLoad(addr: string, size: number, signed = false): watIr.WatNode {
    return watIr.loadScalar(addrIr(addr), size, signed);
}
// Wrap a string-typed address (the resolveAddr/emitAddr channel) as a typed i32 node.
export function addrIr(addressText: string): watIr.WatNode {
    return watIr.rawWatNode(addressText, WatNodeType.I32, "lvalue address channel");
}
export const SIGNED_SCALARS = new Set([
    "sint8",
    "sint16",
    "sint32",
    "sint64",
    "signed char",
    "signed short",
    "signed int",
    "signed long long",
    "long long",
    "int",
    "short",
    "char",
]);
export function isSignedScalarType(type: TypeSpec | null | undefined, programAnalysis?: ProgramAnalysis): boolean {
    if (!type)
        return false;
    if (type.kind === AstKind.CONST)
        return isSignedScalarType(type.valueType, programAnalysis);
    if (programAnalysis)
        type = programAnalysis.scalarStorageType(type);
    if (type.kind === AstKind.NAME)
        return SIGNED_SCALARS.has(type.name);
    return false;
}
export function emitScalarStore(addr: string, size: number, value: string): string {
    return watIr.serializeWatNode(watIr.storeScalar(watIr.rawWatNode(addr, WatNodeType.I32), size, watIr.rawWatNode(value, WatNodeType.I64)));
}
// Narrow i64 values with C++ signed extension or unsigned masking.
export function narrowCastIr(inner: watIr.WatNode, typeName: string | undefined): watIr.WatNode {
    if (!typeName)
        return inner;
    const byteWidth = SCALAR_SIZE[typeName];
    if (byteWidth === undefined || byteWidth >= 8)
        return inner;
    if (typeName === "bit" || typeName === "bool") {
        return watIr.operation("i64.extend_i32_u", watIr.operation("i64.ne", watIr.i64Constant(0), inner));
    }
    if (typeName.startsWith("sint") || typeName.startsWith("signed")) {
        let operator = "i64.extend8_s";
        if (byteWidth === 4)
            operator = "i64.extend32_s";
        else if (byteWidth === 2)
            operator = "i64.extend16_s";
        return watIr.operation(operator, inner);
    }
    let mask = "0xff";
    if (byteWidth === 4)
        mask = "0xffffffff";
    else if (byteWidth === 2)
        mask = "0xffff";
    return watIr.operation("i64.and", inner, watIr.i64Constant(mask));
}
export function narrowCast(inner: string, typeName: string | undefined): string {
    return watIr.serializeWatNode(narrowCastIr(watIr.rawWatNode(inner, WatNodeType.I64), typeName));
}
