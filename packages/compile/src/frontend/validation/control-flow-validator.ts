import { AstKind } from "../../enums";
// Validation runs after parse and before codegen.
import type { Statement, Expression } from "../../ast";
import { evalIntegralConst } from "./validation-helpers";
import type { ValidatorInternals } from "./validator-context";

export function checkSwitchCases(context: ValidatorInternals, body: Statement, allLocals: Set<string>): void {
    const keys = new Set<string>();
    let defaults = 0;
    const scan = (statement: Statement): void => {
        switch (statement.kind) {
            case AstKind.CASE: {
                const value = evalIntegralConst(statement.value, (name) => context.constants.get(name) ?? null);
                const key = value === null ? null : `#${value}`;
                if (value === null && statement.value.kind === AstKind.IDENTIFIER && allLocals.has(statement.value.name)) {
                    context.error(`case label must be an integral constant expression`, statement.span);
                }
                if (key !== null) {
                    if (keys.has(key)) {
                        context.error(`duplicate case label`, statement.span);
                    }
                    keys.add(key);
                }
                break;
            }
            case AstKind.DEFAULT:
                defaults++;
                if (defaults > 1)
                    context.error(`duplicate default label`, statement.span);
                break;
            case AstKind.COMPOUND:
                for (const bodyItem of statement.body) {
                    scan(bodyItem);
                }
                break;
            case AstKind.IF:
                scan(statement.then);
                if (statement.else_) {
                    scan(statement.else_);
                }
                break;
            case AstKind.FOR:
            case AstKind.WHILE:
            case AstKind.DO_WHILE:
                scan(statement.body);
                break;
        }
    };
    scan(body);
}

export function walkStatements(context: ValidatorInternals, statement: Statement, visit: (statement: Statement) => void): void {
    visit(statement);
    switch (statement.kind) {
        case AstKind.COMPOUND:
            for (const bodyItem of statement.body) {
                context.walkStatements(bodyItem, visit);
            }
            break;
        case AstKind.IF:
            context.walkStatements(statement.then, visit);
            if (statement.else_) {
                context.walkStatements(statement.else_, visit);
            }
            break;
        case AstKind.FOR:
            if (statement.initializer) {
                context.walkStatements(statement.initializer, visit);
            }
            context.walkStatements(statement.body, visit);
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            context.walkStatements(statement.body, visit);
            break;
    }
}

export function walkExpressions(context: ValidatorInternals, statement: Statement, visit: (expression: Expression) => void): void {
    const walkE = (expression: Expression): void => {
        visit(expression);
        switch (expression.kind) {
            case AstKind.ASSIGN:
            case AstKind.BINARY_OP:
                walkE(expression.left);
                walkE(expression.right);
                break;
            case AstKind.UNARY_OP:
                walkE(expression.argument);
                break;
            case AstKind.PREFIX_OP:
            case AstKind.POSTFIX_OP:
                walkE(expression.argument);
                break;
            case AstKind.TERNARY:
                walkE(expression.condition);
                walkE(expression.then);
                walkE(expression.else_);
                break;
            case AstKind.MEMBER_ACCESS:
                walkE(expression.object);
                break;
            case AstKind.SUBSCRIPT:
                walkE(expression.object);
                walkE(expression.index);
                break;
            case AstKind.CALL:
                walkE(expression.callee);
                for (const argument of expression.callArguments) {
                    walkE(argument);
                }
                break;
            case AstKind.TEMPLATE_CALL:
                for (const argumentCandidate of expression.callArguments) {
                    walkE(argumentCandidate);
                }
                break;
            case AstKind.SEQUENCE:
                for (const sequenceExpression of expression.expressions) {
                    walkE(sequenceExpression);
                }
                break;
            case AstKind.C_CAST:
            case AstKind.STATIC_CAST:
            case AstKind.REINTERPRET_CAST:
                walkE(expression.expression);
                break;
            case AstKind.CONSTRUCT:
            case AstKind.INITIALIZER_LIST:
                for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
                    walkE(itemItem);
                }
                break;
            case AstKind.SIZEOF_EXPR:
                walkE(expression.expression);
                break;
        }
    };
    switch (statement.kind) {
        case AstKind.EXPRESSION:
            walkE(statement.expression);
            break;
        case AstKind.DECLARATION:
            if (statement.declaration.kind === AstKind.VARIABLE && statement.declaration.initializer) {
                walkE(statement.declaration.initializer);
            }
            break;
        case AstKind.IF:
            walkE(statement.condition);
            break;
        case AstKind.FOR:
            if (statement.condition) {
                walkE(statement.condition);
            }
            if (statement.update) {
                walkE(statement.update);
            }
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
        case AstKind.SWITCH:
            walkE(statement.condition);
            break;
        case AstKind.RETURN:
            if (statement.value) {
                walkE(statement.value);
            }
            break;
        case AstKind.CASE:
            walkE(statement.value);
            break;
    }
}
