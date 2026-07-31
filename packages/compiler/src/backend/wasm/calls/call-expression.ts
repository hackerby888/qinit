import { AstKind } from "../../../enums";
import type { Expression } from "../../../ast";

export type CallExpression = Expression & {
    kind: AstKind.CALL;
};
