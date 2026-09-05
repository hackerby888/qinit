// The enum and log sections of the IDL, both built by walking the user's own declarations.
import { AbiScalarKind, type ContractEnum, type ContractLog } from "@qinit/proto/contract-idl";
import { AstKind } from "../../../shared/enums";
import type { Declaration, EnumDecl, StructDecl, VariableDecl } from "../../../ast";
import { LOG_TERMINATOR_FIELD } from "../abi/log-payload";
import type { PreparedContractModule } from "../module/module-analysis";
import { scalarKindForName } from "./scalars";
import type { AbiTypeBuilder } from "./abi-type-builder";
import { collectLogTypeValues } from "./log-type-values";

export function contractEnums(prepared: PreparedContractModule): ContractEnum[] {
    const enums: ContractEnum[] = [];

    for (const declaration of userDeclarations(prepared)) {
        if (declaration.kind !== AstKind.ENUM || !declaration.name) {
            continue;
        }

        const enumDeclaration = declaration as EnumDecl;
        const name = enumDeclaration.name;

        if (!name) {
            continue;
        }
        // Registration already followed the alias chain from the enum's own scope and stored the scalar it
        // reaches, so the reported kind is read from there rather than resolved a second time — two resolutions
        // are two chances to disagree with the width the layout used.
        // An enum nested in a struct is keyed under the struct, not the namespace, so the bare key answers for it.
        const scope = prepared.programAnalysis.namespaceContextOf(enumDeclaration).sourceNamespace;
        const stored = prepared.programAnalysis.enumUnderlying.get(scope ? `${scope}::${name}` : name) ?? prepared.programAnalysis.enumUnderlying.get(name);
        const underlyingName = stored?.kind === AstKind.NAME ? stored.name : "sint32";
        const underlying = scalarKindForName(underlyingName) ?? AbiScalarKind.SINT32;
        const members: Record<string, string> = {};

        for (const member of enumDeclaration.members) {
            const value = prepared.programAnalysis.resolveConst(`${name}::${member.name}`) ?? prepared.programAnalysis.resolveConst(member.name);

            if (value !== null) {
                members[value.toString()] = member.name;
            }
        }

        enums.push({
            name,
            underlying,
            members,
        });
    }

    return enums;
}

export function contractLogs(prepared: PreparedContractModule, builder: AbiTypeBuilder): ContractLog[] {
    const logs: ContractLog[] = [];
    const typeValues = collectLogTypeValues(prepared);

    for (const declaration of userDeclarations(prepared)) {
        if (declaration.kind !== AstKind.STRUCT || !declaration.name) {
            continue;
        }

        const struct = declaration as StructDecl;
        const terminatorIndex = struct.members.findIndex(
            (member) => member.kind === AstKind.VARIABLE && (member as VariableDecl).name === LOG_TERMINATOR_FIELD,
        );

        if (terminatorIndex < 0) {
            continue;
        }

        const fullLayout = prepared.programAnalysis.layoutOf(struct);
        const terminator = fullLayout.fields.get(LOG_TERMINATOR_FIELD);

        if (!terminator) {
            continue;
        }

        const fields = new Map([...fullLayout.fields].filter(([name]) => name !== LOG_TERMINATOR_FIELD));
        const align = fields.size === 0 ? 1 : Math.max(...[...fields.values()].map((field) => prepared.programAnalysis.alignOfType(field.type)));
        const types = typeValues.get(struct.name);

        logs.push({
            name: struct.name,
            type: builder.namedStruct(
                struct.name,
                {
                    size: terminator.offset,
                    align,
                    fields,
                },
                true,
                struct,
            ),
            ...(types ? { types: [...types].map(Number).sort((left, right) => left - right) } : {}),
        });
    }

    return logs;
}

function userDeclarations(prepared: PreparedContractModule): Declaration[] {
    const declarations: Declaration[] = [];
    const seen = new Set<Declaration>();

    const visit = (items: Declaration[]): void => {
        for (const declaration of items) {
            if (seen.has(declaration)) {
                continue;
            }

            seen.add(declaration);
            declarations.push(declaration);

            if (
                declaration.kind === AstKind.STRUCT ||
                declaration.kind === AstKind.NAMESPACE ||
                declaration.kind === AstKind.EXTERN_BLOCK ||
                declaration.kind === AstKind.CLASS_TEMPLATE
            ) {
                const children = (
                    "members" in declaration ? declaration.members : "body" in declaration && Array.isArray(declaration.body) ? declaration.body : []
                ) as Declaration[];
                visit(children);
            }
        }
    };

    visit(prepared.declarations);
    return declarations;
}
