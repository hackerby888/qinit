import type { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { FunctionDecl, StructDecl } from "../../../ast";
import type { CompiledHelperMetadata } from "../types";

export interface HelperFunctionDescriptor {
    declaration: FunctionDecl;
    metadata: CompiledHelperMetadata;
}

export interface ContractCallableCatalog {
    helperFunctions: HelperFunctionDescriptor[];
    privateFunctions: FunctionDecl[];
}

export function registerContractCallables(
    programAnalysis: ProgramAnalysis,
    contract: StructDecl,
    entryNames: ReadonlySet<string>,
    systemProcedureIds: ReadonlyMap<string, number>,
): ContractCallableCatalog {
    const helperFunctions: HelperFunctionDescriptor[] = [];
    const privateFunctions: FunctionDecl[] = [];

    for (const member of contract.members) {
        if (member.kind !== "function") {
            continue;
        }

        const declaration = member as FunctionDecl;

        if (!isCallableCandidate(
            declaration,
            contract,
            entryNames,
            systemProcedureIds,
        )) {
            continue;
        }

        if (declaration.params[0]?.name === "qpi") {
            registerPrivateFunction(
                programAnalysis,
                declaration,
                privateFunctions,
            );
            continue;
        }

        helperFunctions.push({
            declaration,
            metadata: registerHelperFunction(programAnalysis, declaration),
        });
    }

    return {
        helperFunctions,
        privateFunctions,
    };
}

function isCallableCandidate(
    declaration: FunctionDecl,
    contract: StructDecl,
    entryNames: ReadonlySet<string>,
    systemProcedureIds: ReadonlyMap<string, number>,
): boolean {
    if (!declaration.body) {
        return false;
    }

    if (
        entryNames.has(declaration.name) ||
        systemProcedureIds.has(declaration.name) ||
        declaration.name === "__impl_migrate"
    ) {
        return false;
    }

    return !(
        declaration.name === "__registerUserFunctionsAndProcedures" ||
        declaration.name.includes("operator") ||
        declaration.name === contract.name
    );
}

function registerPrivateFunction(
    programAnalysis: ProgramAnalysis,
    declaration: FunctionDecl,
    privateFunctions: FunctionDecl[],
): void {
    const localsDeclaration = programAnalysis["nested"].get(
        `${declaration.name}_locals`,
    );

    programAnalysis.privates.set(declaration.name, {
        label: `$priv_${declaration.name}`,
        localsSize: localsDeclaration
            ? programAnalysis.layoutOf(localsDeclaration).size
            : 0,
    });

    privateFunctions.push(declaration);
}

function registerHelperFunction(
    programAnalysis: ProgramAnalysis,
    declaration: FunctionDecl,
): CompiledHelperMetadata {
    const parameters = declaration.params.map((parameter) => {
        const isConstReference = (
            parameter.type.kind === "reference" &&
            parameter.type.referentType?.kind === "const"
        );
        const isPointerOrMutableReference = (
            (parameter.type.kind === "reference" && !isConstReference) ||
            parameter.type.kind === "pointer"
        );
        const isAddress = (
            isPointerOrMutableReference ||
            programAnalysis.isAggregateType(parameter.type)
        );
        const isByValueAggregate = (
            isAddress &&
            parameter.type.kind !== "reference" &&
            parameter.type.kind !== "pointer"
        );

        return {
            name: parameter.name,
            wasmType: (isAddress ? "i32" : "i64") as "i32" | "i64",
            isAddr: isAddress,
            type: programAnalysis.derefType(parameter.type),
            byValAgg: isByValueAggregate,
        };
    });

    const returnsVoid = programAnalysis.isVoidType(declaration.returnType);
    const aggregateReturnSize = (
        !returnsVoid && programAnalysis.isAggregateType(declaration.returnType)
    )
        ? programAnalysis.sizeOfType(
            programAnalysis.derefType(declaration.returnType),
        )
        : undefined;

    const overloads = (
        programAnalysis.helperOverloads.get(declaration.name) ?? []
    );
    const label = overloads.length === 0
        ? `$h_${declaration.name}`
        : `$h_${declaration.name}__ov${overloads.length}`;
    const namespaceContext = programAnalysis.namespaceContextOf(declaration);

    const metadata: CompiledHelperMetadata = {
        label,
        params: parameters,
        retIsValue: !returnsVoid && !aggregateReturnSize,
        retAgg: aggregateReturnSize,
        retType: returnsVoid
            ? undefined
            : programAnalysis.derefType(declaration.returnType),
        sourceNamespace: namespaceContext.sourceNamespace,
        usingNamespaces: namespaceContext.usingNamespaces,
    };

    overloads.push(metadata);
    programAnalysis.helperOverloads.set(declaration.name, overloads);

    if (overloads.length === 1) {
        programAnalysis.helpers.set(declaration.name, metadata);
    }

    return metadata;
}
