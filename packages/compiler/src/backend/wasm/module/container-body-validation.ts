import { AstKind } from "../../../shared/enums";
import type { Expression, FunctionDecl, TypeSpec } from "../../../ast";
import { walkExpressions } from "../../../frontend/validation/control-flow-validator";
import { compileContainerMethod } from "../calls/containers";
// Compiling a body needs the lowering services, which register themselves when this module loads. The
// analyzer does not otherwise pull them in, and leaving that to another import's side effect would make
// the check work or not by accident of who else was loaded.
import "../functions/function-lowering-services";
import { collectPayloadRoots, resolvePayload, visitStatement } from "./log-call-validation";
import type { PayloadRoots } from "./log-call-validation";
import type { PreparedContractModule } from "./module-analysis";

// A container's method bodies live in a header the wrapper includes AFTER the contract, so the editor's
// translation unit never instantiates them and nothing it runs reports what they require of a contract's
// own types. Lowering finds out by compiling the body; this compiles the same body, at the same call, in
// the phase the editor reaches — so whatever a body needs is reported without naming any requirement here.
export function validateContainerCalls(prepared: PreparedContractModule): void {
    const contract = prepared.contract;

    if (!contract) {
        return;
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
            walkExpressions(statement, (expression) => instantiateCalledBody(prepared, roots, expression));
        });
    }
}

function instantiateCalledBody(prepared: PreparedContractModule, roots: PayloadRoots, expression: Expression): void {
    if (expression.kind !== AstKind.CALL || expression.callee.kind !== AstKind.MEMBER_ACCESS) {
        return;
    }

    const receiver = receiverTemplateType(prepared, roots, expression.callee.object);

    if (!receiver) {
        return;
    }

    const programAnalysis = prepared.programAnalysis;
    const errorBase = programAnalysis.errors.length;
    const warningBase = programAnalysis.warnings.length;

    try {
        // Null for a method this type does not declare, which is a call the frontend has already judged.
        compileContainerMethod(programAnalysis, receiver, expression.callee.member, expression.callArguments.length);
    } catch {
        // The body's own verdict is read from the error list below; the throw itself says only that it stopped.
    }

    // Only an error counts. Compiling a body speculatively can fail for reasons that are not the contract's
    // — lowering services absent in a caller that only wanted an analysis, most of all — and those arrive as
    // a warning. Reporting them would squiggle working code wherever this runs less equipped than a build.
    const rejection = programAnalysis.errors[errorBase]?.message;

    // A body reports against its own header, which is not a file the developer has open, and a speculative
    // instantiation must not leave its workings behind either way. Both lists go back to where they were.
    programAnalysis.errors.length = errorBase;
    programAnalysis.warnings.length = warningBase;

    if (rejection) {
        programAnalysis.error(`${receiver.name}::${expression.callee.member} rejects this contract's types: ${rejection}`, expression.span);
    }
}

/** The receiver's type when it is a template instance reached from a payload root, else null. */
function receiverTemplateType(
    prepared: PreparedContractModule,
    roots: PayloadRoots,
    receiver: Expression,
): (TypeSpec & { kind: AstKind.TEMPLATE_INSTANCE }) | null {
    const resolved = resolvePayload(prepared.programAnalysis, roots, receiver);

    if (!resolved?.type) {
        return null;
    }

    const type = prepared.programAnalysis.derefType(resolved.type);
    return type.kind === AstKind.TEMPLATE_INSTANCE ? type : null;
}

