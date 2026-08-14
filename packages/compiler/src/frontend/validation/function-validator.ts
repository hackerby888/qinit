import { AstKind, ValidationVisitState } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type { StructDecl, FunctionDecl, Statement } from "../../ast";
import { unwrapType, isVoidType, isConstType, typeKey } from "./validation-helpers";
import type { Validator } from "./validator";
import type { FnSig } from "./validator-context";

export function checkRecursion(
    validator: Validator,
    _structDeclaration: StructDecl,
    fnBodies: Map<string, FunctionDecl>,
): void {
    const edges = new Map<string, Set<string>>();
    for (const [name, fn] of fnBodies) {
        const callees = new Set<string>();
        validator.walkStatements(fn.body!, (statement) => {
            validator.walkExpressions(statement, (expression) => {
                if (expression.kind === AstKind.CALL) {
                    if (
                        expression.callee.kind === AstKind.IDENTIFIER &&
                        fnBodies.has(expression.callee.name)
                    ) {
                        callees.add(expression.callee.name);
                    }
                    if (
                        expression.callee.kind === AstKind.MEMBER_ACCESS &&
                        expression.callee.object.kind === AstKind.IDENTIFIER &&
                        expression.callee.object.name === "this" &&
                        fnBodies.has(expression.callee.member)
                    ) {
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
            validator.error(
                `recursion is not allowed in a contract: ${cycle}`,
                fnBodies.get(name)?.span,
            );
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

export function checkFunctionBody(
    validator: Validator,
    fn: FunctionDecl,
    memberFns: Map<string, FnSig>,
): void {
    validator.currentFn = fn;
    validator.loopDepth = 0;
    validator.currentMemberFns = memberFns;
    validator.currentTypes = new Map(
        fn.params.map((parameter) => [parameter.name, parameter.type]),
    );
    // Every local declared anywhere in the function, for classifying bare identifiers: names outside this set belong to members/parameters/constants
    const allLocals = new Set<string>();
    validator.walkStatements(fn.body!, (statement) => {
        if (
            statement.kind === AstKind.DECLARATION &&
            statement.declaration.kind === AstKind.VARIABLE &&
            !statement.declaration.isMember
        ) {
            allLocals.add(statement.declaration.name);
            validator.currentTypes.set(statement.declaration.name, statement.declaration.type);
        }
    });
    validator.checkReturns(fn);
    const constParams = new Set<string>();
    for (const parameter of fn.params) {
        if (isConstType(parameter.type)) {
            constParams.add(parameter.name);
        }
    }
    const scopes: Array<
        Map<
            string,
            {
                const: boolean;
            }
        >
    > = [new Map()];
    validator.walkScope(fn.body!, fn, memberFns, allLocals, constParams, scopes);
}

export function checkReturns(validator: Validator, fn: FunctionDecl): void {
    const isVoid = isVoidType(fn.returnType);
    let valueReturns = 0;
    validator.walkStatements(fn.body!, (statement) => {
        if (statement.kind !== AstKind.RETURN) {
            return;
        }
        if (statement.value && isVoid) {
            validator.error(`void function '${fn.name}' cannot return a value`, statement.span);
        }
        if (statement.value) {
            valueReturns++;
            const actual = validator.inferSimpleType(statement.value);
            if (
                validator.isAggregateType(fn.returnType) &&
                actual &&
                !validator.isAggregateType(actual)
            ) {
                validator.error(
                    `return type is incompatible: cannot convert scalar expression to aggregate '${typeKey(fn.returnType)}'`,
                    statement.span,
                );
            } else if (
                actual &&
                validator.isAggregateType(fn.returnType) &&
                validator.isAggregateType(actual) &&
                validator.canonTypeKey(actual) !== validator.canonTypeKey(fn.returnType)
            ) {
                validator.error(
                    `return type mismatch: cannot convert '${typeKey(actual)}' to '${typeKey(fn.returnType)}'`,
                    statement.span,
                );
            }
        }
    });
    if (!isVoid && valueReturns === 0) {
        validator.error(`function '${fn.name}' must return a value`, fn.span);
    } else if (!isVoid && !validator.guaranteesReturn(fn.body!)) {
        validator.error(
            `non-void function '${fn.name}' has a reachable fallthrough path without a return value`,
            fn.span,
        );
    }
}

export function guaranteesReturn(validator: Validator, statement: Statement): boolean {
    if (statement.kind === AstKind.RETURN) return true;
    if (statement.kind === AstKind.COMPOUND) {
        for (const child of statement.body) if (validator.guaranteesReturn(child)) return true;
        return false;
    }
    if (statement.kind === AstKind.IF)
        return (
            !!statement.else_ &&
            validator.guaranteesReturn(statement.then) &&
            validator.guaranteesReturn(statement.else_)
        );
    if (statement.kind === AstKind.SWITCH) {
        // A switch returns on all paths only with a default, no break, and a returning tail.
        const body =
            statement.body.kind === AstKind.COMPOUND ? statement.body.body : [statement.body];
        const breaksOut = (statement: Statement): boolean => {
            if (statement.kind === AstKind.BREAK) return true;
            if (statement.kind === AstKind.COMPOUND) return statement.body.some(breaksOut);
            if (statement.kind === AstKind.IF)
                return (
                    breaksOut(statement.then) || (!!statement.else_ && breaksOut(statement.else_))
                );
            return false;
        };
        const last = body[body.length - 1];
        return (
            body.some((bodyItem) => bodyItem.kind === AstKind.DEFAULT) &&
            !body.some(breaksOut) &&
            !!last &&
            validator.guaranteesReturn(last)
        );
    }
    return false;
}

export function isPublicFunctionContext(validator: Validator): boolean {
    if (validator.currentFn?.name === "__impl_migrate") return false;
    const first = validator.currentFn?.params[0]?.type;
    if (!first) return false;
    const type = unwrapType(first);
    return type.kind === AstKind.NAME && type.name === "QpiContextFunctionCall";
}
