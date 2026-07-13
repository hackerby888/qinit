// Unified AST for the QPI C++ subset — covers user contract code AND qpi.h template bodies.

// ---- Source location ----

export interface Span {
  start: number; // UTF-16 code-unit offset in the associated source
  end: number; // exclusive UTF-16 code-unit offset in the associated source
  line: number; // 1-based
  column: number; // 1-based column at start
}

// ---- Types ----

export type TypeSpec =
  | { kind: "name"; name: string; span?: Span } // uint64, id, m256i, sint32, etc.
  | { kind: "template_instance"; name: string; callArguments: TypeSpec[]; span?: Span } // HashMap<id, uint64, 1024>
  | { kind: "const"; valueType: TypeSpec; span?: Span } // const T
  | { kind: "pointer"; pointee: TypeSpec; span?: Span } // T* (internal use only)
  | { kind: "reference"; referentType: TypeSpec; span?: Span } // T& (function params)
  | { kind: "array"; element: TypeSpec; size: Expression; span?: Span } // T name[N] — C array member
  | { kind: "inline_struct"; struct: StructDecl; span?: Span } // struct {...} name; — anonymous/tag struct as a field type
  | { kind: "expr_value"; expression: Expression; span?: Span } // non-type template arg, e.g. HashMap<id,uint64, 64*1024>
  | { kind: "dependent_member"; base: TypeSpec; member: string; span?: Span } // typename Sel<v>::type — nested type of a template instance
  | { kind: "void"; span?: Span };

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
  kind: "typedef";
  name: string;
  type: TypeSpec;
  span: Span;
}

// ---- Template parameters ----

export type TemplateParam =
  | { kind: "type"; name: string; default?: TypeSpec; span?: Span } // typename T
  | { kind: "non_type"; name: string; type: TypeSpec; span?: Span } // uint64 L
  | { kind: "non_type_default"; name: string; type: TypeSpec; default: Expression; span?: Span }; // uint64 L = 1024

// ---- Expressions ----

export type Expression =
  // Literals
  | { kind: "int_literal"; value: string; suffix?: string; span: Span } // 42, 0xFF, 0b1010, 1000000ull
  | { kind: "float_literal"; value: string; span: Span } // (present in qpi.h constexpr only)
  | { kind: "bool_literal"; value: boolean; span: Span } // true, false
  | { kind: "nullptr_literal"; span: Span } // (present but rarely used)
  | { kind: "string_literal"; value: string; span: Span } // static_assert messages only
  | { kind: "char_literal"; value: number; span: Span } // 'a' → 97
  // Names
  | { kind: "identifier"; name: string; span: Span }
  | { kind: "qualified_name"; namespace: string; name: string; span: Span } // QPI::foo, NAMESPACE::Type
  // Unary
  | { kind: "unary_op"; operator: UnaryOp; argument: Expression; span: Span }
  | { kind: "prefix_op"; operator: "++" | "--"; argument: Expression; span: Span }
  | { kind: "postfix_op"; operator: "++" | "--"; argument: Expression; span: Span }
  // Binary
  | { kind: "binary_op"; operator: BinaryOp; left: Expression; right: Expression; span: Span }
  // Ternary
  | { kind: "ternary"; condition: Expression; then: Expression; else_: Expression; span: Span }
  // Member access
  | { kind: "member_access"; object: Expression; member: string; arrow: boolean; span: Span } // obj.member / ptr->member
  | { kind: "subscript"; object: Expression; index: Expression; span: Span } // obj[index] (internal)
  | { kind: "sequence"; expressions: Expression[]; span: Span } // a, b (comma operator)
  // Function call
  | { kind: "call"; callee: Expression; callArguments: Expression[]; span: Span }
  | {
      kind: "template_call";
      callee: Expression;
      templateArguments: TypeSpec[];
      callArguments: Expression[];
      span: Span;
    } // fn<T>(args)
  // Casts
  | { kind: "c_cast"; type: TypeSpec; expression: Expression; span: Span } // (type)expr
  | { kind: "static_cast"; type: TypeSpec; expression: Expression; span: Span }
  | { kind: "reinterpret_cast"; type: TypeSpec; expression: Expression; span: Span }
  // sizeof
  | { kind: "sizeof_type"; type: TypeSpec; span: Span } // sizeof(T)
  | { kind: "sizeof_expr"; expression: Expression; span: Span } // sizeof expr
  // Assignment (expression-level)
  | { kind: "assign"; operator: AssignOp; left: Expression; right: Expression; span: Span }
  // Constructor call
  | { kind: "construct"; type: TypeSpec; callArguments: Expression[]; span: Span } // Type{args}
  | { kind: "initializer_list"; expressions: Expression[]; span: Span } // {a, b, c}
  // This
  | { kind: "this"; span: Span }
  // Parens
  | { kind: "paren"; expression: Expression; span: Span };

export type UnaryOp = "!" | "~" | "-" | "+" | "*" | "&";
export type BinaryOp =
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "=="
  | "!="
  | "<"
  | ">"
  | "<="
  | ">="
  | "&&"
  | "||"
  | "<<"
  | ">>"
  | "&"
  | "|"
  | "^"
  | "="; // assignment inside binary_op (legacy)
export type AssignOp = "=" | "+=" | "-=" | "*=" | "/=" | "%=" | "<<=" | ">>=" | "&=" | "|=" | "^=";

// ---- Statements ----

export type Statement =
  | { kind: "expression"; expression: Expression; span: Span }
  | { kind: "compound"; body: Statement[]; span: Span } // { ... }
  | { kind: "if"; condition: Expression; then: Statement; else_?: Statement; span: Span }
  | {
      kind: "for";
      initializer?: Statement;
      condition?: Expression;
      update?: Expression;
      body: Statement;
      span: Span;
    }
  | { kind: "while"; condition: Expression; body: Statement; span: Span }
  | { kind: "do_while"; body: Statement; condition: Expression; span: Span }
  | { kind: "switch"; condition: Expression; body: Statement; span: Span }
  | { kind: "case"; value: Expression; span: Span } // case VALUE:
  | { kind: "default"; span: Span } // default:
  | { kind: "break"; span: Span }
  | { kind: "continue"; span: Span }
  | { kind: "return"; value?: Expression; span: Span }
  | { kind: "goto"; label: string; span: Span }
  | { kind: "label"; name: string; span: Span } // label:
  | { kind: "declaration"; declaration: Declaration; span: Span }
  | { kind: "static_assert"; condition: Expression; message?: Expression; span: Span }
  | { kind: "pragma"; text: string; span: Span } // #pragma once, etc.
  | { kind: "empty"; span: Span };

// ---- Declarations (top-level and member) ----

export type Declaration =
  // Struct/class
  | StructDecl
  | ClassTemplateDecl
  | FunctionTemplateDecl
  // Functions
  | FunctionDecl
  // Variables
  | VariableDecl
  // Enums
  | EnumDecl
  // Typedef/using
  | TypedefDeclNode
  // Namespace
  | NamespaceDecl
  // Static assert (top-level)
  | StaticAssertDecl
  // Extern block
  | ExternBlockDecl
  // Friend
  | FriendDecl
  // Empty (from macros resolving to nothing)
  | EmptyDecl;

export interface StructDecl {
  kind: "struct";
  name: string;
  bases: TypeSpec[]; // : public ContractBase, ...
  members: Declaration[];
  isUnion?: boolean;
  specializationArgs?: TypeSpec[]; // `struct Foo<ProposalDataYesNo, numOfVotes>` — partial/explicit specialization args
  span: Span;
}

export interface ClassTemplateDecl {
  kind: "class_template";
  name: string;
  params: TemplateParam[];
  members: Declaration[];
  bases: TypeSpec[];
  specializationArgs?: TypeSpec[]; // present when this is a (partial) specialization, e.g. `<ProposalDataYesNo, numOfVotes>`
  span: Span;
}

export interface FunctionTemplateDecl {
  kind: "function_template";
  name: string;
  params: TemplateParam[]; // template parameters (KeyT, ValueT, L, ...)
  functionParameters?: ParamDecl[]; // the function's own parameters (key, value, ...)
  returnType: TypeSpec;
  body?: Statement;
  isConstexpr: boolean;
  span: Span;
}

export interface FunctionDecl {
  kind: "function";
  name: string;
  returnType: TypeSpec;
  params: ParamDecl[];
  body?: Statement;
  isConstexpr: boolean;
  isStatic: boolean;
  isInline: boolean;
  isExternC: boolean;
  isVirtual: boolean;
  isOverride: boolean;
  isDeleted: boolean;
  isDefault: boolean;
  storageClass?: "static" | "inline" | "extern";
  span: Span;
}

export interface ParamDecl {
  name: string;
  type: TypeSpec;
  defaultValue?: Expression;
  span: Span;
}

export interface VariableDecl {
  kind: "variable";
  name: string;
  type: TypeSpec;
  initializer?: Expression;
  isConstexpr: boolean;
  isStatic: boolean;
  isExtern: boolean;
  isMember: boolean;
  access: AccessSpec;
  span: Span;
}

export interface EnumDecl {
  kind: "enum";
  name?: string; // anonymous enums have no name
  underlyingType?: TypeSpec; // enum class Foo : uint8
  isClass: boolean; // enum class vs plain enum
  members: EnumeratorDecl[];
  span: Span;
}

export interface EnumeratorDecl {
  name: string;
  value?: Expression;
  span: Span;
}

export interface TypedefDeclNode {
  kind: "typedef_decl";
  name: string;
  type: TypeSpec;
  span: Span;
}

export interface NamespaceDecl {
  kind: "namespace";
  name: string;
  body: Declaration[];
  span: Span;
}

export interface StaticAssertDecl {
  kind: "static_assert_decl";
  condition: Expression;
  message?: Expression;
  span: Span;
}

export interface ExternBlockDecl {
  kind: "extern_block";
  linkage: string; // "C"
  body: Declaration[];
  span: Span;
}

export interface FriendDecl {
  kind: "friend";
  declaration: FunctionDecl | StructDecl | ClassTemplateDecl;
  span: Span;
}

export interface EmptyDecl {
  kind: "empty";
  span?: Span;
}

export type AccessSpec = "public" | "protected" | "private";

// ---- Translation unit ----

export interface TranslationUnit {
  declarations: Declaration[];
  span: Span;
}

// ---- Helper constructors (for codegen tests and WAT emission) ----

export function nameType(name: string): TypeSpec {
  return { kind: "name", name };
}

export function templateInstance(name: string, callArguments: TypeSpec[]): TypeSpec {
  return { kind: "template_instance", name, callArguments };
}

export function id(name: string, span?: Span): Expression {
  return { kind: "identifier", name, span: span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function member(obj: Expression, memberName: string, arrow?: boolean): Expression {
  return { kind: "member_access", object: obj, member: memberName, arrow: !!arrow, span: obj.span };
}

export function call(callee: Expression, callArguments: Expression[]): Expression {
  return { kind: "call", callee, callArguments, span: callee.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}

export function intLit(value: string, suffix?: string): Expression {
  return { kind: "int_literal", value, suffix, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function binary(left: Expression, operator: BinaryOp, right: Expression): Expression {
  return { kind: "binary_op", operator, left, right, span: left.span };
}

export function retStmt(value?: Expression): Statement {
  return { kind: "return", value, span: { start: 0, end: 0, line: 0, column: 0 } };
}

export function exprStmt(expression: Expression): Statement {
  return { kind: "expression", expression, span: expression.span };
}

export function declStmt(declaration: Declaration): Statement {
  return { kind: "declaration", declaration, span: declaration.span ?? { start: 0, end: 0, line: 0, column: 0 } };
}
