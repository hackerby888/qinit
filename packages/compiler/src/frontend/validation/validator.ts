import { AstKind, DiagnosticSeverity } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type { Declaration, StructDecl, FunctionDecl, VariableDecl, Statement, Expression, TypeSpec, Span } from "../../ast";
import type { FnSig, ValidateDiagnostic } from "./validator-context";
import * as declarationValidator from "./declaration-validator";
import * as functionValidator from "./function-validator";
import * as scopeValidator from "./scope-validator";
import * as initializerValidator from "./initializer-validator";
import * as controlFlowValidator from "./control-flow-validator";
import * as expressionValidator from "./expression-validator";

const NO_SPAN: Span = {
    start: 0,
    end: 0,
    line: 0,
    column: 0,
};

export class Validator {
    diagnostics: ValidateDiagnostic[] = [];
    seen = new Set<string>();
    currentFn: FunctionDecl | null = null;
    loopDepth = 0;
    constants = new Map<string, bigint>();
    aggregateNames = new Set<string>(["id", "m256i", "uint128"]);
    // Map typedef aliases to canonical type names for aggregate checks.
    typeAliases = new Map<string, string>([
        ["id", "m256i"],
        ["uint128_t", "uint128"],
    ]);
    aggregateFieldCount = new Map<string, number>();
    structFields = new Map<string, Map<string, TypeSpec>>();
    currentTypes = new Map<string, TypeSpec>();
    currentMemberFns = new Map<string, FnSig>();
    canonTypeKey(type: TypeSpec): string {
        return declarationValidator.canonTypeKey(this, type);
    }
    error(message: string, span: Span | undefined): void {
        const sp = span ?? NO_SPAN;
        const key = `${message}@${sp.line}`;
        if (this.seen.has(key)) {
            return;
        }
        this.seen.add(key);
        this.diagnostics.push({ severity: DiagnosticSeverity.ERROR, message, span: sp });
    }
    // ---- Top level ----
    runTopLevel(declarations: Declaration[]): void {
        return declarationValidator.runTopLevel(this, declarations);
    }
    // Reject mutable file-scope data because it lies outside consensus state.
    checkGlobalVariable(variableDeclaration: VariableDecl): void {
        return declarationValidator.checkGlobalVariable(this, variableDeclaration);
    }
    // ---- Structs ----
    checkStruct(structDeclaration: StructDecl): void {
        return declarationValidator.checkStruct(this, structDeclaration);
    }
    // Qubic contracts must have statically bounded stacks: any call cycle among a struct's member functions (direct or mutual)
    checkRecursion(structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
        return functionValidator.checkRecursion(this, structDeclaration, fnBodies);
    }
    // ---- Function bodies ----
    checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
        return functionValidator.checkFunctionBody(this, fn, memberFns);
    }
    checkReturns(fn: FunctionDecl): void {
        return functionValidator.checkReturns(this, fn);
    }
    guaranteesReturn(statement: Statement): boolean {
        return functionValidator.guaranteesReturn(this, statement);
    }
    collectEnumConstants(
        entry: Declaration & {
            kind: AstKind.ENUM;
        },
    ): void {
        return declarationValidator.collectEnumConstants(this, entry);
    }
    checkStaticAssert(condition: Expression, message: Expression | undefined, span: Span): void {
        return declarationValidator.checkStaticAssert(this, condition, message, span);
    }
    // Resolve identifiers against an ordered stack of lexical scopes.
    walkScope(
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
        return scopeValidator.walkScope(this, statement, fn, memberFns, allLocals, constParams, scopes);
    }
    checkDeclarationStatement(
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
        return scopeValidator.checkDeclarationStatement(this, statement, scopes);
    }
    checkInitializerCardinality(type: TypeSpec, initializer: Expression, span: Span): void {
        return initializerValidator.checkInitializerCardinality(this, type, initializer, span);
    }
    checkSwitchCases(body: Statement, allLocals: Set<string>): void {
        return controlFlowValidator.checkSwitchCases(this, body, allLocals);
    }
    // ---- Expressions ----
    checkExpression(
        root: Expression,
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
        return expressionValidator.checkExpression(this, root, memberFns, allLocals, constParams, scopes);
    }
    // Assignment roots must be mutable; accessor results are read-only views.
    checkAssignTarget(
        target: Expression,
        constParams: Set<string>,
        lookup: (name: string) => {
            const: boolean;
        } | null,
    ): void {
        return expressionValidator.checkAssignTarget(this, target, constParams, lookup);
    }
    isPublicFunctionContext(): boolean {
        return functionValidator.isPublicFunctionContext(this);
    }
    isAggregateType(type: TypeSpec): boolean {
        return expressionValidator.isAggregateType(this, type);
    }
    inferSimpleType(expression: Expression): TypeSpec | null {
        return expressionValidator.inferSimpleType(this, expression);
    }
    isReadonlyStateExpression(expression: Expression): boolean {
        return expressionValidator.isReadonlyStateExpression(expression);
    }
    isWritableReferenceArgument(
        argument: Expression,
        constParams: Set<string>,
        lookup: (name: string) => {
            const: boolean;
        } | null,
    ): boolean {
        return expressionValidator.isWritableReferenceArgument(this, argument, constParams, lookup);
    }
    // ---- Generic walkers ----
    walkStatements(statement: Statement, visit: (statement: Statement) => void): void {
        return controlFlowValidator.walkStatements(this, statement, visit);
    }
    walkExpressions(statement: Statement, visit: (expression: Expression) => void): void {
        return controlFlowValidator.walkExpressions(statement, visit);
    }
}
