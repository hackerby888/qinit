import type { Span } from "./source-location";
import type { TypeSpec } from "./types";

// ---- Expressions ----
export type Expression = 
// Literals
{
    kind: "int_literal";
    value: string;
    suffix?: string;
    span: Span;
} // 42, 0xFF, 0b1010, 1000000ull
 | {
    kind: "float_literal";
    value: string;
    span: Span;
} // (present in qpi.h constexpr only)
 | {
    kind: "bool_literal";
    value: boolean;
    span: Span;
} // true, false
 | {
    kind: "nullptr_literal";
    span: Span;
} // (present but rarely used)
 | {
    kind: "string_literal";
    value: string;
    span: Span;
} // static_assert messages only
 | {
    kind: "char_literal";
    value: number;
    span: Span;
} // 'a' → 97
// Names
 | {
    kind: "identifier";
    name: string;
    span: Span;
} | {
    kind: "qualified_name";
    namespace: string;
    name: string;
    span: Span;
} // QPI::foo, NAMESPACE::Type
// Unary
 | {
    kind: "unary_op";
    operator: UnaryOp;
    argument: Expression;
    span: Span;
} | {
    kind: "prefix_op";
    operator: "++" | "--";
    argument: Expression;
    span: Span;
} | {
    kind: "postfix_op";
    operator: "++" | "--";
    argument: Expression;
    span: Span;
}
// Binary
 | {
    kind: "binary_op";
    operator: BinaryOp;
    left: Expression;
    right: Expression;
    span: Span;
}
// Ternary
 | {
    kind: "ternary";
    condition: Expression;
    then: Expression;
    else_: Expression;
    span: Span;
}
// Member access
 | {
    kind: "member_access";
    object: Expression;
    member: string;
    arrow: boolean;
    span: Span;
} // obj.member / ptr->member
 | {
    kind: "subscript";
    object: Expression;
    index: Expression;
    span: Span;
} // obj[index] (internal)
 | {
    kind: "sequence";
    expressions: Expression[];
    span: Span;
} // a, b (comma operator)
// Function call
 | {
    kind: "call";
    callee: Expression;
    callArguments: Expression[];
    span: Span;
} | {
    kind: "template_call";
    callee: Expression;
    templateArguments: TypeSpec[];
    callArguments: Expression[];
    span: Span;
} // fn<T>(args)
// Casts
 | {
    kind: "c_cast";
    type: TypeSpec;
    expression: Expression;
    span: Span;
} // (type)expr
 | {
    kind: "static_cast";
    type: TypeSpec;
    expression: Expression;
    span: Span;
} | {
    kind: "reinterpret_cast";
    type: TypeSpec;
    expression: Expression;
    span: Span;
}
// sizeof
 | {
    kind: "sizeof_type";
    type: TypeSpec;
    span: Span;
} // sizeof(T)
 | {
    kind: "sizeof_expr";
    expression: Expression;
    span: Span;
} // sizeof expr
// Assignment (expression-level)
 | {
    kind: "assign";
    operator: AssignOp;
    left: Expression;
    right: Expression;
    span: Span;
}
// Constructor call
 | {
    kind: "construct";
    type: TypeSpec;
    callArguments: Expression[];
    span: Span;
} // Type{args}
 | {
    kind: "initializer_list";
    expressions: Expression[];
    span: Span;
} // {a, b, c}
// This
 | {
    kind: "this";
    span: Span;
}
// Parens
 | {
    kind: "paren";
    expression: Expression;
    span: Span;
};

export type UnaryOp = "!" | "~" | "-" | "+" | "*" | "&";

export type BinaryOp = "+" | "-" | "*" | "/" | "%" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "&&" | "||" | "<<" | ">>" | "&" | "|" | "^" | "="; // assignment inside binary_op (legacy)


export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "|=" | "^=";
