import type { Expression } from "../../../ast";

export type AssignmentExpression = Expression & {
    kind: "assign";
};

export type AssignmentTarget = NonNullable<
    ReturnType<typeof import("../memory/address-resolution").resolveExpressionAddress>
>;
