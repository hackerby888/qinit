import { AstKind } from "../enums";
import type { Declaration } from "./declarations";
import type { Expression } from "./expressions";
import type { Span } from "./source-location";

// ---- Statements ----
export type Statement = {
    kind: AstKind.EXPRESSION;
    expression: Expression;
    span: Span;
} | {
    kind: AstKind.COMPOUND;
    body: Statement[];
    span: Span;
} // { ... }
 | {
    kind: AstKind.IF;
    condition: Expression;
    then: Statement;
    else_?: Statement;
    span: Span;
} | {
    kind: AstKind.FOR;
    initializer?: Statement;
    condition?: Expression;
    update?: Expression;
    body: Statement;
    span: Span;
} | {
    kind: AstKind.WHILE;
    condition: Expression;
    body: Statement;
    span: Span;
} | {
    kind: AstKind.DO_WHILE;
    body: Statement;
    condition: Expression;
    span: Span;
} | {
    kind: AstKind.SWITCH;
    condition: Expression;
    body: Statement;
    span: Span;
} | {
    kind: AstKind.CASE;
    value: Expression;
    span: Span;
} // case VALUE:
 | {
    kind: AstKind.DEFAULT;
    span: Span;
} // default:
 | {
    kind: AstKind.BREAK;
    span: Span;
} | {
    kind: AstKind.CONTINUE;
    span: Span;
} | {
    kind: AstKind.RETURN;
    value?: Expression;
    span: Span;
} | {
    kind: AstKind.GOTO;
    label: string;
    span: Span;
} | {
    kind: AstKind.LABEL;
    name: string;
    span: Span;
} // label:
 | {
    kind: AstKind.DECLARATION;
    declaration: Declaration;
    span: Span;
} | {
    kind: AstKind.STATIC_ASSERT;
    condition: Expression;
    message?: Expression;
    span: Span;
} | {
    kind: AstKind.PRAGMA;
    text: string;
    span: Span;
} // #pragma once, etc.
 | {
    kind: AstKind.EMPTY;
    span: Span;
};
