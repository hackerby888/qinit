// Validation runs after parse and before codegen.
import type { Expression, TypeSpec, Span } from "../../ast";
import { unwrapType, evalIntegralConst } from "./validation-helpers";
import type { ValidatorInternals } from "./validator-context";

export function checkInitializerCardinality(context: ValidatorInternals, type: TypeSpec, initializer: Expression, span: Span): void {
    const callArguments = initializer.kind === "initializer_list" ? initializer.expressions : initializer.kind === "construct" ? initializer.callArguments : null;
    if (!callArguments)
        return;
    const unwrappedType = unwrapType(type);
    if (unwrappedType.kind === "array") {
        const size = evalIntegralConst(unwrappedType.size, (name) => context.constants.get(name) ?? null);
        if (size !== null && size > 0n && BigInt(callArguments.length) > size) {
            context.error(`too many initializers for array bound ${size}`, span);
        }
        for (const argument of callArguments)
            context.checkInitializerCardinality(unwrappedType.element, argument, argument.span);
        return;
    }
    if (type.kind === "name") {
        const fields = context.aggregateFieldCount.get(type.name);
        if (fields !== undefined && callArguments.length > fields) {
            context.error(`too many initializers for aggregate '${type.name}' (${fields} fields)`, span);
        }
    }
}
