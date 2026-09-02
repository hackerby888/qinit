// Every cheatcode lowers to the `cheat` lhost import. Checked only where the module is emitted — the
// clang backend links its own copy and borrows this analysis for the IDL alone.
import { AstKind } from "../../../shared/enums";
import type { FunctionDecl, Statement } from "../../../ast";
import { hasLhostImport } from "../lhost";
import { visitStatement } from "./log-call-validation";
import type { PreparedContractModule } from "./module-analysis";

const CHEAT_INTRINSICS: ReadonlySet<string> = new Set(["__qinit_cheat_print", "__qinit_cheat_call"]);

const UNSUPPORTED_MESSAGE = "cheatcodes need core headers that declare the 'cheat' host import — run 'qinit setup' to update them";

export function validateCheatCalls(prepared: PreparedContractModule): void {
    const contract = prepared.contract;

    if (!contract || hasLhostImport(prepared.lhostAbi, "cheat")) {
        return;
    }

    for (const member of contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;

        if (!declaration.body) {
            continue;
        }

        visitStatement(declaration.body, (statement) => {
            reportUnsupportedCheat(prepared, statement);
        });
    }
}

// The whole statement, not an argument: a cheatcode macro generates its own arguments, so only the
// statement span survives the remap back to the line the user wrote.
function reportUnsupportedCheat(prepared: PreparedContractModule, statement: Statement): void {
    if (statement.kind !== AstKind.EXPRESSION) {
        return;
    }

    const call = statement.expression;

    if (call.kind !== AstKind.CALL || call.callee.kind !== AstKind.IDENTIFIER) {
        return;
    }

    if (!CHEAT_INTRINSICS.has(call.callee.name)) {
        return;
    }

    prepared.programAnalysis.error(UNSUPPORTED_MESSAGE, statement.span);
}
