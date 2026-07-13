import type { Expression } from "./expressions";
import type { Span } from "./source-location";
import type { Statement } from "./statements";
import type { TemplateParam, TypeSpec } from "./types";

// ---- Declarations (top-level and member) ----
export type Declaration = 
// Struct/class
StructDecl | ClassTemplateDecl | FunctionTemplateDecl
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
