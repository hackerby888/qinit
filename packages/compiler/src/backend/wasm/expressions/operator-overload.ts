import { AstKind, BinaryOp, WatNodeType } from "../../../shared/enums";
import type { Expression, TypeSpec } from "../../../ast";
import * as watIr from "../wat-ir";
import type { FunctionEmissionContext } from "../types";

// C++ resolves every operator through overload resolution, so the lowering asks the type what it
// declared rather than assuming a representation. Only member candidates are considered: qpi's
// free-function operators belong to m256i, whose bodies are x86 intrinsics the caller substitutes.

// Walk typedefs and template bindings to the type a member lookup can use — `id` to `m256i`, and a
// container's `KeyT` to whatever the instantiation bound it to.
export function concreteType(context: FunctionEmissionContext, type: TypeSpec | null | undefined): TypeSpec | null {
    let resolved: TypeSpec | null = type ?? null;

    for (let depth = 0; depth < 8 && resolved?.kind === AstKind.NAME; depth++) {
        const next: TypeSpec | undefined = context.thisBind?.types.get(resolved.name) ?? context.programAnalysis.typedefs.get(resolved.name);

        if (!next) {
            break;
        }

        resolved = next;
    }

    return resolved;
}

// Arithmetic keeps the class of its operands; a comparison or a logical operator yields `bool`
// whatever its operands were, so those do not carry a class through.
const VALUE_PRESERVING_OPERATORS: ReadonlySet<string> = new Set([
    BinaryOp.ADD,
    BinaryOp.SUBTRACT,
    BinaryOp.MULTIPLY,
    BinaryOp.DIVIDE,
    BinaryOp.MODULO,
    BinaryOp.BITWISE_AND,
    BinaryOp.BITWISE_OR,
    BinaryOp.BITWISE_XOR,
    BinaryOp.SHIFT_LEFT,
    BinaryOp.SHIFT_RIGHT,
]);

// The class an operand belongs to, or null when it is a scalar or an unresolved type. The rvalue
// shapes are read from the syntax rather than through the address resolver, which would emit a call
// operand before an overload has claimed it.
export function classOperandName(context: FunctionEmissionContext, expression: Expression, depth = 0): string | null {
    if (depth < 8) {
        if (expression.kind === AstKind.PAREN) {
            return classOperandName(context, expression.expression, depth + 1);
        }

        if (expression.kind === AstKind.C_CAST || expression.kind === AstKind.STATIC_CAST) {
            const cast = concreteType(context, expression.type);
            if (cast?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(cast)) return cast.name;
            return classOperandName(context, expression.expression, depth + 1);
        }

        if (expression.kind === AstKind.BINARY_OP && VALUE_PRESERVING_OPERATORS.has(expression.operator)) {
            return classOperandName(context, expression.left, depth + 1) ?? classOperandName(context, expression.right, depth + 1);
        }

        if (expression.kind === AstKind.TERNARY) {
            return classOperandName(context, expression.then, depth + 1) ?? classOperandName(context, expression.else_, depth + 1);
        }

        // `Type(args)` names its class in the callee.
        if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.IDENTIFIER) {
            const constructed = concreteType(context, { kind: AstKind.NAME, name: expression.callee.name });

            if (constructed?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(constructed)) {
                return constructed.name;
            }
        }
    }

    const node = context.lowering.resolveExpressionAddress(context, expression);
    const resolved = concreteType(context, node?.type);

    if (resolved?.kind === AstKind.NAME && context.programAnalysis.isAggregateType(resolved)) {
        return resolved.name;
    }

    return resolved?.kind === AstKind.TEMPLATE_INSTANCE ? resolved.name : null;
}

// Methods are indexed under both the qualified and the unqualified name depending on where the type
// was declared, so a lookup has to try both — QPI::DateAndTime declares its operators as DateAndTime.
export function operatorOwner(context: FunctionEmissionContext, className: string, operatorName: string, arity: number): string | null {
    const separator = className.lastIndexOf("::");
    const candidates = separator >= 0 ? [className, className.slice(separator + 2)] : [className];

    for (const candidate of candidates) {
        const methods = context.programAnalysis.templateMethods.get(candidate);

        if (methods && (methods.has(`${operatorName}/${arity}`) || methods.has(operatorName))) {
            return candidate;
        }
    }

    return null;
}

// Emit a call to the operator body the class declared. Mirrors sourceU128Result, which is the same
// call for one hardcoded type.
function callOperator(
    context: FunctionEmissionContext,
    className: string,
    operatorName: string,
    self: Expression,
    operands: Expression[],
): {
    node: watIr.WatNode | null;
    aggregate: boolean;
} | null {
    const selfAddress = context.lowering.emitAddress(context, self);

    if (!selfAddress) {
        return null;
    }

    const owner: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    } = {
        kind: AstKind.TEMPLATE_INSTANCE,
        name: className,
        callArguments: [],
    };
    const compiled = context.lowering.callCompiled(context, owner, operatorName, selfAddress, operands);

    if (!compiled) {
        return null;
    }

    return { node: compiledCallResult(context, compiled, `${className}::${operatorName}`), aggregate: !!compiled.retDest };
}

// The class an operator is resolved on, or null when the operand has none.
function operatorTarget(context: FunctionEmissionContext, operatorName: string, left: Expression, arity: number): string | null {
    const leftClass = classOperandName(context, left);

    return leftClass ? operatorOwner(context, leftClass, operatorName, arity) : null;
}

/**
 * The address of an overloaded operator's result, for a body that returns its own class by value.
 *
 * Returns null when no candidate applies or the result is a scalar, leaving the caller to answer that
 * the expression has no address — which is what it had before this existed.
 */
export function overloadedOperatorAddress(context: FunctionEmissionContext, operatorName: string, left: Expression, right?: Expression): string | null {
    const operands = right ? [right] : [];
    const owner = operatorTarget(context, operatorName, left, operands.length);
    const called = owner ? callOperator(context, owner, operatorName, left, operands) : null;

    return called?.aggregate && called.node ? watIr.serializeWatNode(called.node) : null;
}

/** Turn a callCompiled result into the value node its return kind implies. */
export function compiledCallResult(
    context: FunctionEmissionContext,
    compiled: {
        call: string;
        cm: {
            retKind: WatNodeType;
        };
        retDest?: string;
    },
    label: string,
): watIr.WatNode | null {
    if (compiled.retDest) {
        context.lines.push(`    ${compiled.call}`);
        return watIr.rawWatNode(compiled.retDest, WatNodeType.I32, `${label} aggregate result`);
    }

    if (compiled.cm.retKind === WatNodeType.I64) {
        return watIr.rawWatNode(compiled.call, WatNodeType.I64, `${label} scalar result`);
    }

    if (compiled.cm.retKind === WatNodeType.I32) {
        return watIr.rawWatNode(compiled.call, WatNodeType.I32, `${label} reference result`);
    }

    context.lines.push(`    ${compiled.call}`);
    return null;
}

/**
 * Lower `left <op> right` (or a unary `<op> left`) through the operator the operand's class declares.
 *
 * Callers must pass operands that are already lvalues. Asking for an operand's type goes through
 * resolveExpressionAddress, which materializes a call expression — emitting it before we know an
 * overload wants it. `!f(x)` did exactly that and left HashFunc::hash unresolvable in QUtil.
 *
 * Returns null when no candidate applies, leaving the caller to fall back or report.
 */
export function tryLowerOverloadedOperator(context: FunctionEmissionContext, operatorName: string, left: Expression, right?: Expression): watIr.WatNode | null {
    const operands = right ? [right] : [];
    const owner = operatorTarget(context, operatorName, left, operands.length);

    if (owner) {
        const called = callOperator(context, owner, operatorName, left, operands);
        const result = called?.node ?? null;

        // A comparison body returns `bit`, which this backend models as a scalar, so an i32 result is
        // a boolean that still has to widen to the i64 value channel. An aggregate result is an
        // address and stays one.
        return result && !called?.aggregate && result.ty === WatNodeType.I32 ? watIr.operation("i64.extend_i32_u", result) : result;
    }

    if (!right) {
        return null;
    }

    // C++20 rewrites `a != b` to `!(a == b)` when only operator== is declared, so a type that
    // declares equality alone still compares both ways.
    if (operatorName === "operator!=") {
        const equality = tryLowerOverloadedOperator(context, "operator==", left, right);

        if (equality) {
            return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", equality));
        }
    }

    return null;
}
