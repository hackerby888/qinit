import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec } from "../ast";
import type { ProgramAnalysisInternals } from "./program-analysis-context";

export function containerLayout(context: ProgramAnalysisInternals, name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
    // Resolve plain zero-argument struct instances without a template definition.
    if (!context.templates.has(name) && !context.specializations.has(name)) {
        const structDeclaration = context.globalStructs.get(name) ?? context.nested.get(name);
        if (structDeclaration)
            return context.layoutOfStruct(structDeclaration, templateBindings);
    }
    return context.layoutOfTemplate(name, callArguments, templateBindings);
}
