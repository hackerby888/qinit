// WAT codegen: walks the parsed contract AST and emits a complete WASM-text module.

export { CodeGenerationContext } from "./code-generation-context";
export {
  indexLibraryDeclarations,
  generateWasmModule,
} from "./module";
export type { LibrarySymbolIndex, GeneratedContractMetadata } from "./module";
export type { TemplateBindings, CalleeIdl, CodeGenerationWarning, FieldLayout, StructLayout } from "./types";
