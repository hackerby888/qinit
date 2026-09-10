import { StructLayout, EMPTY_TEMPLATE_BINDINGS, TemplateBindings } from "./types";
import type { TypeSpec } from "../ast";
import type { ProgramAnalysis } from "./program-analysis";

export function containerLayout(
    programAnalysis: ProgramAnalysis,
    name: string,
    callArguments: TypeSpec[],
    templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
): StructLayout {
    // Resolve plain zero-argument struct instances without a template definition; structByName lets a nested declaration shadow a global, as C++ does.
    if (!programAnalysis.templates.has(name) && !programAnalysis.specializations.has(name)) {
        const structDeclaration = programAnalysis.structByName(name, templateBindings);
        if (structDeclaration) return programAnalysis.layoutOfStruct(structDeclaration, templateBindings);
    }
    return programAnalysis.layoutOfTemplate(name, callArguments, templateBindings);
}
