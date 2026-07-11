import type { Codegen } from "./cg";
import type { TypeSpec, Expression, Statement, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, TemplateParam, ParamDecl } from "../ast";

export interface ClassTemplate {
  params: TemplateParam[];
  members: Declaration[];
  bases?: TypeSpec[];
}

export interface CodegenWarning {
  message: string;
  line: number;
  col: number;
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

export interface Bindings {
  types: Map<string, TypeSpec>;
  values: Map<string, bigint>;
  structs: Map<string, StructDecl>;   // nested structs visible in the current layout scope (e.g. HashMap::Element)
}

export const NO_BIND: Bindings = { types: new Map(), values: new Map(), structs: new Map() };

// Callee contract IDL for inter-contract calls — name → contract index + per-entry input type / IO sizes.
export interface CalleeIdl {
  name: string;
  index: number;
  functions: Record<string, { inputType: number; inSize: number; outSize: number }>;
  procedures: Record<string, { inputType: number; inSize: number; outSize: number }>;
}

export interface HelperInfo {
  label: string;                                              // WAT function name ($h_<name>)
  params: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; byValAgg?: boolean }[];
  retIsValue: boolean;                                        // returns a scalar i64 (vs void)
  retAgg?: number;                                            // returns an aggregate (id/struct) by value — its size; ABI prepends a $ret dest-address param
  retType?: TypeSpec;                                         // declared return type — drives conversions and aggregate-temporary member lookup
  sourceNamespace?: string;                                   // lexical namespace/owner used to resolve unqualified sibling helpers
}

export interface PrivateInfo {
  label: string;                                             // WAT function name ($priv_<name>)
  localsSize: number;                                        // sizeof(<name>_locals)
}

export interface CompiledMethod {
  label: string;                                             // WAT function name ($T<n>_<Class>_<method>)
  fnParams: { name: string; wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; defaultValue?: Expression }[];
  retKind: "i32" | "i64" | "void";
  retAgg?: number;                                           // aggregate (id/struct) return size — ABI prepends a $ret dest-address param
  retType?: TypeSpec;                                        // concrete return/referent type
}

export interface ContainerInfo {
  kind: "HashMap" | "Array";
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

export interface FnCtx {
  cg: Codegen;
  hasStateParam?: boolean;                    // this wasm function declares (param $state i32) — entry/private fns
  state: StructLayout;
  in: StructLayout;
  out: StructLayout;
  locals: StructLayout;
  localVars: Map<string, { wasmType: "i32" | "i64"; type?: TypeSpec }>;
  lines: string[];
  tmpCount: number;
  loops: { brk: string; cont: string; scratchDepth: number }[];   // innermost loop's break/continue labels are last
  loopCount: number;
  params?: Map<string, { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }>;  // value-helper / method parameters (local overrides the wasm slot name when inlining)
  retIsValue?: boolean;                       // function returns a scalar value (return <expr>)
  retIsAddr?: boolean;                        // function returns a reference/pointer as a wasm32 address
  retTypeName?: string;                       // declared scalar return type name: `return e` narrows to it (C++ conversion)
  retAddr?: string;                           // helper returns an aggregate (id/struct) by value: `return e` copies e here
  retAggSize?: number;                        // size of that aggregate return
  thisLayout?: StructLayout;                  // when compiling a container method: layout of *this
  thisType?: TypeSpec;                        // the container template_instance (HashMap<id,uint64,1024>)
  thisBind?: Bindings;                        // template-param bindings (KeyT→id, L→1024, ...) for the body
  staticConsts?: Map<string, bigint>;         // the container's static constexpr members (_nEncodedFlags, ...)
  gotoLabels?: Map<string, { label: string; scratchDepth: number }>; // C++ label → wasm block + RAII unwind depth
  refLocals?: Map<string, TypeSpec>;          // reference/pointer locals: name → referent type (holds an address)
  scratchpadLocals?: Set<string>;             // __ScopedScratchpad locals: an i32 holding the scratch buffer base; `.ptr` reads it
  scratchpadScope?: string[];                 // scratchpads live in the current scope chain — released LIFO at compound exit
  thisAddr?: string;                           // WAT for *this's address (default "(local.get $this)"); set when inlining a struct method
  inlineMethod?: boolean;                       // emitting a struct method inline into the caller — `return` is suppressed (the value flows via thisAddr)
  inlineReturnLabel?: string;                    // block used to implement return from an inlined ordinary struct method
  inlineValueLocal?: string;                     // scalar return destination for an inlined method
  materializedCalls?: WeakMap<object, AddrNode>;  // side-effecting aggregate calls are evaluated once per AST expression
  proxyClass?: string;                          // emitting a ProposalVoting proxy method (qpi(pv).m()): the proxy class for sibling resolution
  sourceNamespace?: string;                     // lexical namespace/owner for unqualified free/static helper calls
}

export interface Lvalue {
  addr: string;                 // WAT producing the i32 byte address
  size: number;                 // field size in bytes
  type?: TypeSpec | null;       // pointee type when known — drives signed sub-64-bit load extension
}

// A resolved memory location: its address, the pointee type (null at a struct root), the byte size, and
export interface AddrNode {
  addr: string;
  type: TypeSpec | null;
  size: number;
  layout: StructLayout | null;
}
