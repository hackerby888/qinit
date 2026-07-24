import {
    ContainerLayoutKind,
    WatNodeType,
    type WatValueType,
} from "../enums";
import type { ProgramAnalysis } from "./program-analysis";
import type {
    TypeSpec,
    Expression,
    Declaration,
    StructDecl,
    TemplateParam,
    FunctionTemplateDecl,
} from "../ast";

export interface ClassTemplate {
    params: TemplateParam[];
    members: Declaration[];
    bases?: TypeSpec[];
}

export interface CodeGenerationWarning {
    message: string;
    line: number;
    column: number;
}

export interface FieldLayout {
    name: string;
    offset: number;
    size: number;
    type: TypeSpec;
}

export interface StructLayout {
    size: number;
    align: number;
    fields: Map<string, FieldLayout>;
}

export interface TemplateBindings {
    types: Map<string, TypeSpec>;
    values: Map<string, bigint>;
    structs: Map<string, StructDecl>; // nested structs visible in the current layout scope (e.g. HashMap::Element)
}

export interface ResolvedSourceMethod {
    definition: FunctionTemplateDecl;
    ownerBindings: TemplateBindings;
    requiresMethodTemplateInference: boolean;
}

export const EMPTY_TEMPLATE_BINDINGS: TemplateBindings = { types: new Map(), values: new Map(), structs: new Map() };

export interface NamespaceLookupContext {
    sourceNamespace?: string;
    usingNamespaces: string[];
}

// Callee contract IDL for inter-contract calls — name → contract index + per-entry input type / IO sizes.
export interface ResolvedCalleeIdl {
    name: string;
    index: number;
    functions: Record<string, {
        inputType: number;
        inSize: number;
        outSize: number;
    }>;
    procedures: Record<string, {
        inputType: number;
        inSize: number;
        outSize: number;
    }>;
}

export interface CompiledHelperMetadata {
    label: string; // WAT function name ($h_<name>)
    params: {
        name: string;
        wasmType: WatValueType;
        isAddr: boolean;
        type: TypeSpec;
        byValAgg?: boolean;
    }[];
    retIsValue: boolean; // returns a scalar i64 (vs void)
    retWasmType?: WatValueType; // imported scalar ABI; ordinary helpers use i64
    retAgg?: number; // returns an aggregate (id/struct) by value — its size; ABI prepends a $ret dest-address param
    retType?: TypeSpec; // declared return type — drives conversions and aggregate-temporary member lookup
    sourceNamespace?: string; // lexical namespace/owner used to resolve unqualified sibling helpers
    usingNamespaces?: string[]; // using-directives visible at the helper definition
}

export interface PrivateFunctionMetadata {
    label: string; // WAT function name ($priv_<name>)
    localsSize: number; // sizeof(<name>_locals)
}

export interface CompiledMethod {
    label: string; // WAT function name ($T<n>_<Class>_<method>)
    functionParameters: {
        name: string;
        wasmType: WatValueType;
        isAddr: boolean;
        type: TypeSpec;
        concreteType?: TypeSpec;
        defaultValue?: Expression;
        readOnlyRef?: boolean;
    }[];
    retKind: WatNodeType;
    retAgg?: number; // aggregate (id/struct) return size — ABI prepends a $ret dest-address param
    retType?: TypeSpec; // concrete return/referent type
}

export interface ContainerLayoutMetadata {
    kind: ContainerLayoutKind;
    L: number;
    elemSize: number;
    keySize?: number;
    valOff?: number;
    valSize?: number;
    occBase?: number;
    popOff?: number;
    totalSize?: number;
    hashMode?: number;
    elemType?: TypeSpec;
}
