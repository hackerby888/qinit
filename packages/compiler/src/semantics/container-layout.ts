import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function containerLayout(
    programAnalysis: ProgramAnalysis,
    name: string,
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): StructLayout {
    // Resolve plain zero-argument struct instances without a template definition. The name goes
    // through structByName so a nested declaration shadows a global of the same name, the way C++
    // resolves it and the way every other lookup in the compiler already does.
    if (!programAnalysis.templates.has(name) && !programAnalysis.specializations.has(name)) {
        const structDeclaration = programAnalysis.structByName(name, templateBindings);
        if (structDeclaration) return programAnalysis.layoutOfStruct(structDeclaration, templateBindings);
    }
    return programAnalysis.layoutOfTemplate(name, callArguments, templateBindings);
}
