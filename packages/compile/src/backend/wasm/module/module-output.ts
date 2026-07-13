import type { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { Sema } from "../../../sema";
import type { SystemProcedureInfo, UserEntry } from "../../../framework";
import type {
    GeneratedContractMetadata,
} from "./library-index";
import type { ContractRegistration } from "./registrations";

export function writeGeneratedContractMetadata(
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

export function publishProgramDiagnostics(
    programAnalysis: ProgramAnalysis,
    semanticAnalysis: Sema,
): void {
    for (const warning of programAnalysis.warnings) {
        semanticAnalysis.warn(
            warning.message,
            {
                start: 0,
                end: 0,
                line: warning.line,
                column: warning.column,
            },
            "fidelity",
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
