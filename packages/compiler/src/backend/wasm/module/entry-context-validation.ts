// A read-only entry must not reach a mutating one: qpi.h declares a function's context as
// QpiContextFunctionCall and a procedure's as QpiContextProcedureCall, which derives from it, so
// clang refuses the base-where-derived argument that CALL(procedure, ...) forwards from a function.
import { AstKind } from "../../../shared/enums";
import type { Expression, FunctionDecl, Statement } from "../../../ast";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import type { PreparedContractModule } from "./module-analysis";

// The class an entry takes as its context, or null when it declares none (a plain helper). Narrower
// than clang, which checks every argument by reference binding; the backend's type inference is not
// complete enough for the general rule, so this gates on the context class in parameter 0.
function contextClassOf(programAnalysis: ProgramAnalysis, declaration: FunctionDecl): string | null {
    const declared = declaration.params[0]?.type;
    if (!declared) return null;
    const resolved = programAnalysis.derefType(declared);
    if (resolved.kind !== AstKind.NAME) return null;
    const bare = resolved.name.includes("::") ? resolved.name.slice(resolved.name.lastIndexOf("::") + 2) : resolved.name;
    return bare.startsWith("QpiContext") ? bare : null;
}

/** Whether an argument of class `from` binds a parameter of class `to` — identity or derived-to-base. */
function convertible(programAnalysis: ProgramAnalysis, from: string, to: string): boolean {
    return from === to || programAnalysis.methodOwnerNames(from).includes(to);
}

/** Every call expression in a statement tree, callee and arguments included. */
function visitCalls(statement: Statement | undefined, visit: (call: Expression & { kind: AstKind.CALL }) => void): void {
    const inExpression = (expression: Expression | undefined): void => {
        if (!expression) return;
        if (expression.kind === AstKind.CALL) visit(expression);
        for (const child of subExpressions(expression)) inExpression(child);
    };
    const inStatement = (node: Statement | undefined): void => {
        if (!node) return;
        switch (node.kind) {
            case AstKind.COMPOUND:
                for (const item of node.body) inStatement(item);
                break;
            case AstKind.IF:
                inExpression(node.condition);
                inStatement(node.then);
                inStatement(node.else_);
                break;
            case AstKind.FOR:
                inStatement(node.initializer);
                inExpression(node.condition);
                inExpression(node.update);
                inStatement(node.body);
                break;
            case AstKind.WHILE:
            case AstKind.DO_WHILE:
                inExpression(node.condition);
                inStatement(node.body);
                break;
            case AstKind.SWITCH:
                inExpression(node.condition);
                inStatement(node.body);
                break;
            case AstKind.CASE:
                inExpression(node.value);
                break;
            case AstKind.EXPRESSION:
                inExpression(node.expression);
                break;
            case AstKind.RETURN:
                inExpression(node.value);
                break;
            case AstKind.STATIC_ASSERT:
                inExpression(node.condition);
                break;
            case AstKind.DECLARATION:
                if (node.declaration.kind === AstKind.VARIABLE) inExpression(node.declaration.initializer);
                break;
        }
    };
    inStatement(statement);
}

function subExpressions(expression: Expression): (Expression | undefined)[] {
    switch (expression.kind) {
        case AstKind.UNARY_OP:
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return [expression.argument];
        case AstKind.BINARY_OP:
        case AstKind.ASSIGN:
            return [expression.left, expression.right];
        case AstKind.TERNARY:
            return [expression.condition, expression.then, expression.else_];
        case AstKind.MEMBER_ACCESS:
            return [expression.object];
        case AstKind.SUBSCRIPT:
            return [expression.object, expression.index];
        case AstKind.SEQUENCE:
        case AstKind.INITIALIZER_LIST:
            return expression.expressions;
        case AstKind.CALL:
            return [expression.callee, ...expression.callArguments];
        case AstKind.TEMPLATE_CALL:
        case AstKind.CONSTRUCT:
            return expression.callArguments;
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
        case AstKind.REINTERPRET_CAST:
        case AstKind.PAREN:
        case AstKind.SIZEOF_EXPR:
            return [expression.expression];
        default:
            return [];
    }
}

// The sibling entry a call targets. The scaffold rewrites `CALL(f, in, out)` to
// `__qpi_call_self(f, in, out)`, moving the target out of callee position, which is why the callee's
// declared parameter types stopped taking part in the call at all.
function selfCallTarget(call: Expression & { kind: AstKind.CALL }): string | null {
    if (call.callee.kind !== AstKind.IDENTIFIER) return null;
    if (call.callee.name === SELF_CALL_INTRINSIC) {
        const target = call.callArguments[0];
        return target?.kind === AstKind.IDENTIFIER ? target.name : null;
    }
    return call.callee.name;
}

// What `CALL(f, in, out)` becomes; see driver/qpi/scaffold.ts.
const SELF_CALL_INTRINSIC = "__qpi_call_self";

/** Report every call that would forward a weaker context than the callee declares. */
export function validateEntryContextConversions(prepared: PreparedContractModule): void {
    const contract = prepared.contract;
    if (!contract) return;
    const programAnalysis = prepared.programAnalysis;

    const entries = new Map<string, FunctionDecl>();
    for (const member of contract.members) {
        if (member.kind === AstKind.FUNCTION) entries.set((member as FunctionDecl).name, member as FunctionDecl);
    }

    for (const [name, caller] of entries) {
        if (!caller.body) continue;
        const callerContext = contextClassOf(programAnalysis, caller);
        if (!callerContext) continue;

        visitCalls(caller.body, (call) => {
            const targetName = selfCallTarget(call);
            if (!targetName) return;
            const callee = entries.get(targetName);
            if (!callee || callee === caller) return;
            const calleeContext = contextClassOf(programAnalysis, callee);
            if (!calleeContext) return;
            if (convertible(programAnalysis, callerContext, calleeContext)) return;

            programAnalysis.error(
                `'${name}' takes ${callerContext} and cannot CALL '${targetName}', which requires ${calleeContext}` +
                    ` — a read-only entry may not reach one that can move state`,
                programAnalysis.memberFnLine.get(name) ?? call.span?.line ?? 0,
            );
        });
    }
}
