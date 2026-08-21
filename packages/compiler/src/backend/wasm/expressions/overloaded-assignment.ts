import { AstKind, WatNodeType } from "../../../shared/enums";
import type { TypeSpec } from "../../../ast";
import { EMPTY_TEMPLATE_BINDINGS, type FunctionEmissionContext } from "../types";
import type { AssignmentExpression, AssignmentTarget } from "./assignment-types";
import { concreteType, operatorOwner } from "./operator-overload";

// id and m256i declare operator= over x86 intrinsics, which have no wasm32 lowering. The byte-wise
// substitution binary-expression.ts documents for their comparisons covers their assignment too.
const INTRINSIC_CLASSES: ReadonlySet<string> = new Set(["m256i", "id"]);

function unqualifiedName(name: string): string {
    const separator = name.lastIndexOf("::");

    return separator >= 0 ? name.slice(separator + 2) : name;
}

/**
 * Assign through the operator the class declared, for `=` and every compound form.
 *
 * A class that declares none keeps the memberwise copy C++ gives it implicitly, which is what the
 * aggregate arm already emits.
 */
export function tryEmitOverloadedAssignment(context: FunctionEmissionContext, expression: AssignmentExpression, target: AssignmentTarget | null): boolean {
    if (!target?.type) {
        return false;
    }

    // Read the target's own type. Resolving the left-hand side again would materialize a call that
    // emitAssignment has already emitted.
    const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
    const declared = concreteType(context, target.type);
    const targetType = declared ? context.programAnalysis.substInBindings(declared, bind) : null;

    if (targetType?.kind !== AstKind.NAME && targetType?.kind !== AstKind.TEMPLATE_INSTANCE) {
        return false;
    }

    if (INTRINSIC_CLASSES.has(unqualifiedName(targetType.name))) {
        return false;
    }

    const operatorName = `operator${expression.operator}`;
    const ownerName = operatorOwner(context, targetType.name, operatorName, 1);

    if (!ownerName) {
        return false;
    }

    // A template's arguments come from the target's type; instantiating Array without them leaves
    // T and L unbound.
    const owner: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    } =
        targetType.kind === AstKind.TEMPLATE_INSTANCE
            ? targetType
            : {
                  kind: AstKind.TEMPLATE_INSTANCE,
                  name: ownerName,
                  callArguments: [],
              };
    const compiled = context.lowering.callCompiled(context, owner, operatorName, target.addr, [expression.right]);

    if (!compiled) {
        return false;
    }

    // The body returns `T&`, a value the statement has no use for.
    const discardsResult = !compiled.retDest && compiled.cm.retKind !== WatNodeType.VOID;
    context.lines.push(`    ${discardsResult ? `(drop ${compiled.call})` : compiled.call}`);

    return true;
}
