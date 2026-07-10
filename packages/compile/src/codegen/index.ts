// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.

export { Codegen } from "./cg";
export { buildLibTypes, generateWasmModule } from "./module";
export type { LibTypes, GeneratedContractMetadata } from "./module";
export type { Bindings, CalleeIdl, CodegenWarning, FieldLayout, StructLayout } from "./types";
