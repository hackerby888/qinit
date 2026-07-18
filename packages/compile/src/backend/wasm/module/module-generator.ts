import type { Declaration, StructDecl } from "../../../ast";
import type { Sema } from "../../../sema";
import {
    emitModule,
    type ModuleSpecification,
} from "../../../framework";
import { emitFunction, emitHelperFunction } from "../functions/function-emitter";
import type { CalleeIdl } from "../types";
import { registerContractCallables } from "./contract-callables";
import { findContractStruct } from "./contract-discovery";
import {
    type GeneratedContractMetadata,
    type LibrarySymbolIndex,
    contextLayoutFromCodegen,
    registerLibraryMetadata,
} from "./library-index";
import {
    createModuleProgramAnalysis,
    prepareContractState,
    registerModuleDeclarations,
    type CalleeTranslationUnit,
} from "./module-analysis";
import {
    publishProgramDiagnostics,
    writeGeneratedContractMetadata,
} from "./module-output";
import { ContractLayoutResolver } from "./named-layouts";
import {
    emitRegisteredEntries,
    registerEntryDispatchTargets,
    validateContractRegistrations,
    validateRegistrationInterfaces,
} from "./registrations";
import {
    emitMigrationFunction,
    emitSystemProcedures,
    indexSystemProcedures,
} from "./system-procedures";

const DEFAULT_ARENA_SIZE = 1024 * 1024 * 1024;

interface ModuleGenerationRequest {
    translationUnit: {
        declarations: Declaration[];
    };
    semanticAnalysis: Sema;
    contractName: string;
    contractSlot: number;
    arenaSize: number;
    libraryIndex?: LibrarySymbolIndex;
    callees?: CalleeIdl[];
    calleeStructs?: Map<string, StructDecl>;
    calleeTranslationUnits?: CalleeTranslationUnit[];
    sharedMemoryBase?: number;
    metadataOutput?: GeneratedContractMetadata;
    gtestMode: boolean;
}

export function generateWasmModule(
    translationUnit: {
        declarations: Declaration[];
    },
    semanticAnalysis: Sema,
    contractName: string,
    contractSlot: number,
    arenaSize: number = DEFAULT_ARENA_SIZE,
    libraryIndex?: LibrarySymbolIndex,
    callees?: CalleeIdl[],
    calleeStructs?: Map<string, StructDecl>,
    calleeTranslationUnits?: CalleeTranslationUnit[],
    sharedMemoryBase?: number,
    metadataOutput?: GeneratedContractMetadata,
    gtestMode = false,
): string {
    return generateContractModule({
        translationUnit,
        semanticAnalysis,
        contractName,
        contractSlot,
        arenaSize,
        libraryIndex,
        callees,
        calleeStructs,
        calleeTranslationUnits,
        sharedMemoryBase,
        metadataOutput,
        gtestMode,
    });
}

function generateContractModule(request: ModuleGenerationRequest): string {
    const programAnalysis = createModuleProgramAnalysis(
        request.semanticAnalysis,
        request.gtestMode,
        request.callees,
        request.calleeStructs,
    );

    const lhostAbi = request.libraryIndex
        ? registerLibraryMetadata(programAnalysis, request.libraryIndex)
        : undefined;
    const systemProcedureIndex = indexSystemProcedures(
        request.libraryIndex?.wasmAbi?.systemProcedures ?? [],
    );
    const contextLayout = contextLayoutFromCodegen(programAnalysis);

    registerModuleDeclarations(
        programAnalysis,
        request.translationUnit.declarations,
        request.calleeTranslationUnits,
    );

    const contract = findContractStruct(request.translationUnit);

    if (!contract) {
        return emitModule({
            contractSlot: request.contractSlot,
            stateSize: 0,
            arenaSize: request.arenaSize,
            contextLayout,
            entries: [],
            sysprocs: [],
            userFunctionsWat: ";; no contract struct found",
            memBase: request.sharedMemoryBase,
            lhostAbi,
            assetEnumerationRecord: programAnalysis.assetEnumerationRecord,
        });
    }

    const stateLayout = prepareContractState(
        programAnalysis,
        contract,
        request.contractSlot,
    );
    const layouts = new ContractLayoutResolver(programAnalysis);
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

    const entryEmission = emitRegisteredEntries(
        contract,
        registrations,
        programAnalysis,
        stateLayout,
        layouts,
    );
    const userFunctions = [...entryEmission.functionWat];

    const systemProcedureEmission = emitSystemProcedures(
        programAnalysis,
        contract,
        stateLayout,
        layouts,
        systemProcedureIndex,
    );
    userFunctions.push(...systemProcedureEmission.functionWat);

    const migrationEmission = emitMigrationFunction(
        programAnalysis,
        contract,
        stateLayout,
        layouts,
    );

    if (migrationEmission.functionWat) {
        userFunctions.push(migrationEmission.functionWat);
    }

    for (const declaration of callables.privateFunctions) {
        const metadata = programAnalysis.privates.get(declaration.name)!;
        userFunctions.push(
            emitFunction(
                programAnalysis,
                metadata.label,
                declaration,
                stateLayout,
                layouts.resolve(`${declaration.name}_input`),
                layouts.resolve(`${declaration.name}_output`),
                layouts.resolve(`${declaration.name}_locals`),
            ),
        );
    }

    for (const helper of callables.helperFunctions) {
        userFunctions.push(
            emitHelperFunction(
                programAnalysis,
                helper.metadata,
                helper.declaration,
                stateLayout,
            ),
        );
    }

    userFunctions.push(...programAnalysis.emittedMethodOrder);

    const moduleSpecification: ModuleSpecification = {
        contractSlot: request.contractSlot,
        stateSize: stateLayout.size,
        arenaSize: request.arenaSize,
        contextLayout,
        entries: entryEmission.entries,
        sysprocs: systemProcedureEmission.procedures,
        userFunctionsWat: userFunctions.join("\n"),
        migrate: migrationEmission.specification,
        memBase: request.sharedMemoryBase,
        gtest: request.gtestMode,
        capabilities: [...programAnalysis.capabilities],
        lhostAbi,
        assetEnumerationRecord: programAnalysis.assetEnumerationRecord,
    };

    writeGeneratedContractMetadata(
        request.metadataOutput,
        stateLayout.size,
        registrations,
        entryEmission.entries,
        systemProcedureEmission.procedures,
        lhostAbi,
    );
    publishProgramDiagnostics(programAnalysis, request.semanticAnalysis);

    return emitModule(moduleSpecification);
}
