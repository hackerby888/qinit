// Validation runs after parse and before codegen.
import type { FunctionDecl, Statement } from "../../ast";
import { isVoidType, isConstType } from "./validation-helpers";
import type { FnSig, ValidatorInternals } from "./validator-context";

export function walkScope(context: ValidatorInternals, statement: Statement, fn: FunctionDecl, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
    const: boolean;
}>>): void {
    const recurse = (statement: Statement) => context.walkScope(statement, fn, memberFns, allLocals, constParams, scopes);
    const inOwnScope = (statement: Statement, extra?: () => void) => {
        scopes.push(new Map());
        if (extra) {
            extra();
        }
        recurse(statement);
        scopes.pop();
    };
    switch (statement.kind) {
        case "compound":
            // The parser wraps multi-declarator statements in a synthetic compound.
            if ((statement as any).synthetic) {
                for (const bodyItem of statement.body) {
                    recurse(bodyItem);
                }
                break;
            }
            scopes.push(new Map());
            for (const bodyItem of statement.body) {
                recurse(bodyItem);
            }
            scopes.pop();
            break;
        case "declaration":
            context.checkDeclarationStatement(statement, scopes);
            if (statement.declaration.kind === "variable" && statement.declaration.initializer) {
                context.checkExpression(statement.declaration.initializer, memberFns, allLocals, constParams, scopes);
            }
            break;
        case "if":
            context.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
            inOwnScope(statement.then);
            if (statement.else_) {
                inOwnScope(statement.else_);
            }
            break;
        case "for":
            scopes.push(new Map());
            if (statement.initializer) {
                recurse(statement.initializer);
            }
            if (statement.condition) {
                context.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
            }
            if (statement.update) {
                context.checkExpression(statement.update, memberFns, allLocals, constParams, scopes);
            }
            context.loopDepth++;
            inOwnScope(statement.body);
            context.loopDepth--;
            scopes.pop();
            break;
        case "while":
            context.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
            context.loopDepth++;
            inOwnScope(statement.body);
            context.loopDepth--;
            break;
        case "do_while":
            context.loopDepth++;
            inOwnScope(statement.body);
            context.loopDepth--;
            context.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
            break;
        case "switch":
            context.checkExpression(statement.condition, memberFns, allLocals, constParams, scopes);
            context.checkSwitchCases(statement.body, allLocals);
            inOwnScope(statement.body);
            break;
        case "continue":
            if (context.loopDepth === 0)
                context.error(`continue statement is outside a loop`, statement.span);
            break;
        case "static_assert":
            context.checkStaticAssert(statement.condition, statement.message, statement.span);
            break;
        case "return":
            if (statement.value) {
                context.checkExpression(statement.value, memberFns, allLocals, constParams, scopes);
            }
            break;
        case "expression":
            context.checkExpression(statement.expression, memberFns, allLocals, constParams, scopes);
            break;
    }
}

export function checkDeclarationStatement(context: ValidatorInternals, statement: Statement & {
    kind: "declaration";
}, scopes: Array<Map<string, {
    const: boolean;
}>>): void {
    const decl = statement.declaration;
    if (decl.kind === "function") {
        if (decl.body) {
            context.error(`function '${decl.name}' cannot be defined nested inside another function`, statement.span);
        }
        return;
    }
    if (decl.kind === "struct") {
        context.checkStruct(decl);
        return;
    }
    if (decl.kind !== "variable") {
        return;
    }
    if (isVoidType(decl.type)) {
        context.error(`variable '${decl.name}' cannot have type void`, statement.span);
    }
    if (decl.isStatic && !decl.isConstexpr) {
        context.error(`static local variable '${decl.name}' is not allowed in a contract — its lifetime would outlive the call and bypass consensus state`, statement.span);
    }
    if (decl.initializer)
        context.checkInitializerCardinality(decl.type, decl.initializer, statement.span);
    const current = scopes[scopes.length - 1];
    if (current.has(decl.name)) {
        context.error(`'${decl.name}' is already declared in this scope`, statement.span);
    }
    else if (decl.name !== "interContractCallError") {
        // Nested inter-contract calls may shadow their macro-generated error variable.
        for (let index = scopes.length - 2; index >= 0; index--) {
            if (scopes[index].has(decl.name)) {
                context.error(`'${decl.name}' shadows a declaration in an enclosing scope — locals share one slot per name, so shadowing is not supported`, statement.span);
                break;
            }
        }
    }
    current.set(decl.name, { const: isConstType(decl.type) });
}
