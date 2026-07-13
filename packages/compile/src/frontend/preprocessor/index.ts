import { Preprocessor } from "./preprocessor";

export { Preprocessor };
export type {
  MacroDef,
  PreprocessOptions,
} from "./preprocessor-context";

// Export a convenience function that embeds the qpi.h content
export function createQpiHeader(corePath: string): string {
    // This will be replaced at build time or the caller provides the content.
    return `// qpi.h stub — real content injected by compiler host
`;
}
