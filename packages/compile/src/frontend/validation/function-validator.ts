import { AstKind, ValidationVisitState } from "../../enums";
// Validation runs after parse and before codegen.
import type { StructDecl, FunctionDecl, Statement } from "../../ast";
import { unwrapType, isVoidType, isConstType, typeKey } from "./validation-helpers";
import type { FnSig, ValidatorInternals } from "./validator-context";

export function checkRecursion(context: ValidatorInternals, structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
    const edges = new Map<string, Set<string>>();
    for (const [name, fn] of fnBodies) {
        const callees = new Set<string>();
        context.walkStatements(fn.body!, (statement) => {
            context.walkExpressions(statement, (expression) => {
                if (expression.kind === AstKind.CALL) {
                    if (expression.callee.kind === AstKind.IDENTIFIER && fnBodies.has(expression.callee.name)) {
                        callees.add(expression.callee.name);
                    }
                    if (expression.callee.kind === AstKind.MEMBER_ACCESS &&
                        expression.callee.object.kind === AstKind.IDENTIFIER &&
                        expression.callee.object.name === "this" &&
                        fnBodies.has(expression.callee.member)) {
                        callees.add(expression.callee.member);
                    }
                }
            });
        });
        edges.set(name, callees);
    }
    const state = new Map<string, ValidationVisitState>();
    const visit = (name: string, path: string[]): void => {
        const st = state.get(name);
        if (st === ValidationVisitState.DONE) {
            return;
        }
        if (st === ValidationVisitState.VISITING) {
            const cycle = [...path.slice(path.indexOf(name)), name].join(" -> ");
            context.error(`recursion is not allowed in a contract: ${cycle}`, fnBodies.get(name)?.span);
            return;
        }
        state.set(name, ValidationVisitState.VISITING);
        for (const callee of edges.get(name) ?? []) {
            visit(callee, [...path, name]);
        }
        state.set(name, ValidationVisitState.DONE);
    };
    for (const name of edges.keys()) {
        visit(name, []);
    }
}

export function checkFunctionBody(context: ValidatorInternals, fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
    context.currentFn = fn;
    context.loopDepth = 0;
    context.currentMemberFns = memberFns;
    context.currentTypes = new Map(fn.params.map((parameter) => [parameter.name, parameter.type]));
    // Every local declared anywhere in the function, for classifying bare identifiers: names outside this set belong to members/parameters/constants
    const allLocals = new Set<string>();
    context.walkStatements(fn.body!, (statement) => {
        if (statement.kind === AstKind.DECLARATION && statement.declaration.kind === AstKind.VARIABLE && !statement.declaration.isMember) {
            allLocals.add(statement.declaration.name);
            context.currentTypes.set(statement.declaration.name, statement.declaration.type);
        }
    });
    context.checkReturns(fn);
    const constParams = new Set<string>();
    for (const parameter of fn.params) {
        if (isConstType(parameter.type)) {
            constParams.add(parameter.name);
        }
    }
    const scopes: Array<Map<string, {
        const: boolean;
    }>> = [new Map()];
    context.walkScope(fn.body!, fn, memberFns, allLocals, constParams, scopes);
}

export function checkReturns(context: ValidatorInternals, fn: FunctionDecl): void {
    const isVoid = isVoidType(fn.returnType);
    let valueReturns = 0;
    context.walkStatements(fn.body!, (statement) => {
        if (statement.kind !== AstKind.RETURN) {
            return;
        }
        if (statement.value && isVoid) {
            context.error(`void function '${fn.name}' cannot return a value`, statement.span);
        }
        if (statement.value) {
            valueReturns++;
            const actual = context.inferSimpleType(statement.value);
            if (context.isAggregateType(fn.returnType) && actual && !context.isAggregateType(actual)) {
                context.error(`return type is incompatible: cannot convert scalar expression to aggregate '${typeKey(fn.returnType)}'`, statement.span);
            }
            else if (actual &&
                context.isAggregateType(fn.returnType) &&
                context.isAggregateType(actual) &&
                context.canonTypeKey(actual) !== context.canonTypeKey(fn.returnType)) {
                context.error(`return type mismatch: cannot convert '${typeKey(actual)}' to '${typeKey(fn.returnType)}'`, statement.span);
            }
        }
    });
    if (!isVoid && valueReturns === 0) {
        context.error(`function '${fn.name}' must return a value`, fn.span);
    }
    else if (!isVoid && !context.guaranteesReturn(fn.body!)) {
        context.error(`non-void function '${fn.name}' has a reachable fallthrough path without a return value`, fn.span);
    }
}

export function guaranteesReturn(context: ValidatorInternals, statement: Statement): boolean {
    if (statement.kind === AstKind.RETURN)
        return true;
    if (statement.kind === AstKind.COMPOUND) {
        for (const child of statement.body)
            if (context.guaranteesReturn(child))
                return true;
        return false;
    }
    if (statement.kind === AstKind.IF)
        return !!statement.else_ && context.guaranteesReturn(statement.then) && context.guaranteesReturn(statement.else_);
    if (statement.kind === AstKind.SWITCH) {
        // A switch returns on all paths only with a default, no break, and a returning tail.
        const body = statement.body.kind === AstKind.COMPOUND ? statement.body.body : [statement.body];
        const breaksOut = (statement: Statement): boolean => {
            if (statement.kind === AstKind.BREAK)
                return true;
            if (statement.kind === AstKind.COMPOUND)
                return statement.body.some(breaksOut);
            if (statement.kind === AstKind.IF)
                return breaksOut(statement.then) || (!!statement.else_ && breaksOut(statement.else_));
            return false;
        };
        const last = body[body.length - 1];
        return (body.some((bodyItem) => bodyItem.kind === AstKind.DEFAULT) &&
            !body.some(breaksOut) &&
            !!last &&
            context.guaranteesReturn(last));
    }
    return false;
}

export function isPublicFunctionContext(context: ValidatorInternals): boolean {
    if (context.currentFn?.name === "__impl_migrate")
        return false;
    const first = context.currentFn?.params[0]?.type;
    if (!first)
        return false;
    const type = unwrapType(first);
    return type.kind === AstKind.NAME && type.name === "QpiContextFunctionCall";
}
