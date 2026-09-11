// Validation runs after parse and before codegen.
import type { Declaration } from "../../ast";
import { Validator } from "./validator";
import { resolveBlockScopes } from "./block-scope-resolver";
import { validateSupplementalDeclarations } from "./supplemental-validation";
import type { ValidateDiagnostic } from "./validator-context";

export type { ValidateDiagnostic } from "./validator-context";

export function validateAndDesugarBase(translationUnit: { declarations: Declaration[] }): ValidateDiagnostic[] {
    // Name resolution first: block-scoped declarations are alpha-renamed so every later stage —
    // this validator, the analyzer and the flat wasm local set — sees one name per binding (F217).
    resolveBlockScopes(translationUnit.declarations);
    const value = new Validator();
    value.runTopLevel(translationUnit.declarations);
    return value.diagnostics;
}

export function validateAndDesugar(translationUnit: { declarations: Declaration[] }): ValidateDiagnostic[] {
    const diagnostics = validateAndDesugarBase(translationUnit);
    validateSupplementalDeclarations(translationUnit.declarations, diagnostics);
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
        const key = `${diagnostic.severity}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}
