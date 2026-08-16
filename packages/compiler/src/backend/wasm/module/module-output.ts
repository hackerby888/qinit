import { DiagnosticCategory } from "../../../shared/enums";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { SemanticAnalyzer } from "../../../semantics/semantic-analysis";
import type { SystemProcedureInfo, UserEntry } from "../framework";
import type { GeneratedContractMetadata } from "./library-index";
import type { ContractRegistration } from "./registrations";

export function applyGeneratedContractMetadata(
    output: GeneratedContractMetadata | undefined,
    stateSize: number,
    registrations: ContractRegistration[],
    entries: UserEntry[],
    systemProcedures: SystemProcedureInfo[],
    lhostAbi: GeneratedContractMetadata["lhostAbi"],
): void {
    if (!output) {
        return;
    }

    output.stateSize = stateSize;
    output.entries = registrations.map((registration, index) => ({
        name: registration.fnName,
        inputType: registration.inputType,
        kind: registration.kind,
        inSize: entries[index]?.inSize ?? 0,
        outSize: entries[index]?.outSize ?? 0,
    }));
    output.sysprocMask = systemProcedures.reduce((mask, procedure) => {
        return mask | (1 << procedure.id);
    }, 0);
    output.lhostAbi = lhostAbi;
}

export function copyProgramDiagnostics(programAnalysis: ProgramAnalysis, semanticAnalysis: SemanticAnalyzer): void {
    for (const warning of programAnalysis.warnings) {
        semanticAnalysis.warn(
            warning.message,
            {
                start: 0,
                end: 0,
                line: warning.line,
                column: warning.column,
            },
            DiagnosticCategory.FIDELITY,
        );
    }

    for (const error of programAnalysis.errors) {
        semanticAnalysis.error(error.message, {
            start: 0,
            end: 0,
            line: error.line,
            column: error.column,
        });
    }
}
