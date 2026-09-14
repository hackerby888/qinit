import { AstKind } from "../../../shared/enums";
import type { FunctionDecl } from "../../../ast";
import { collectPayloadRoots, visitStatement } from "./log-call-validation";
import type { PreparedContractModule } from "./module-analysis";

// Class scope wins over namespace scope inside a member function, so a member function hides a file-scope
// constant of the same name. Lowering reports that; the editor stops earlier, so the clear shape is here.
export function validateHiddenMemberReads(prepared: PreparedContractModule): void {
    const contract = prepared.contract;
    const memberFunctions = prepared.programAnalysis.memberFnLine;

    if (!contract || memberFunctions.size === 0) {
        return;
    }

    // The same set lowering means by `hasStateParam`: entries, system procedures, MIGRATE and private functions.
    const stateParamFunctions = collectPayloadRoots(prepared);

    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;

        if (!declaration.body || !stateParamFunctions.has(declaration.name)) {
            continue;
        }

        visitStatement(declaration.body, (statement) => {
            if (statement.kind !== AstKind.EXPRESSION || statement.expression.kind !== AstKind.ASSIGN) {
                return;
            }

            // Only a bare identifier on the right of an assignment, which is always a value read: narrower
            // than lowering's check, which knows every value position, and never a false positive.
            const read = statement.expression.right;

            if (read.kind !== AstKind.IDENTIFIER || !memberFunctions.has(read.name)) {
                return;
            }

            prepared.programAnalysis.error(
                `'${read.name}' names a member function of this contract, which hides the file-scope declaration of the same name — a function is not a value`,
                read.span,
            );
        });
    }
}
