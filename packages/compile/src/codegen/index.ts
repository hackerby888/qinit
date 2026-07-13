import "../backend/wasm/functions/function-lowering-services";

export {
  ProgramAnalysis,
  ProgramAnalysis as CodeGenerationContext,
} from "../analysis";
export {
  deriveQpiContextLayout,
  indexLibraryDeclarations,
} from "../backend/wasm/module/library-index";
export { generateWasmModule } from "../backend/wasm/module/module-generator";
export type {
  GeneratedContractMetadata,
  LibrarySymbolIndex,
} from "../backend/wasm/module/library-index";
export type {
  CalleeIdl,
  CodeGenerationWarning,
  FieldLayout,
  StructLayout,
  TemplateBindings,
} from "../backend/wasm/types";
