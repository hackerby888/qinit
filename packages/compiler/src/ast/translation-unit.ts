import type { Declaration } from "./declarations";
import type { Span } from "./source-location";

// ---- Translation unit ----
export interface TranslationUnit {
    declarations: Declaration[];
    span: Span;
}
