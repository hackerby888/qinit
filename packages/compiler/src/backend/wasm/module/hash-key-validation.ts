import { AstKind } from "../../../shared/enums";
import type { Declaration, Expression, FunctionDecl, StructDecl, TypeSpec } from "../../../ast";
import { walkExpressions } from "../../../frontend/validation/control-flow-validator";
import { operatorOwner } from "../expressions/operator-overload";
import { collectPayloadRoots, resolvePayload, visitStatement } from "./log-call-validation";
import type { PayloadRoots } from "./log-call-validation";
import type { PreparedContractModule } from "./module-analysis";

// Core's hash containers compare two keys inside their method bodies, and those bodies arrive in a header the
// wrapper includes AFTER the contract — so the editor's translation unit never instantiates them and a key
// type with no `operator==` type-checks there while both backends refuse it. Reported here, which the editor reaches.
const COMPARING_METHODS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
    ["HashMap", new Set(["contains", "get", "getElementIndex", "removeByKey", "replace", "set"])],
    ["HashSet", new Set(["add", "contains", "getElementIndex", "remove"])],
]);

const EQUALITY_OPERATOR = "operator==";

export function validateHashKeyComparisons(prepared: PreparedContractModule): void {
    const contract = prepared.contract;

    if (!contract) {
        return;
    }

    const rootsByFunction = collectPayloadRoots(prepared);
    const ownStructs = structsDeclaredIn(contract.members, new Set());

    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;
        const roots = rootsByFunction.get(declaration.name);

        if (!roots || !declaration.body) {
            continue;
        }

        visitStatement(declaration.body, (statement) => {
            walkExpressions(statement, (expression) => checkKeyComparison(prepared, roots, ownStructs, expression));
        });
    }
}

function checkKeyComparison(prepared: PreparedContractModule, roots: PayloadRoots, ownStructs: ReadonlySet<StructDecl>, expression: Expression): void {
    if (expression.kind !== AstKind.CALL || expression.callee.kind !== AstKind.MEMBER_ACCESS) {
        return;
    }

    const container = containerReceiverType(prepared, roots, expression.callee.object);

    if (!container || !COMPARING_METHODS.get(container.name)?.has(expression.callee.member)) {
        return;
    }

    const keyType = container.callArguments[0];
    const keyStruct = keyType ? prepared.programAnalysis.structOf(keyType) : null;

    // Only a struct the contract itself declares is judged, so a core key is left alone whatever the lookup
    // below says: `id` is `m256i`, whose `operator==` sits at namespace scope where a class-scope walk cannot see it.
    if (!keyType || !keyStruct || !ownStructs.has(keyStruct)) {
        return;
    }

    if (operatorOwner(prepared.programAnalysis, keyStruct.name, EQUALITY_OPERATOR, 1)) {
        return;
    }

    prepared.programAnalysis.error(
        `'${keyStruct.name}' is the key type of this ${container.name} and declares no 'operator==', which ${container.name}::${expression.callee.member} compares keys with`,
        expression.span,
    );
}

/** The receiver's type when it is a hash container reached from a payload root, else null. */
function containerReceiverType(
    prepared: PreparedContractModule,
    roots: PayloadRoots,
    receiver: Expression,
): (TypeSpec & { kind: AstKind.TEMPLATE_INSTANCE }) | null {
    const resolved = resolvePayload(prepared.programAnalysis, roots, receiver);

    if (!resolved?.type) {
        return null;
    }

    const type = prepared.programAnalysis.derefType(resolved.type);
    return type.kind === AstKind.TEMPLATE_INSTANCE && COMPARING_METHODS.has(type.name) ? type : null;
}

/** The struct declarations nested anywhere inside the contract, which are the only key types this judges. */
function structsDeclaredIn(members: readonly Declaration[], found: Set<StructDecl>): Set<StructDecl> {
    for (const member of members) {
        if (member.kind !== AstKind.STRUCT) {
            continue;
        }

        const structDeclaration = member as StructDecl;
        found.add(structDeclaration);
        structsDeclaredIn(structDeclaration.members, found);
    }

    return found;
}
