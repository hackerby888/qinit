import { AstKind } from "../enums";
import type { StructDecl } from "./declarations";
import type { Expression } from "./expressions";
import type { Span } from "./source-location";

// ---- Types ----
export type TypeSpec = {
    kind: AstKind.NAME;
    name: string;
    span?: Span;
} // uint64, id, m256i, sint32, etc.
 | {
    kind: AstKind.TEMPLATE_INSTANCE;
    name: string;
    callArguments: TypeSpec[];
    span?: Span;
} // HashMap<id, uint64, 1024>
 | {
    kind: AstKind.CONST;
    valueType: TypeSpec;
    span?: Span;
} // const T
 | {
    kind: AstKind.POINTER;
    pointee: TypeSpec;
    span?: Span;
} // T* (internal use only)
 | {
    kind: AstKind.REFERENCE;
    referentType: TypeSpec;
    span?: Span;
} // T& (function params)
 | {
    kind: AstKind.ARRAY;
    element: TypeSpec;
    size: Expression;
    span?: Span;
} // T name[N] — C array member
 | {
    kind: AstKind.INLINE_STRUCT;
    struct: StructDecl;
    span?: Span;
} // struct {...} name; — anonymous/tag struct as a field type
 | {
    kind: AstKind.EXPR_VALUE;
    expression: Expression;
    span?: Span;
} // non-type template arg, e.g. HashMap<id,uint64, 64*1024>
 | {
    kind: AstKind.DEPENDENT_MEMBER;
    base: TypeSpec;
    member: string;
    span?: Span;
} // typename Sel<v>::type — nested type of a template instance
 | {
    kind: AstKind.VOID;
    span?: Span;
};

// Named types known to the compiler
export const BUILTIN_TYPES = new Set([
    "void",
    "bool",
    "bit",
    "sint8",
    "sint16",
    "sint32",
    "sint64",
    "uint8",
    "uint16",
    "uint32",
    "uint64",
    "uint128",
    "id",
    "m256i",
    "signed char",
    "unsigned char",
    "signed short",
    "unsigned short",
    "signed int",
    "unsigned int",
    "signed long long",
    "unsigned long long",
    "size_t",
    "unsigned long",
]);

// Type alias from typedef: "typedef X Y;"
export interface TypedefDecl {
    kind: AstKind.TYPEDEF;
    name: string;
    type: TypeSpec;
    span: Span;
}

// ---- Template parameters ----
export type TemplateParam = {
    kind: AstKind.TYPE;
    name: string;
    default?: TypeSpec;
    span?: Span;
} // typename T
 | {
    kind: AstKind.NON_TYPE;
    name: string;
    type: TypeSpec;
    span?: Span;
} // uint64 L
 | {
    kind: AstKind.NON_TYPE_DEFAULT;
    name: string;
    type: TypeSpec;
    default: Expression;
    span?: Span;
}; // uint64 L = 1024
