// Unified AST for the QPI C++ subset — covers user contract code AND qpi.h template bodies.
// ---- Source location ----
export interface Span {
    start: number; // UTF-16 code-unit offset in the associated source
    end: number; // exclusive UTF-16 code-unit offset in the associated source
    line: number; // 1-based
    column: number; // 1-based column at start
}
