import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { StructLayout } from "../../../analysis/types";
import type {
    Declaration,
    FunctionDecl,
    StructDecl,
} from "../../../ast";
import type { Sema } from "../../../sema";
import type { CalleeIdl } from "../types";

export interface CalleeTranslationUnit {
    contractName: string;
    declarations: Declaration[];
}

export function createModuleProgramAnalysis(
    semanticAnalysis: Sema,
    gtestMode: boolean,
    callees: CalleeIdl[] | undefined,
    calleeStructs: Map<string, StructDecl> | undefined,
): ProgramAnalysis {
    const programAnalysis = new ProgramAnalysis(semanticAnalysis);
    programAnalysis.gtestMode = gtestMode;

    for (const callee of callees ?? []) {
        programAnalysis.callees.set(callee.name, callee);
    }

    for (const [name, declaration] of calleeStructs ?? []) {
        programAnalysis.globalStructs.set(name, declaration);
    }

    return programAnalysis;
}

export function registerModuleDeclarations(
    programAnalysis: ProgramAnalysis,
    declarations: Declaration[],
    calleeTranslationUnits: CalleeTranslationUnit[] | undefined,
): void {
    programAnalysis.registerTopLevelDeclarations(declarations);

    for (const callee of calleeTranslationUnits ?? []) {
        programAnalysis.registerCalleeContractDeclarations(
            callee.contractName,
            callee.declarations,
        );
    }
}

export function prepareContractState(
    programAnalysis: ProgramAnalysis,
    contract: StructDecl,
    contractSlot: number,
): StructLayout {
    programAnalysis.collectNested(contract);
    programAnalysis.slot = contractSlot;

    recordMemberFunctionLines(programAnalysis, contract);

    const stateDeclaration = programAnalysis["nested"].get("StateData");
    const stateLayout = stateDeclaration
        ? programAnalysis.layoutOf(stateDeclaration)
        : createEmptyLayout();

    programAnalysis.contractStateLayout = stateLayout;
    return stateLayout;
}

function recordMemberFunctionLines(
    programAnalysis: ProgramAnalysis,
    contract: StructDecl,
): void {
    for (const member of contract.members) {
        if (member.kind !== "function") {
            continue;
        }

        const functionDeclaration = member as FunctionDecl;
        programAnalysis.memberFnLine.set(
            functionDeclaration.name,
            functionDeclaration.span?.line ?? 0,
        );
    }
}

function createEmptyLayout(): StructLayout {
    return {
        size: 0,
        align: 1,
        fields: new Map(),
    };
}
