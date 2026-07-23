import { AstKind } from "../../../enums";
import type { Declaration, StructDecl, FunctionDecl } from "../../../ast";

// ---- AST helpers ----
export function findContractStruct(translationUnit: {
    declarations: Declaration[];
}): StructDecl | null {
    // Search nested namespaces when recovery leaves the user contract wrapped.
    const all: StructDecl[] = [];
    const walk = (declarations: Declaration[]) => {
        for (const declaration of declarations) {
            if (declaration.kind === AstKind.STRUCT)
                all.push(declaration as StructDecl);
            else if (declaration.kind === AstKind.NAMESPACE)
                walk((declaration as any).body);
        }
    };
    walk(translationUnit.declarations);
    for (const allItem of all) {
        if (allItem.bases.some((baseType) => baseType.kind === AstKind.NAME && baseType.name === "ContractBase"))
            return allItem;
        if (allItem.name === "CONTRACT_STATE_TYPE")
            return allItem;
    }
    // fallback: a struct with a nested StateData that isn't one of the qpi.h library types
    for (const allItemCandidate of all) {
        if (allItemCandidate.members.some((member) => member.kind === AstKind.STRUCT && (member as StructDecl).name === "StateData"))
            return allItemCandidate;
    }
    return null;
}

export function findMemberFn(contract: StructDecl, name: string): FunctionDecl | null {
    for (const member of contract.members) {
        if (member.kind === AstKind.FUNCTION && (member as FunctionDecl).name === name)
            return member as FunctionDecl;
    }
    return null;
}
