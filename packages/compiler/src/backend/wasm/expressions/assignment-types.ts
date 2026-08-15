import { AstKind } from "../../../shared/enums";
import type { Expression } from "../../../ast";

export type AssignmentExpression = Expression & {
    kind: AstKind.ASSIGN;
};

export type AssignmentTarget = NonNullable<ReturnType<typeof import("../memory/address-resolution").resolveExpressionAddress>>;
