import { AstKind } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type { FunctionDecl, Statement } from "../../ast";
import { isVoidType, isConstType } from "./validation-helpers";
import type { Validator } from "./validator";
import type { FnSig } from "./validator-context";

export function walkScope(
    validator: Validator,
    statement: Statement,
    fn: FunctionDecl,
    memberFns: Map<string, FnSig>,
    allLocals: Set<string>,
    constParams: Set<string>,
    scopes: Array<
        Map<
            string,
            {
                const: boolean;
            }
        >
    >,
): void {
    const recurse = (statement: Statement) =>
        validator.walkScope(statement, fn, memberFns, allLocals, constParams, scopes);
    const inOwnScope = (statement: Statement, extra?: () => void) => {
        scopes.push(new Map());
        if (extra) {
            extra();
        }
        recurse(statement);
        scopes.pop();
    };
    switch (statement.kind) {
        case AstKind.COMPOUND:
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
        case AstKind.DECLARATION:
            validator.checkDeclarationStatement(statement, scopes);
            if (
                statement.declaration.kind === AstKind.VARIABLE &&
                statement.declaration.initializer
            ) {
                validator.checkExpression(
                    statement.declaration.initializer,
                    memberFns,
                    allLocals,
                    constParams,
                    scopes,
                );
            }
            break;
        case AstKind.IF:
            validator.checkExpression(
                statement.condition,
                memberFns,
                allLocals,
                constParams,
                scopes,
            );
            inOwnScope(statement.then);
            if (statement.else_) {
                inOwnScope(statement.else_);
            }
            break;
        case AstKind.FOR:
            scopes.push(new Map());
            if (statement.initializer) {
                recurse(statement.initializer);
            }
            if (statement.condition) {
                validator.checkExpression(
                    statement.condition,
                    memberFns,
                    allLocals,
                    constParams,
                    scopes,
                );
            }
            if (statement.update) {
                validator.checkExpression(
                    statement.update,
                    memberFns,
                    allLocals,
                    constParams,
                    scopes,
                );
            }
            validator.loopDepth++;
            inOwnScope(statement.body);
            validator.loopDepth--;
            scopes.pop();
            break;
        case AstKind.WHILE:
            validator.checkExpression(
                statement.condition,
                memberFns,
                allLocals,
                constParams,
                scopes,
            );
            validator.loopDepth++;
            inOwnScope(statement.body);
            validator.loopDepth--;
            break;
        case AstKind.DO_WHILE:
            validator.loopDepth++;
            inOwnScope(statement.body);
            validator.loopDepth--;
            validator.checkExpression(
                statement.condition,
                memberFns,
                allLocals,
                constParams,
                scopes,
            );
            break;
        case AstKind.SWITCH:
            validator.checkExpression(
                statement.condition,
                memberFns,
                allLocals,
                constParams,
                scopes,
            );
            validator.checkSwitchCases(statement.body, allLocals);
            inOwnScope(statement.body);
            break;
        case AstKind.CONTINUE:
            if (validator.loopDepth === 0)
                validator.error(`continue statement is outside a loop`, statement.span);
            break;
        case AstKind.STATIC_ASSERT:
            validator.checkStaticAssert(statement.condition, statement.message, statement.span);
            break;
        case AstKind.RETURN:
            if (statement.value) {
                validator.checkExpression(
                    statement.value,
                    memberFns,
                    allLocals,
                    constParams,
                    scopes,
                );
            }
            break;
        case AstKind.EXPRESSION:
            validator.checkExpression(
                statement.expression,
                memberFns,
                allLocals,
                constParams,
                scopes,
            );
            break;
    }
}

export function checkDeclarationStatement(
    validator: Validator,
    statement: Statement & {
        kind: AstKind.DECLARATION;
    },
    scopes: Array<
        Map<
            string,
            {
                const: boolean;
            }
        >
    >,
): void {
    const decl = statement.declaration;
    if (decl.kind === AstKind.FUNCTION) {
        if (decl.body) {
            validator.error(
                `function '${decl.name}' cannot be defined nested inside another function`,
                statement.span,
            );
        }
        return;
    }
    if (decl.kind === AstKind.STRUCT) {
        validator.checkStruct(decl);
        return;
    }
    if (decl.kind !== AstKind.VARIABLE) {
        return;
    }
    if (isVoidType(decl.type)) {
        validator.error(`variable '${decl.name}' cannot have type void`, statement.span);
    }
    if (decl.isStatic && !decl.isConstexpr) {
        validator.error(
            `static local variable '${decl.name}' is not allowed in a contract — its lifetime would outlive the call and bypass consensus state`,
            statement.span,
        );
    }
    if (decl.initializer)
        validator.checkInitializerCardinality(decl.type, decl.initializer, statement.span);
    const current = scopes[scopes.length - 1];
    if (current.has(decl.name)) {
        validator.error(`'${decl.name}' is already declared in this scope`, statement.span);
    } else if (decl.name !== "interContractCallError") {
        // Nested inter-contract calls may shadow their macro-generated error variable.
        for (let index = scopes.length - 2; index >= 0; index--) {
            if (scopes[index].has(decl.name)) {
                validator.error(
                    `'${decl.name}' shadows a declaration in an enclosing scope — locals share one slot per name, so shadowing is not supported`,
                    statement.span,
                );
                break;
            }
        }
    }
    current.set(decl.name, { const: isConstType(decl.type) });
}
