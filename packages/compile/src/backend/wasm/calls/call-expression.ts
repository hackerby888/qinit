import type { Expression } from "../../../ast";

export type CallExpression = Expression & {
    kind: "call";
};
