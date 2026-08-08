import { AstKind } from "../../../shared/enums";
import type { Expression } from "../../../ast";

export type CallExpression = Expression & {
    kind: AstKind.CALL;
};
