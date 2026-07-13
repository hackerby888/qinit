import type { Declaration } from "./declarations";
import type { Expression } from "./expressions";
import type { Span } from "./source-location";

// ---- Statements ----
export type Statement = {
    kind: "expression";
    expression: Expression;
    span: Span;
} | {
    kind: "compound";
    body: Statement[];
    span: Span;
} // { ... }
 | {
    kind: "if";
    condition: Expression;
    then: Statement;
    else_?: Statement;
    span: Span;
} | {
    kind: "for";
    initializer?: Statement;
    condition?: Expression;
    update?: Expression;
    body: Statement;
    span: Span;
} | {
    kind: "while";
    condition: Expression;
    body: Statement;
    span: Span;
} | {
    kind: "do_while";
    body: Statement;
    condition: Expression;
    span: Span;
} | {
    kind: "switch";
    condition: Expression;
    body: Statement;
    span: Span;
} | {
    kind: "case";
    value: Expression;
    span: Span;
} // case VALUE:
 | {
    kind: "default";
    span: Span;
} // default:
 | {
    kind: "break";
    span: Span;
} | {
    kind: "continue";
    span: Span;
} | {
    kind: "return";
    value?: Expression;
    span: Span;
} | {
    kind: "goto";
    label: string;
    span: Span;
} | {
    kind: "label";
    name: string;
    span: Span;
} // label:
 | {
    kind: "declaration";
    declaration: Declaration;
    span: Span;
} | {
    kind: "static_assert";
    condition: Expression;
    message?: Expression;
    span: Span;
} | {
    kind: "pragma";
    text: string;
    span: Span;
} // #pragma once, etc.
 | {
    kind: "empty";
    span: Span;
};
