// Validation runs after parse and before codegen.
import type { Declaration } from "../../ast";
import { Validator } from "./validator";
import { validateSupplementalDeclarations } from "./supplemental-validation";
import type { ValidateDiagnostic } from "./validator-context";

export type { ValidateDiagnostic } from "./validator-context";

export function validateAndDesugarBase(translationUnit: {
    declarations: Declaration[];
}): ValidateDiagnostic[] {
    const value = new Validator();
    value.runTopLevel(translationUnit.declarations);
    return value.diagnostics;
}

export function validateAndDesugar(translationUnit: {
    declarations: Declaration[];
}): ValidateDiagnostic[] {
    const diagnostics = validateAndDesugarBase(translationUnit);
    validateSupplementalDeclarations(translationUnit.declarations, diagnostics);
    const seen = new Set<string>();
    return diagnostics.filter((diagnostic) => {
        const key = `${diagnostic.severity}:${diagnostic.span.start}:${diagnostic.span.end}:${diagnostic.message}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
