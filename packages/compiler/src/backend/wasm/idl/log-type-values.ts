import { AssignOp, AstKind } from "../../../shared/enums";
import type { Expression, FunctionDecl } from "../../../ast";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { PreparedContractModule } from "../module/module-analysis";
import { collectPayloadRoots, resolvePayload, visitStatement } from "../module/log-call-validation";

export const LOG_TYPE_FIELD = "_type";

// The `_type` values a contract writes into each log struct, keyed by the struct's bare name. Two log
// structs of one logged size are told apart by this word alone, so only values the analysis can fold
// are recorded: a value copied from a variable adds nothing rather than a guess.
export function collectLogTypeValues(prepared: PreparedContractModule): Map<string, Set<bigint>> {
    const values = new Map<string, Set<bigint>>();
    const contract = prepared.contract;

    if (!contract) {
        return values;
    }

    const rootsByFunction = collectPayloadRoots(prepared);

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
            if (statement.kind !== AstKind.EXPRESSION) {
                return;
            }

            const expression = statement.expression;

            if (expression.kind !== AstKind.ASSIGN || expression.operator !== AssignOp.ASSIGN) {
                return;
            }

            const target = expression.left;

            if (target.kind !== AstKind.MEMBER_ACCESS || target.member !== LOG_TYPE_FIELD) {
                return;
            }

            const payload = resolvePayload(prepared.programAnalysis, roots, target.object);
            const payloadType = payload?.type ? prepared.programAnalysis.derefType(payload.type) : null;

            if (!payloadType || payloadType.kind !== AstKind.NAME) {
                return;
            }

            const value = foldedConstant(prepared.programAnalysis, expression.right);

            if (value === null) {
                return;
            }

            const structName = payloadType.name.slice(payloadType.name.lastIndexOf("::") + 1);
            const recorded = values.get(structName) ?? new Set<bigint>();

            recorded.add(value);
            values.set(structName, recorded);
        });
    }

    return values;
}

function foldedConstant(programAnalysis: ProgramAnalysis, expression: Expression): bigint | null {
    switch (expression.kind) {
        case AstKind.INT_LITERAL:
            return programAnalysis.tryParseIntLiteral(expression.value);
        case AstKind.IDENTIFIER:
            return programAnalysis.resolveConst(expression.name);
        case AstKind.QUALIFIED_NAME:
            return programAnalysis.resolveConst(`${expression.namespace}::${expression.name}`);
        case AstKind.PAREN:
            return foldedConstant(programAnalysis, expression.expression);
        default:
            return null;
    }
}
