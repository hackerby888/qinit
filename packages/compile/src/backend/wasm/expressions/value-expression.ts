import { SCALAR_SIZE } from "../abi/tables";
import { describeShape } from "../calls/call-shape";
import { narrowCastIr, lowerScalarLoad, isSignedScalarType } from "../memory/memory-operations";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, VariableDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { unsignedScalar } from "./conversions";
// ---- value (rvalue) codegen — produces an i64 ----
export function lowerValueExpression(context: FunctionEmissionContext, expression: Expression): watIr.WatNode {
    if (context.programAnalysis.gtestMode &&
        expression.kind === "member_access" &&
        expression.member === "constructionEpoch" &&
        expression.object.kind === "subscript" &&
        expression.object.object.kind === "identifier" &&
        expression.object.object.name === "contractDescriptions") {
        return watIr.operation("i64.extend_i32_u", watIr.functionCall("$qt_construction_epoch", watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.object.index))));
    }
    if (expression.kind === "member_access" &&
        expression.member === "ptr" &&
        expression.object.kind === "identifier" &&
        context.scratchpadLocals?.has(expression.object.name)) {
        return watIr.operation("i64.extend_i32_u", watIr.localGet(expression.object.name, "i32"));
    }
    // A uint128-valued expression used in a scalar/boolean context (a `while(z)` / `if(z)` truthiness test): materialize it and collapse
    if ((expression.kind === "call" ||
        expression.kind === "binary_op" ||
        expression.kind === "identifier" ||
        expression.kind === "member_access") &&
        context.lowering.isU128Expr(context, expression)) {
        const result = context.lowering.sourceU128Result(context, "operator bool", context.lowering.lowerUint128Expression(context, expression), []);
        return result.ty === "i64" ? result : watIr.operation("i64.extend_i32_u", result);
    }
    // `.low` / `.high` of a uint128-valued expression that is not itself an lvalue (e.g. `div(a, b).low`):
    if (expression.kind === "member_access" &&
        (expression.member === "low" || expression.member === "high") &&
        context.lowering.isU128Expr(context, expression.object)) {
        const argument = context.lowering.lowerUint128Expression(context, expression.object);
        return watIr.rawLoad("i64.load", expression.member === "high" ? 8 : 0, argument);
    }
    switch (expression.kind) {
        case "int_literal": {
            const numericValue = context.programAnalysis["sema"].evaluateConstexpr(expression) ?? 0n;
            return watIr.i64Constant(numericValue);
        }
        case "bool_literal":
            return watIr.i64Constant(expression.value ? 1 : 0);
        case "nullptr_literal":
            return watIr.i64Constant(0);
        case "char_literal":
            return watIr.i64Constant(expression.value);
        case "paren":
            return lowerValueExpression(context, expression.expression);
        case "identifier": {
            // a reference local is an address, not a scalar value — its scalar use is always via a
            if (context.localVars.has(expression.name) && !context.refLocals?.has(expression.name)) {
                return watIr.localGet(expression.name, context.localVars.get(expression.name)!.wasmType);
            }
            // a pointer local read as a value (p == NULL): the held address, zero-extended.
            if (context.refLocals?.get(expression.name)?.kind === "pointer") {
                return watIr.operation("i64.extend_i32_u", watIr.localGet(expression.name, "i32"));
            }
            const type = context.params?.get(expression.name);
            if (type && !type.isAddr)
                return watIr.localGet(type.local ?? expression.name, type.wasmType);
            // A pointer param read as a value (if (ptr), ptr == NULL) is the held address; a scalar
            if (type && type.isAddr && type.type.kind === "pointer")
                return watIr.operation("i64.extend_i32_u", watIr.localGet(type.local ?? expression.name, "i32"));
            if (type && type.isAddr && !context.programAnalysis.isAggregateType(type.type))
                return watIr.loadScalar(watIr.localGet(type.local ?? expression.name, "i32"), context.programAnalysis.sizeOfType(type.type), !unsignedScalar(type.type));
            if (expression.name === "SELF_INDEX")
                return watIr.operation("i64.extend_i32_u", watIr.functionCall("$qpi_contractIndex"));
            if (expression.name === "NULL")
                return watIr.i64Constant(0);
            if (expression.name.startsWith("__id_")) {
                const line = context.programAnalysis.memberFnLine.get(expression.name.slice(5));
                if (line !== undefined)
                    return watIr.i64Constant((context.programAnalysis.slot << 22) | (line & 0x3fffff));
            }
            // inside a compiled container method: a template non-type param (L), a static constexpr member (_nEncodedFlags), or a bare
            if (context.thisBind?.values.has(expression.name))
                return watIr.i64Constant(context.thisBind.values.get(expression.name)!);
            if (context.staticConsts?.has(expression.name))
                return watIr.i64Constant(context.staticConsts.get(expression.name)!);
            if (context.thisLayout) {
                const tn = context.lowering.resolveExpressionAddress(context, expression);
                if (tn && tn.size <= 8)
                    return lowerScalarLoad(tn.addr, tn.size, isSignedScalarType(tn.type, context.programAnalysis));
            }
            // entry-fn `input`/`output` typed by a scalar typedef (typedef uint16 SetShareholderProposal_output): the io name is a region address, so
            if ((expression.name === "input" || expression.name === "output") && !context.localVars.has(expression.name)) {
                const io = context.lowering.resolveExpressionAddress(context, expression);
                if (io && io.size > 0 && io.size <= 8 && (!io.layout || io.layout.fields.size === 0)) {
                    return lowerScalarLoad(io.addr, io.size, isSignedScalarType(io.type, context.programAnalysis));
                }
            }
            // a named constant: enum constant or constexpr (incl. qualified Type::NAME)
            const resolvedConstant = context.programAnalysis.resolveConst(
                expression.name,
                context.thisBind ?? EMPTY_TEMPLATE_BINDINGS,
            );
            if (resolvedConstant !== null)
                return watIr.i64Constant(resolvedConstant);
            context.programAnalysis.warn(`unknown identifier '${expression.name}'`, expression.span);
            return watIr.i64Constant(0);
        }
        case "member_access": {
            const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
            if (resolvedAddress && resolvedAddress.size <= 8)
                return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.programAnalysis));
            if (resolvedAddress) {
                context.programAnalysis.warn(`aggregate value read unsupported [${describeShape(expression)}]`, expression.span.line);
                return watIr.i64Constant(0);
            }
            // a static constexpr member of the object's type (pv.maxProposals / pv.maxVotes on ProposalVoting<P,D>): not a runtime field, so
            const obj = context.lowering.resolveExpressionAddress(context, expression.object);
            let ot: TypeSpec | null = obj?.type ?? null;
            for (let index = 0; index < 8 && ot?.kind === "name"; index++)
                ot = context.programAnalysis.typedefs.get(ot.name) ?? null;
            if (ot?.kind === "template_instance") {
                const sc = context.programAnalysis.staticConstsOf(ot.name, context.programAnalysis.bindContainer(ot.name, ot.callArguments));
                if (sc.has(expression.member))
                    return watIr.i64Constant(sc.get(expression.member)!);
            }
            // the same static constexpr read through an inline-typed object (data.variableScalar carries its union/struct decl inline): fold the member's
            if (ot?.kind === "inline_struct") {
                const sm = ot.struct.members.find((member) => member.kind === "variable" &&
                    (member as VariableDecl).name === expression.member &&
                    ((member as VariableDecl).isStatic || (member as VariableDecl).isConstexpr) &&
                    (member as VariableDecl).initializer) as VariableDecl | undefined;
                if (sm?.initializer) {
                    try {
                        return watIr.i64Constant(context.programAnalysis.evalConstBig(sm.initializer, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
                    }
                    catch {
                        /* not foldable under these bindings — fall through to the warning */
                    }
                }
            }
            // qpi.invocationReward() etc. handled in call; bare member returns 0
            context.programAnalysis.warn(`unsupported member read [${describeShape(expression)}]`, expression.span.line);
            return watIr.i64Constant(0);
        }
        case "subscript": {
            const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
            if (resolvedAddress && resolvedAddress.size <= 8)
                return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.programAnalysis));
            context.programAnalysis.warn(`unsupported subscript value`, (expression as any).span?.line ?? 0);
            return watIr.i64Constant(0);
        }
        case "call": {
            const inline = context.lowering.emitInlineStructValue(context, expression);
            return inline ?? context.lowering.emitCallValueIr(context, expression);
        }
        case "template_call": {
            if (expression.callee.kind === "identifier") {
                const name = expression.callee.name;
                // C++ cast spelled as a template call. static_cast narrows to its target width; reinterpret_cast/
                if ((name === "static_cast" || name === "reinterpret_cast" || name === "const_cast") &&
                    expression.callArguments[0]) {
                    const inner = lowerValueExpression(context, expression.callArguments[0]);
                    const tgt = expression.templateArguments?.[0];
                    return name === "static_cast" && tgt?.kind === "name"
                        ? narrowCastIr(inner, tgt.name)
                        : inner;
                }
                const helper = context.lowering.emitHelperCall(context, expression as unknown as Expression & {
                    kind: "call";
                }, true);
                if (helper !== null)
                    return watIr.rawWatNode(helper, "i64", "source-compiled template helper");
            }
            if (expression.callee.kind === "member_access" &&
                expression.callee.object.kind === "identifier" &&
                expression.callee.object.name === "qpi") {
                const source = context.lowering.emitTemplateContainerCall(context, expression, true);
                if (source !== null)
                    return watIr.rawWatNode(source, "i64", "source-compiled template instance method");
            }
            context.programAnalysis.warn(`unsupported template_call '${expression.callee.kind === "identifier" ? expression.callee.name : "?"}' as value`, expression.span.line);
            return watIr.i64Constant(0);
        }
        case "binary_op":
            return context.lowering.lowerBinaryExpression(context, expression);
        case "unary_op": {
            // *ptr as a value: load the pointee through the pointer's held address.
            if (expression.operator === "*") {
                const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
                if (resolvedAddress && resolvedAddress.size <= 8) {
                    return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.programAnalysis));
                }
            }
            const valueNode = lowerValueExpression(context, expression.argument);
            // A 32-bit result wraps at 32 bits, so - and ~ reduce back to the canonical form: mask
            const info = context.lowering.scalarTypeInfo(context, expression);
            const mask32 = info !== null && info.width === 4 && info.unsigned;
            const sext32 = info !== null && info.width === 4 && !info.unsigned;
            const canon32 = (count: watIr.WatNode) => mask32
                ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff"))
                : sext32
                    ? watIr.operation("i64.extend32_s", count)
                    : count;
            switch (expression.operator) {
                case "-": {
                    return canon32(watIr.operation("i64.sub", watIr.i64Constant(0), valueNode));
                }
                case "~": {
                    return canon32(watIr.operation("i64.xor", valueNode, watIr.i64Constant(-1)));
                }
                case "!":
                    return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", valueNode));
                default:
                    return valueNode;
            }
        }
        case "prefix_op": {
            // ++x / --x as a value: apply in place (as a side-effect line), then yield the new value.
            const emittedText = context.lowering.emitIncrementOrDecrement(context, expression);
            if (emittedText)
                context.lines.push(`    ${emittedText}`);
            return lowerValueExpression(context, expression.argument);
        }
        case "postfix_op": {
            // x++ / x-- as a value: capture the old value, then apply — the expression evaluates to the old.
            const oldValueLocal = context.lowering.newValueTmp(context);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.localSet(oldValueLocal, lowerValueExpression(context, expression.argument)))}`);
            const stepExpression = context.lowering.emitIncrementOrDecrement(context, expression);
            if (stepExpression)
                context.lines.push(`    ${stepExpression}`);
            return watIr.localGet(oldValueLocal, "i64");
        }
        case "ternary": {
            // C++ evaluates the condition, then exactly ONE arm. wasm select is eager, so it is only safe
            const cv = context.lowering.usualConversion(context, expression.then, expression.else_);
            const cvName = cv.width < 8 ? (cv.unsigned ? "uint32" : "sint32") : undefined;
            const condition = lowerValueExpression(context, expression.condition);
            const saved = context.lines;
            context.lines = [];
            const thenV = lowerValueExpression(context, expression.then);
            const thenLines = context.lines;
            context.lines = [];
            const elseV = lowerValueExpression(context, expression.else_);
            const elseLines = context.lines;
            context.lines = saved;
            if (thenLines.length === 0 &&
                elseLines.length === 0 &&
                watIr.isPureWatNode(thenV) &&
                watIr.isPureWatNode(elseV)) {
                return narrowCastIr(watIr.selectValue(thenV, elseV, watIr.operation("i64.ne", watIr.i64Constant(0), condition)), cvName);
            }
            const branchResultLocal = context.lowering.newValueTmp(context);
            const thenB = [...thenLines, `      ${context.lowering.setLocal(context, branchResultLocal, thenV)}`].join("\n");
            const elseB = [...elseLines, `      ${context.lowering.setLocal(context, branchResultLocal, elseV)}`].join("\n");
            context.lines.push(`    (if (i64.ne (i64.const 0) ${watIr.serializeWatNode(condition)}) (then\n${thenB}\n    ) (else\n${elseB}\n    ))`);
            return narrowCastIr(watIr.localGet(branchResultLocal, "i64"), cvName);
        }
        case "c_cast":
        case "static_cast":
            return narrowCastIr(lowerValueExpression(context, expression.expression), expression.type?.kind === "name" ? expression.type.name : undefined);
        case "construct": {
            const storageType = context.programAnalysis.scalarStorageType(expression.type);
            if (storageType.kind === "name" && SCALAR_SIZE[storageType.name] !== undefined && SCALAR_SIZE[storageType.name] <= 8) {
                return narrowCastIr(expression.callArguments[0] ? lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0), storageType.name);
            }
            context.programAnalysis.warn(`aggregate construction used as a scalar value`, expression.span);
            return watIr.i64Constant(0);
        }
        case "initializer_list":
            return expression.expressions.length === 1 ? lowerValueExpression(context, expression.expressions[0]) : watIr.i64Constant(0);
        case "sizeof_type":
            return watIr.i64Constant(context.programAnalysis.sizeOfType(expression.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
        case "sizeof_expr": {
            // sizeof someLvalue — e.g. sizeof(*this) (the container).
            const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression.expression);
            if (resolvedAddress)
                return watIr.i64Constant(resolvedAddress.size);
            const scalar = context.lowering.scalarTypeInfo(context, expression.expression);
            if (scalar)
                return watIr.i64Constant(scalar.width);
            // sizeof(TypeName) parses here when the operand is a bare type (e.g. sizeof(Element)) rather than
            if (expression.expression.kind === "identifier") {
                const byteSize = context.programAnalysis.sizeOfType({ kind: "name", name: expression.expression.name }, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
                if (byteSize > 0)
                    return watIr.i64Constant(byteSize);
            }
            context.programAnalysis.warn(`unsupported sizeof expr`, expression.span.line);
            return watIr.i64Constant(0);
        }
        case "assign": {
            // assignment used as a value — `while ((i = next()) >= 0)`, `a = b = 0`. Perform
            context.lowering.emitAssignment(context, expression);
            return lowerValueExpression(context, expression.left);
        }
        default:
            context.programAnalysis.warn(`unsupported expression '${expression.kind}' as value`, (expression as any).span?.line ?? 0);
            return watIr.i64Constant(0);
    }
}
export function emitValue(context: FunctionEmissionContext, expression: Expression): string {
    return watIr.serializeWatNode(lowerValueExpression(context, expression));
}
// Address+size of an operand that is an aggregate (id/m256i/struct): a struct-field lvalue, or a materialized id producer (SELF
export function aggOperand(context: FunctionEmissionContext, expression: Expression): {
    addr: string;
    size: number;
} | null {
    const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
    if (resolvedAddress)
        return resolvedAddress.size > 8 ? { addr: resolvedAddress.addr, size: resolvedAddress.size } : null;
    const emittedAddress = context.lowering.emitAddress(context, expression);
    return emittedAddress ? { addr: emittedAddress, size: 32 } : null;
}
