// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.
// Split by stage — cg.ts holds the type/layout/constant oracle (class Codegen); module.ts
// the entry points; stmt/addr/value the body emitters; calls/ the call-lowering family.
// This barrel is the package-facing surface; sibling modules import each other directly.

export { Codegen } from "./cg";
export { buildLibTypes, generateWasmModule } from "./module";
export type { LibTypes, GeneratedContractMetadata } from "./module";
export type { Bindings, CalleeIdl, CodegenWarning, FieldLayout, StructLayout } from "./types";
