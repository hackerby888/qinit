import { AstKind, WatNodeType } from "../../../shared/enums";
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

// The class an operand belongs to, or null when it is a scalar or an unresolved type.
export function classOperandName(context: FunctionEmissionContext, expression: Expression): string | null {
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
): watIr.WatNode | null {
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
    const result = compiled ? compiledCallResult(context, compiled, `${className}::${operatorName}`) : null;

    // A comparison body returns `bit`, which this backend models as a scalar, so an i32 result is a
    // boolean that still has to widen to the i64 value channel.
    return result && result.ty === WatNodeType.I32 ? watIr.operation("i64.extend_i32_u", result) : result;
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
    const arity = operands.length;
    const leftClass = classOperandName(context, left);
    const owner = leftClass ? operatorOwner(context, leftClass, operatorName, arity) : null;

    if (owner) {
        return callOperator(context, owner, operatorName, left, operands);
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
