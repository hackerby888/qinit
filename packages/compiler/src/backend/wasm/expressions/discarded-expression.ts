import { AstKind, BinaryOp, CAST_TEMPLATE_NAMES, UnaryOp, UpdateOp, WatNodeType } from "../../../shared/enums";
import { addrIr, emitScalarLoad, isSignedScalarType, emitScalarStore } from "../memory/memory-operations";
import { isUint128 } from "../memory/address-resolution";
import { describeShape } from "../calls/call-shape";
import { subExpressions } from "../module/entry-context-validation";
import { FunctionEmissionContext } from "../types";
import type { TypeSpec, Expression, Statement } from "../../../ast";
import type { CallExpression } from "../calls/call-expression";
import * as watIr from "../wat-ir";

type TemplateCallExpression = Expression & { kind: AstKind.TEMPLATE_CALL };

const EFFECT_KINDS = new Set<AstKind>([AstKind.ASSIGN, AstKind.CALL, AstKind.TEMPLATE_CALL, AstKind.PREFIX_OP, AstKind.POSTFIX_OP]);

// sizeof never evaluates its operand, so nothing under it runs.
function evaluatedOperands(expression: Expression): Expression[] {
    if (expression.kind === AstKind.SIZEOF_EXPR) return [];

    return subExpressions(expression).filter((operand): operand is Expression => !!operand);
}

function hasEffect(expression: Expression): boolean {
    return EFFECT_KINDS.has(expression.kind) || evaluatedOperands(expression).some(hasEffect);
}

function pushDiscarded(context: FunctionEmissionContext, expression: Expression): void {
    const discardedText = emitDiscardedExpression(context, expression);
    if (discardedText) context.lines.push(`    ${discardedText}`);
}

// `c ? a : b;`, `a && b;` and `a || b;` run one side only, so each becomes the if it stands for.
function branchStatement(expression: Expression): Statement | null {
    const discarded = (inner: Expression): Statement => ({ kind: AstKind.EXPRESSION, expression: inner, span: inner.span });

    if (expression.kind === AstKind.TERNARY) {
        return { kind: AstKind.IF, condition: expression.condition, then: discarded(expression.then), else_: discarded(expression.else_), span: expression.span };
    }

    if (expression.kind === AstKind.BINARY_OP && expression.operator === BinaryOp.LOGICAL_AND) {
        return { kind: AstKind.IF, condition: expression.left, then: discarded(expression.right), span: expression.span };
    }

    if (expression.kind === AstKind.BINARY_OP && expression.operator === BinaryOp.LOGICAL_OR) {
        const leftIsFalse: Expression = { kind: AstKind.UNARY_OP, operator: UnaryOp.LOGICAL_NOT, argument: expression.left, span: expression.left.span };

        return { kind: AstKind.IF, condition: leftIsFalse, then: discarded(expression.right), span: expression.span };
    }

    return null;
}

// `f<T>(x);` and `object.method<T>(x);` take the handlers their value forms take, with the result dropped.
function emitTemplateCallStatement(context: FunctionEmissionContext, expression: TemplateCallExpression): void {
    if (expression.callee.kind === AstKind.IDENTIFIER && context.lowering.emitHelperCall(context, expression as unknown as CallExpression, false) !== null) {
        return;
    }

    if (context.lowering.emitTemplateContainerCall(context, expression, false) !== null) {
        return;
    }

    context.programAnalysis.warn(`unsupported template call statement [${describeShape(expression.callee)}]`, expression.span.line);
}

// Emit a statement expression; calls and assignments record their own effects.
export function emitDiscardedExpression(context: FunctionEmissionContext, expression: Expression): string {
    if (expression.kind === AstKind.ASSIGN) {
        context.lowering.emitAssignment(context, expression);
        return "";
    }
    if (expression.kind === AstKind.CALL) {
        context.lowering.emitCallStatement(context, expression);
        return "";
    }
    if (expression.kind === AstKind.POSTFIX_OP || expression.kind === AstKind.PREFIX_OP) return emitIncrementOrDecrement(context, expression);
    // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
    if (expression.kind === AstKind.SEQUENCE) {
        for (const sequenceExpression of expression.expressions) {
            pushDiscarded(context, sequenceExpression);
        }
        return "";
    }
    // a statement that changes nothing emits nothing, as in C++.
    if (!hasEffect(expression)) return "";

    const castSpelledAsTemplate = expression.kind === AstKind.TEMPLATE_CALL && expression.callee.kind === AstKind.IDENTIFIER && CAST_TEMPLATE_NAMES.has(expression.callee.name);

    if (expression.kind === AstKind.TEMPLATE_CALL && !castSpelledAsTemplate) {
        emitTemplateCallStatement(context, expression);
        return "";
    }

    const branch = branchStatement(expression);

    if (branch) {
        context.lowering.emitStatement(context, branch);
        return "";
    }

    // parens, casts and the other operators add no effect of their own: only their operands' effects are emitted.
    for (const operand of evaluatedOperands(expression)) {
        pushDiscarded(context, operand);
    }
    return "";
}
// Recognize locals and by-value scalar parameters held in Wasm slots.
export function isScalarLocal(context: FunctionEmissionContext, name: string): boolean {
    if (context.localVars.has(name)) return true;
    const type = context.params?.get(name);
    return !!type && !type.isAddr;
}
export function emitIncrementOrDecrement(context: FunctionEmissionContext, expression: Expression): string {
    const argument = expression.kind === AstKind.POSTFIX_OP || expression.kind === AstKind.PREFIX_OP ? expression.argument : expression;
    const operator = (expression as any).operator === UpdateOp.INCREMENT ? "i64.add" : "i64.sub";
    // Narrow incremented scalar locals so overflow matches C++.
    if (argument.kind === AstKind.IDENTIFIER && isScalarLocal(context, argument.name)) {
        const next = watIr.operation(operator, watIr.localGet(argument.name, WatNodeType.I64), watIr.i64Constant(1));
        return `(local.set $${argument.name} ${watIr.serializeWatNode(context.lowering.narrowLocalValue(context, argument.name, next))})`;
    }
    // Otherwise a member/element lvalue: load, adjust, store back.
    const addr = context.lowering.resolveLvalue(context, argument);
    if (addr?.readOnly) {
        context.programAnalysis.error(`cannot modify read-only '${describeShape(argument)}': ${addr.readOnly}`, expression.span);
        return "";
    }
    if (addr) {
        // uint128 increment/decrement uses the source-compiled arithmetic operator.
        if (isUint128(context.programAnalysis, addr.type ?? null)) {
            if ((expression as any).operator === UpdateOp.INCREMENT) {
                const type = {
                    kind: AstKind.TEMPLATE_INSTANCE,
                    name: "uint128_t",
                    callArguments: [],
                } as TypeSpec & {
                    kind: AstKind.TEMPLATE_INSTANCE;
                };
                const compiled = context.lowering.callCompiled(context, type, "operator++", addr.addr, []);
                if (!compiled || compiled.cm.retKind !== WatNodeType.I32) {
                    throw new Error("authoritative uint128_t::operator++ could not be lowered");
                }
                return watIr.serializeWatNode(
                    watIr.operation(
                        "drop",
                        watIr.functionCallWithSignature({ params: [WatNodeType.I32], res: WatNodeType.I32 }, compiled.cm.label, addrIr(addr.addr)),
                    ),
                );
            }
            const one: Expression = {
                kind: AstKind.INT_LITERAL,
                value: "1",
                span: (expression as any).span,
            };
            const res = context.lowering.lowerUint128Expression(context, {
                kind: AstKind.BINARY_OP,
                operator: operator === "i64.add" ? BinaryOp.ADD : BinaryOp.SUBTRACT,
                left: argument,
                right: one,
                span: (expression as any).span,
            });
            return watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(addr.addr), res, watIr.i32Constant(16)));
        }
        const load = emitScalarLoad(addr.addr, addr.size, isSignedScalarType(addr.type, context.programAnalysis));
        const stored = `(${operator} ${load} (i64.const 1))`;
        return emitScalarStore(addr.addr, addr.size, stored);
    }
    throw new Error(`cannot increment or decrement '${describeShape(argument)}': not addressable`);
}
