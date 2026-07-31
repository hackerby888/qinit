import {
    AssignOp,
    AstKind,
    BinaryOp,
    UnaryOp,
    UpdateOp,
} from "../enums";
import type { Span } from "./source-location";
import type { TypeSpec } from "./types";

// ---- Expressions ----
export type Expression = 
// Literals
{
    kind: AstKind.INT_LITERAL;
    value: string;
    suffix?: string;
    span: Span;
} // 42, 0xFF, 0b1010, 1000000ull
 | {
    kind: AstKind.FLOAT_LITERAL;
    value: string;
    span: Span;
} // (present in qpi.h constexpr only)
 | {
    kind: AstKind.BOOL_LITERAL;
    value: boolean;
    span: Span;
} // true, false
 | {
    kind: AstKind.NULLPTR_LITERAL;
    span: Span;
} // (present but rarely used)
 | {
    kind: AstKind.STRING_LITERAL;
    value: string;
    span: Span;
} // static_assert messages only
 | {
    kind: AstKind.CHAR_LITERAL;
    value: number;
    span: Span;
} // 'a' → 97
// Names
 | {
    kind: AstKind.IDENTIFIER;
    name: string;
    span: Span;
} | {
    kind: AstKind.QUALIFIED_NAME;
    namespace: string;
    name: string;
    span: Span;
} // QPI::foo, NAMESPACE::Type
// Unary
 | {
    kind: AstKind.UNARY_OP;
    operator: UnaryOp;
    argument: Expression;
    span: Span;
} | {
    kind: AstKind.PREFIX_OP;
    operator: UpdateOp;
    argument: Expression;
    span: Span;
} | {
    kind: AstKind.POSTFIX_OP;
    operator: UpdateOp;
    argument: Expression;
    span: Span;
}
// Binary
 | {
    kind: AstKind.BINARY_OP;
    operator: BinaryOp;
    left: Expression;
    right: Expression;
    span: Span;
}
// Ternary
 | {
    kind: AstKind.TERNARY;
    condition: Expression;
    then: Expression;
    else_: Expression;
    span: Span;
}
// Member access
 | {
    kind: AstKind.MEMBER_ACCESS;
    object: Expression;
    member: string;
    arrow: boolean;
    span: Span;
} // obj.member / ptr->member
 | {
    kind: AstKind.SUBSCRIPT;
    object: Expression;
    index: Expression;
    span: Span;
} // obj[index] (internal)
 | {
    kind: AstKind.SEQUENCE;
    expressions: Expression[];
    span: Span;
} // a, b (comma operator)
// Function call
 | {
    kind: AstKind.CALL;
    callee: Expression;
    callArguments: Expression[];
    span: Span;
} | {
    kind: AstKind.TEMPLATE_CALL;
    callee: Expression;
    templateArguments: TypeSpec[];
    callArguments: Expression[];
    span: Span;
} // fn<T>(args)
// Casts
 | {
    kind: AstKind.C_CAST;
    type: TypeSpec;
    expression: Expression;
    span: Span;
} // (type)expr
 | {
    kind: AstKind.STATIC_CAST;
    type: TypeSpec;
    expression: Expression;
    span: Span;
} | {
    kind: AstKind.REINTERPRET_CAST;
    type: TypeSpec;
    expression: Expression;
    span: Span;
}
// sizeof
 | {
    kind: AstKind.SIZEOF_TYPE;
    type: TypeSpec;
    span: Span;
} // sizeof(T)
 | {
    kind: AstKind.SIZEOF_EXPR;
    expression: Expression;
    span: Span;
} // sizeof expr
// Assignment (expression-level)
 | {
    kind: AstKind.ASSIGN;
    operator: AssignOp;
    left: Expression;
    right: Expression;
    span: Span;
}
// Constructor call
 | {
    kind: AstKind.CONSTRUCT;
    type: TypeSpec;
    callArguments: Expression[];
    span: Span;
} // Type{args}
 | {
    kind: AstKind.INITIALIZER_LIST;
    expressions: Expression[];
    span: Span;
} // {a, b, c}
// This
 | {
    kind: AstKind.THIS;
    span: Span;
}
// Parens
 | {
    kind: AstKind.PAREN;
    expression: Expression;
    span: Span;
};

export {
    AssignOp,
    BinaryOp,
    UnaryOp,
    UpdateOp,
};
