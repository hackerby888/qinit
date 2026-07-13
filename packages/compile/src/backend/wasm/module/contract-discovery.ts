import type { Declaration, StructDecl, FunctionDecl } from "../../../ast";

// ---- AST helpers ----
export function findContractStruct(translationUnit: {
    declarations: Declaration[];
}): StructDecl | null {
    // The user contract may end up nested inside a namespace if qpi.h's bracket structure recovered imperfectly, so search
    const all: StructDecl[] = [];
    const walk = (declarations: Declaration[]) => {
        for (const declaration of declarations) {
            if (declaration.kind === "struct")
                all.push(declaration as StructDecl);
            else if (declaration.kind === "namespace")
                walk((declaration as any).body);
        }
    };
    walk(translationUnit.declarations);
    for (const allItem of all) {
        if (allItem.bases.some((baseType) => baseType.kind === "name" && baseType.name === "ContractBase"))
            return allItem;
        if (allItem.name === "CONTRACT_STATE_TYPE")
            return allItem;
    }
    // fallback: a struct with a nested StateData that isn't one of the qpi.h library types
    for (const allItemCandidate of all) {
        if (allItemCandidate.members.some((member) => member.kind === "struct" && (member as StructDecl).name === "StateData"))
            return allItemCandidate;
    }
    return null;
}

export function findMemberFn(contract: StructDecl, name: string): FunctionDecl | null {
    for (const member of contract.members) {
        if (member.kind === "function" && (member as FunctionDecl).name === name)
            return member as FunctionDecl;
    }
    return null;
}
