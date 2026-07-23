import { AstKind, WatNodeType, type WatValueType } from "../../../enums";
import type { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { StructLayout } from "../../../analysis/types";
import type { FunctionDecl, StructDecl, TypeSpec } from "../../../ast";
import type {
    ModuleSpecification,
    SystemProcedureInfo,
} from "../../../framework";
import { SYSPROC_IO } from "../abi/tables";
import { emitFunction } from "../functions/function-emitter";
import { findMemberFn } from "./contract-discovery";
import type { ContractLayoutResolver } from "./named-layouts";

interface LiteSystemProcedure {
    id: number;
    method: string;
    name: string;
}

type FunctionAliases = Map<string, {
    wasmType: WatValueType;
    isAddr: boolean;
    type: TypeSpec;
    local?: string;
}>;

export interface SystemProcedureIndex {
    idsByImplementation: Map<string, number>;
    prefixesByImplementation: Map<string, string>;
}

export interface SystemProcedureEmission {
    procedures: SystemProcedureInfo[];
    functionWat: string[];
}

export interface MigrationEmission {
    specification: ModuleSpecification["migrate"];
    functionWat?: string;
}

export function indexSystemProcedures(
    procedures: readonly LiteSystemProcedure[],
): SystemProcedureIndex {
    const idsByImplementation = new Map<string, number>();
    const prefixesByImplementation = new Map<string, string>();

    for (const procedure of procedures) {
        const implementationName = `__impl_${procedure.method}`;
        idsByImplementation.set(implementationName, procedure.id);
        prefixesByImplementation.set(implementationName, procedure.name);
    }

    return {
        idsByImplementation,
        prefixesByImplementation,
    };
}

export function emitSystemProcedures(
    programAnalysis: ProgramAnalysis,
    contract: StructDecl,
    stateLayout: StructLayout,
    layouts: ContractLayoutResolver,
    index: SystemProcedureIndex,
): SystemProcedureEmission {
    const procedures: SystemProcedureInfo[] = [];
    const functionWat: string[] = [];

    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;
        const procedureId = index.idsByImplementation.get(declaration.name);

        if (procedureId === undefined) {
            continue;
        }

        const label = `$sys_${procedures.length}`;
        const localsPrefix = (
            index.prefixesByImplementation.get(declaration.name) ??
            declaration.name
        );
        const localsLayout = layouts.resolve(`${localsPrefix}_locals`);
        const io = SYSPROC_IO[declaration.name];
        const inputLayout = layouts.resolveOptional(io?.in);
        const outputLayout = layouts.resolveOptional(io?.out);
        const aliases = io?.typedIO
            ? createTypedIoAliases(programAnalysis, io.in, io.out)
            : undefined;

        functionWat.push(
            emitFunction(
                programAnalysis,
                label,
                declaration,
                stateLayout,
                inputLayout,
                outputLayout,
                localsLayout,
                aliases,
            ),
        );

        procedures.push({
            id: procedureId,
            localsSize: localsLayout.size,
            inSize: inputLayout.size,
            outSize: outputLayout.size,
            label,
        });
    }

    return {
        procedures,
        functionWat,
    };
}

export function emitMigrationFunction(
    programAnalysis: ProgramAnalysis,
    contract: StructDecl,
    stateLayout: StructLayout,
    layouts: ContractLayoutResolver,
): MigrationEmission {
    const declaration = findMemberFn(contract, "__impl_migrate");

    if (!declaration?.body) {
        return { specification: undefined };
    }

    const oldStateLayout = layouts.resolve("OldStateData");
    const localsLayout = layouts.resolve("MIGRATE_locals");
    const aliases: FunctionAliases = new Map([
        [
            "oldState",
            {
                wasmType: WatNodeType.I32,
                isAddr: true,
                local: "__qinit_in",
                type: {
                    kind: AstKind.NAME,
                    name: "OldStateData",
                },
            },
        ],
    ]);

    return {
        functionWat: emitFunction(
            programAnalysis,
            "$migrate",
            declaration,
            stateLayout,
            oldStateLayout,
            layouts.emptyLayout,
            localsLayout,
            aliases,
        ),
        specification: {
            label: "$migrate",
            oldStateSize: oldStateLayout.size,
            localsSize: localsLayout.size,
        },
    };
}

function createTypedIoAliases(
    programAnalysis: ProgramAnalysis,
    inputTypeName: string | undefined,
    outputTypeName: string | undefined,
): FunctionAliases {
    const aliases: FunctionAliases = new Map();

    bindIoAlias(
        aliases,
        programAnalysis,
        "input",
        inputTypeName,
        "__qinit_in",
    );
    bindIoAlias(
        aliases,
        programAnalysis,
        "output",
        outputTypeName,
        "__qinit_out",
    );

    return aliases;
}

function bindIoAlias(
    aliases: FunctionAliases,
    programAnalysis: ProgramAnalysis,
    parameterName: string,
    typeName: string | undefined,
    localName: string,
): void {
    if (!typeName) {
        return;
    }

    const type = (
        programAnalysis.typedefs.get(typeName) ??
        { kind: AstKind.NAME, name: typeName } as TypeSpec
    );

    aliases.set(parameterName, {
        wasmType: WatNodeType.I32,
        isAddr: true,
        local: localName,
        type,
    });
}
