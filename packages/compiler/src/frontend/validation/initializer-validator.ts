import { AstKind } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type { Expression, TypeSpec, Span } from "../../ast";
import { unwrapType, evalIntegralConst } from "./validation-helpers";
import type { Validator } from "./validator";

export function checkInitializerCardinality(
    validator: Validator,
    type: TypeSpec,
    initializer: Expression,
    span: Span,
): void {
    const callArguments =
        initializer.kind === AstKind.INITIALIZER_LIST
            ? initializer.expressions
            : initializer.kind === AstKind.CONSTRUCT
              ? initializer.callArguments
              : null;
    if (!callArguments) return;
    const unwrappedType = unwrapType(type);
    if (unwrappedType.kind === AstKind.ARRAY) {
        const size = evalIntegralConst(
            unwrappedType.size,
            (name) => validator.constants.get(name) ?? null,
        );
        if (size !== null && size > 0n && BigInt(callArguments.length) > size) {
            validator.error(`too many initializers for array bound ${size}`, span);
        }
        for (const argument of callArguments)
            validator.checkInitializerCardinality(unwrappedType.element, argument, argument.span);
        return;
    }
    if (type.kind === AstKind.NAME) {
        const fields = validator.aggregateFieldCount.get(type.name);
        if (fields !== undefined && callArguments.length > fields) {
            validator.error(
                `too many initializers for aggregate '${type.name}' (${fields} fields)`,
                span,
            );
        }
    }
}
