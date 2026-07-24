import { AstKind } from "../../../enums";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { StructLayout } from "../../../analysis/types";
import type {
    Declaration,
    FunctionDecl,
    StructDecl,
} from "../../../ast";
import type { QpiContextLayout } from "../../../framework";
import type { Sema } from "../../../sema";
import type { ContractIdl } from "@qinit/proto/contract-idl";
import type { ResolvedCalleeIdl } from "../../../analysis/types";
import {
    registerContractCallables,
    type ContractCallableCatalog,
} from "./contract-callables";
import { findContractStruct } from "./contract-discovery";
import {
    contextLayoutFromCodegen,
    type LibrarySymbolIndex,
    registerLibraryMetadata,
} from "./library-index";
import { ContractLayoutResolver } from "./named-layouts";
import {
    type ContractRegistration,
    registerEntryDispatchTargets,
    validateContractRegistrations,
    validateRegistrationInterfaces,
} from "./registrations";
import {
    indexSystemProcedures,
    type SystemProcedureIndex,
} from "./system-procedures";

export interface CalleeTranslationUnit {
    contractName: string;
    declarations: Declaration[];
}

export interface PreparedContractModule {
    programAnalysis: ProgramAnalysis;
    declarations: Declaration[];
    contract?: StructDecl;
    stateLayout: StructLayout;
    layouts: ContractLayoutResolver;
    registrations: ContractRegistration[];
    callables: ContractCallableCatalog;
    systemProcedureIndex: SystemProcedureIndex;
    contextLayout: QpiContextLayout;
    lhostAbi?: ReturnType<typeof registerLibraryMetadata>;
}

export interface PrepareContractModuleRequest {
    translationUnit: {
        declarations: Declaration[];
    };
    semanticAnalysis: Sema;
    contractSlot: number;
    libraryIndex?: LibrarySymbolIndex;
    callees?: ContractIdl[];
    calleeStructs?: Map<string, StructDecl>;
    calleeTranslationUnits?: CalleeTranslationUnit[];
    gtestMode: boolean;
}

export function prepareContractModule(
    request: PrepareContractModuleRequest,
): PreparedContractModule {
    const programAnalysis = createModuleProgramAnalysis(
        request.semanticAnalysis,
        request.gtestMode,
        request.callees,
        request.calleeStructs,
    );
    const lhostAbi = request.libraryIndex
        ? registerLibraryMetadata(programAnalysis, request.libraryIndex)
        : undefined;
    const contextLayout = contextLayoutFromCodegen(programAnalysis);
    const systemProcedureIndex = indexSystemProcedures(
        request.libraryIndex?.wasmAbi?.systemProcedures ?? [],
    );

    registerModuleDeclarations(
        programAnalysis,
        request.translationUnit.declarations,
        request.calleeTranslationUnits,
    );

    const contract = findContractStruct(request.translationUnit);
    const layouts = new ContractLayoutResolver(programAnalysis);

    if (!contract) {
        return {
            programAnalysis,
            declarations: request.translationUnit.declarations,
            stateLayout: createEmptyLayout(),
            layouts,
            registrations: [],
            callables: {
                helperFunctions: [],
                privateFunctions: [],
            },
            systemProcedureIndex,
            contextLayout,
            lhostAbi,
        };
    }

    const stateLayout = prepareContractState(
        programAnalysis,
        contract,
        request.contractSlot,
    );
    const registrations = validateContractRegistrations(
        contract,
        programAnalysis,
    );
    const callables = registerContractCallables(
        programAnalysis,
        contract,
        new Set(registrations.map((registration) => registration.fnName)),
        systemProcedureIndex.idsByImplementation,
    );

    validateRegistrationInterfaces(
        contract,
        registrations,
        programAnalysis,
        layouts,
    );
    registerEntryDispatchTargets(registrations, programAnalysis, layouts);

    return {
        programAnalysis,
        declarations: request.translationUnit.declarations,
        contract,
        stateLayout,
        layouts,
        registrations,
        callables,
        systemProcedureIndex,
        contextLayout,
        lhostAbi,
    };
}

export function createModuleProgramAnalysis(
    semanticAnalysis: Sema,
    gtestMode: boolean,
    callees: ContractIdl[] | undefined,
    calleeStructs: Map<string, StructDecl> | undefined,
): ProgramAnalysis {
    const programAnalysis = new ProgramAnalysis(semanticAnalysis);
    programAnalysis.gtestMode = gtestMode;

    for (const callee of callees ?? []) {
        programAnalysis.callees.set(
            callee.name,
            resolveCalleeIdl(callee),
        );
    }

    for (const [name, declaration] of calleeStructs ?? []) {
        programAnalysis.globalStructs.set(name, declaration);
    }

    return programAnalysis;
}

function resolveCalleeIdl(callee: ContractIdl): ResolvedCalleeIdl {
    return {
        name: callee.name,
        index: callee.slot,
        functions: Object.fromEntries(
            callee.functions.map((entry) => [
                entry.name,
                {
                    inputType: entry.inputType,
                    inSize: entry.inSize,
                    outSize: entry.outSize,
                },
            ]),
        ),
        procedures: Object.fromEntries(
            callee.procedures.map((entry) => [
                entry.name,
                {
                    inputType: entry.inputType,
                    inSize: entry.inSize,
                    outSize: entry.outSize,
                },
            ]),
        ),
    };
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
        if (member.kind !== AstKind.FUNCTION) {
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
        size: 1,
        align: 1,
        fields: new Map(),
    };
}
