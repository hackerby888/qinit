// Validation runs after parse and before codegen.
import type { Statement, Expression } from "../../ast";
import { evalIntegralConst } from "./validation-helpers";
import type { ValidatorInternals } from "./validator-context";

export function checkSwitchCases(context: ValidatorInternals, body: Statement, allLocals: Set<string>): void {
    const keys = new Set<string>();
    let defaults = 0;
    const scan = (statement: Statement): void => {
        switch (statement.kind) {
            case "case": {
                const value = evalIntegralConst(statement.value, (name) => context.constants.get(name) ?? null);
                const key = value === null ? null : `#${value}`;
                if (value === null && statement.value.kind === "identifier" && allLocals.has(statement.value.name)) {
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
            case "default":
                defaults++;
                if (defaults > 1)
                    context.error(`duplicate default label`, statement.span);
                break;
            case "compound":
                for (const bodyItem of statement.body) {
                    scan(bodyItem);
                }
                break;
            case "if":
                scan(statement.then);
                if (statement.else_) {
                    scan(statement.else_);
                }
                break;
            case "for":
            case "while":
            case "do_while":
                scan(statement.body);
                break;
        }
    };
    scan(body);
}

export function walkStatements(context: ValidatorInternals, statement: Statement, visit: (statement: Statement) => void): void {
    visit(statement);
    switch (statement.kind) {
        case "compound":
            for (const bodyItem of statement.body) {
                context.walkStatements(bodyItem, visit);
            }
            break;
        case "if":
            context.walkStatements(statement.then, visit);
            if (statement.else_) {
                context.walkStatements(statement.else_, visit);
            }
            break;
        case "for":
            if (statement.initializer) {
                context.walkStatements(statement.initializer, visit);
            }
            context.walkStatements(statement.body, visit);
            break;
        case "while":
        case "do_while":
        case "switch":
            context.walkStatements(statement.body, visit);
            break;
    }
}

export function walkExpressions(context: ValidatorInternals, statement: Statement, visit: (expression: Expression) => void): void {
    const walkE = (expression: Expression): void => {
        visit(expression);
        switch (expression.kind) {
            case "assign":
            case "binary_op":
                walkE(expression.left);
                walkE(expression.right);
                break;
            case "unary_op":
                walkE(expression.argument);
                break;
            case "prefix_op":
            case "postfix_op":
                walkE(expression.argument);
                break;
            case "ternary":
                walkE(expression.condition);
                walkE(expression.then);
                walkE(expression.else_);
                break;
            case "member_access":
                walkE(expression.object);
                break;
            case "subscript":
                walkE(expression.object);
                walkE(expression.index);
                break;
            case "call":
                walkE(expression.callee);
                for (const argument of expression.callArguments) {
                    walkE(argument);
                }
                break;
            case "template_call":
                for (const argumentCandidate of expression.callArguments) {
                    walkE(argumentCandidate);
                }
                break;
            case "sequence":
                for (const sequenceExpression of expression.expressions) {
                    walkE(sequenceExpression);
                }
                break;
            case "c_cast":
            case "static_cast":
            case "reinterpret_cast":
                walkE(expression.expression);
                break;
            case "construct":
            case "initializer_list":
                for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
                    walkE(itemItem);
                }
                break;
            case "sizeof_expr":
                walkE(expression.expression);
                break;
        }
    };
    switch (statement.kind) {
        case "expression":
            walkE(statement.expression);
            break;
        case "declaration":
            if (statement.declaration.kind === "variable" && statement.declaration.initializer) {
                walkE(statement.declaration.initializer);
            }
            break;
        case "if":
            walkE(statement.condition);
            break;
        case "for":
            if (statement.condition) {
                walkE(statement.condition);
            }
            if (statement.update) {
                walkE(statement.update);
            }
            break;
        case "while":
        case "do_while":
        case "switch":
            walkE(statement.condition);
            break;
        case "return":
            if (statement.value) {
                walkE(statement.value);
            }
            break;
        case "case":
            walkE(statement.value);
            break;
    }
}
