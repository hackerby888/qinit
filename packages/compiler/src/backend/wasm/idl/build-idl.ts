// Assembles the ContractIdl a compiled module publishes: entries, state, enums, logs, migration.
import { QINIT_IDL_VERSION, forbiddenPublicType, type ContractEntry, type ContractIdl } from "@qinit/proto/contract-idl";
import { AstKind } from "../../../shared/enums";
import type { StructDecl } from "../../../ast";
import type { PreparedContractModule } from "../module/module-analysis";
import { findMemberFn } from "../module/contract-discovery";
import { USER_FUNCTION_KIND } from "../../../shared/entry-abi";
import { AbiTypeBuilder } from "./abi-type-builder";
import { contractEnums, contractLogs } from "./enums-and-logs";
import { collectContractCheats } from "./collect-cheats";

export interface BuildContractIdlOptions {
    contractName: string;
    slot: number;
    dependencies?: readonly string[];
}

export function buildContractIdl(prepared: PreparedContractModule, options: BuildContractIdlOptions): ContractIdl {
    const builder = new AbiTypeBuilder(prepared.programAnalysis);
    const functions: ContractEntry[] = [];
    const procedures: ContractEntry[] = [];

    for (const registration of prepared.registrations) {
        const input = builder.entryType(
            `${registration.fnName}_input`,
            prepared.layouts.resolve(`${registration.fnName}_input`),
            nestedStruct(prepared.contract, `${registration.fnName}_input`),
        );
        const output = builder.entryType(
            `${registration.fnName}_output`,
            prepared.layouts.resolve(`${registration.fnName}_output`),
            nestedStruct(prepared.contract, `${registration.fnName}_output`),
        );
        for (const [direction, type] of [
            ["input", input],
            ["output", output],
        ] as const) {
            const forbidden = forbiddenPublicType(type);
            if (forbidden) {
                prepared.programAnalysis.error(`${forbidden} is forbidden in registered entry '${registration.fnName}_${direction}'`, registration.line);
            }
        }
        const entry: ContractEntry = {
            name: registration.fnName,
            inputType: registration.inputType,
            inSize: input.size,
            outSize: output.size,
            input,
            output,
            ...(registration.notification ? { notification: true } : {}),
        };

        if (registration.kind === USER_FUNCTION_KIND) {
            functions.push(entry);
        } else {
            procedures.push(entry);
        }
    }

    const migration =
        prepared.contract && findMemberFn(prepared.contract, "__impl_migrate")?.body
            ? {
                  oldState: builder.namedStruct(
                      "OldStateData",
                      prepared.layouts.resolve("OldStateData"),
                      true,
                      nestedStruct(prepared.contract, "OldStateData"),
                  ),
              }
            : undefined;

    return {
        version: QINIT_IDL_VERSION,
        name: options.contractName,
        slot: options.slot,
        functions,
        procedures,
        state: builder.namedStruct("StateData", prepared.stateLayout, true, nestedStruct(prepared.contract, "StateData")),
        sysprocMask: systemProcedureMask(prepared),
        enums: contractEnums(prepared),
        logs: contractLogs(prepared, builder),
        cheats: collectContractCheats(prepared, builder),
        migration,
        dependencies: uniqueNames(options.dependencies ?? []),
    };
}

function systemProcedureMask(prepared: PreparedContractModule): number {
    if (!prepared.contract) {
        return 0;
    }

    let mask = 0;

    for (const member of prepared.contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const id = prepared.systemProcedureIndex.idsByImplementation.get(member.name);

        if (id !== undefined) {
            mask |= 1 << id;
        }
    }

    return mask;
}

function nestedStruct(contract: StructDecl | undefined, name: string): StructDecl | undefined {
    return contract?.members.find((member) => member.kind === AstKind.STRUCT && member.name === name && member.hasBody !== false) as StructDecl | undefined;
}

function uniqueNames(names: readonly string[]): string[] {
    return [...new Set(names)];
}
