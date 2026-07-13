import type { FunctionLoweringServices } from "./functions/function-lowering-contract";
import type { ProgramAnalysis } from "../../analysis/program-analysis";
import type { TypeSpec, Expression, Declaration, StructDecl, TemplateParam } from "../../ast";
import type { StructLayout, TemplateBindings } from "../../analysis/types";
export * from "../../analysis/types";

export interface FunctionEmissionContext {
    programAnalysis: ProgramAnalysis;
    hasStateParam?: boolean; // this wasm function declares (param $state i32) — entry/private fns
    state: StructLayout;
    in: StructLayout;
    out: StructLayout;
    locals: StructLayout;
    localVars: Map<string, {
        wasmType: "i32" | "i64";
        type?: TypeSpec;
    }>;
    lines: string[];
    tmpCount: number;
    loops: {
        brk: string;
        cont: string;
        scratchDepth: number;
    }[]; // innermost loop's break/continue labels are last
    loopCount: number;
    params?: Map<string, {
        wasmType: "i32" | "i64";
        isAddr: boolean;
        type: TypeSpec;
        local?: string;
    }>; // value-helper / method parameters (local overrides the wasm slot name when inlining)
    retIsValue?: boolean; // function returns a scalar value (return <expr>)
    retIsAddr?: boolean; // function returns a reference/pointer as a wasm32 address
    retTypeName?: string; // declared scalar return type name: `return e` narrows to it (C++ conversion)
    retType?: TypeSpec; // concrete aggregate return type (initializer-list construction into retAddr)
    retAddr?: string; // helper returns an aggregate (id/struct) by value: `return e` copies e here
    retAggSize?: number; // size of that aggregate return
    thisLayout?: StructLayout; // when compiling a container method: layout of *this
    thisType?: TypeSpec; // the container template_instance (HashMap<id,uint64,1024>)
    thisBind?: TemplateBindings; // template-param bindings (KeyT→id, L→1024, ...) for the body
    staticConsts?: Map<string, bigint>; // the container's static constexpr members (_nEncodedFlags, ...)
    gotoLabels?: Map<string, {
        label: string;
        scratchDepth: number;
    }>; // C++ label → wasm block + RAII unwind depth
    refLocals?: Map<string, TypeSpec>; // reference/pointer locals: name → referent type (holds an address)
    scratchpadLocals?: Set<string>; // __ScopedScratchpad locals: an i32 holding the scratch buffer base; `.ptr` reads it
    scratchpadScope?: string[]; // scratchpads live in the current scope chain — released LIFO at compound exit
    thisAddr?: string; // WAT for *this's address (default "(local.get $this)"); set when inlining a struct method
    inlineMethod?: boolean; // emitting a struct method inline into the caller — `return` is suppressed (the value flows via thisAddr)
    inlineReturnLabel?: string; // block used to implement return from an inlined ordinary struct method
    inlineValueLocal?: string; // scalar return destination for an inlined method
    materializedCalls?: WeakMap<object, ResolvedAddress>; // side-effecting aggregate calls are evaluated once per AST expression
    proxyClass?: string; // emitting a ProposalVoting proxy method (qpi(pv).m()): the proxy class for sibling resolution
    sourceNamespace?: string; // lexical namespace/owner for unqualified free/static helper calls
    usingNamespaces?: string[]; // using-directives visible at the current function definition
    qpiContext?: "function" | "procedure"; // ambient entry context for QPI binding permission checks
    lowering: FunctionLoweringServices;
}

export interface ResolvedLvalue {
    addr: string; // WAT producing the i32 byte address
    size: number; // field size in bytes
    type?: TypeSpec | null; // pointee type when known — drives signed sub-64-bit load extension
}

// A resolved memory location: its address, the pointee type (null at a struct root), the byte size, and
export interface ResolvedAddress {
    addr: string;
    type: TypeSpec | null;
    size: number;
    layout: StructLayout | null;
}
