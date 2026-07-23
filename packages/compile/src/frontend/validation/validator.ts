import { AstKind, DiagnosticSeverity } from "../../enums";
// Validation runs after parse and before codegen.
import type { Declaration, StructDecl, FunctionDecl, VariableDecl, Statement, Expression, TypeSpec, Span } from "../../ast";
import type {
    FnSig,
    ValidateDiagnostic,
    ValidatorInternals,
} from "./validator-context";
import * as validatorPart0 from "./declaration-validator";
import * as validatorPart1 from "./function-validator";
import * as validatorPart2 from "./scope-validator";
import * as validatorPart3 from "./initializer-validator";
import * as validatorPart4 from "./control-flow-validator";
import * as validatorPart5 from "./expression-validator";

const NO_SPAN: Span = {
    start: 0,
    end: 0,
    line: 0,
    column: 0,
};

export class Validator {
    diagnostics: ValidateDiagnostic[] = [];
    private seen = new Set<string>();
    private currentFn: FunctionDecl | null = null;
    private loopDepth = 0;
    private constants = new Map<string, bigint>();
    private aggregateNames = new Set<string>(["id", "m256i", "uint128"]);
    // Map typedef aliases to canonical type names for aggregate checks.
    private typeAliases = new Map<string, string>([
        ["id", "m256i"],
        ["uint128_t", "uint128"],
    ]);
    private aggregateFieldCount = new Map<string, number>();
    private structFields = new Map<string, Map<string, TypeSpec>>();
    private currentTypes = new Map<string, TypeSpec>();
    private currentMemberFns = new Map<string, FnSig>();
    private canonTypeKey(type: TypeSpec): string {
        return validatorPart0.canonTypeKey(this as unknown as ValidatorInternals, type);
    }
    private error(message: string, span: Span | undefined): void {
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
        return validatorPart0.runTopLevel(this as unknown as ValidatorInternals, declarations);
    }
    // Reject mutable file-scope data because it lies outside consensus state.
    private checkGlobalVariable(variableDeclaration: VariableDecl): void {
        return validatorPart0.checkGlobalVariable(this as unknown as ValidatorInternals, variableDeclaration);
    }
    // ---- Structs ----
    private checkStruct(structDeclaration: StructDecl): void {
        return validatorPart0.checkStruct(this as unknown as ValidatorInternals, structDeclaration);
    }
    // Qubic contracts must have statically bounded stacks: any call cycle among a struct's member functions (direct or mutual)
    private checkRecursion(structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
        return validatorPart1.checkRecursion(this as unknown as ValidatorInternals, structDeclaration, fnBodies);
    }
    // ---- Function bodies ----
    private checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
        return validatorPart1.checkFunctionBody(this as unknown as ValidatorInternals, fn, memberFns);
    }
    private checkReturns(fn: FunctionDecl): void {
        return validatorPart1.checkReturns(this as unknown as ValidatorInternals, fn);
    }
    private guaranteesReturn(statement: Statement): boolean {
        return validatorPart1.guaranteesReturn(this as unknown as ValidatorInternals, statement);
    }
    private collectEnumConstants(entry: Declaration & {
        kind: AstKind.ENUM;
    }): void {
        return validatorPart0.collectEnumConstants(this as unknown as ValidatorInternals, entry);
    }
    private checkStaticAssert(condition: Expression, message: Expression | undefined, span: Span): void {
        return validatorPart0.checkStaticAssert(this as unknown as ValidatorInternals, condition, message, span);
    }
    // Resolve identifiers against an ordered stack of lexical scopes.
    private walkScope(statement: Statement, fn: FunctionDecl, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
        const: boolean;
    }>>): void {
        return validatorPart2.walkScope(this as unknown as ValidatorInternals, statement, fn, memberFns, allLocals, constParams, scopes);
    }
    private checkDeclarationStatement(statement: Statement & {
        kind: AstKind.DECLARATION;
    }, scopes: Array<Map<string, {
        const: boolean;
    }>>): void {
        return validatorPart2.checkDeclarationStatement(this as unknown as ValidatorInternals, statement, scopes);
    }
    private checkInitializerCardinality(type: TypeSpec, initializer: Expression, span: Span): void {
        return validatorPart3.checkInitializerCardinality(this as unknown as ValidatorInternals, type, initializer, span);
    }
    private checkSwitchCases(body: Statement, allLocals: Set<string>): void {
        return validatorPart4.checkSwitchCases(this as unknown as ValidatorInternals, body, allLocals);
    }
    // ---- Expressions ----
    private checkExpression(root: Expression, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
        const: boolean;
    }>>): void {
        return validatorPart5.checkExpression(this as unknown as ValidatorInternals, root, memberFns, allLocals, constParams, scopes);
    }
    // Assignment roots must be mutable; accessor results are read-only views.
    private checkAssignTarget(target: Expression, constParams: Set<string>, lookup: (name: string) => {
        const: boolean;
    } | null): void {
        return validatorPart5.checkAssignTarget(this as unknown as ValidatorInternals, target, constParams, lookup);
    }
    private isPublicFunctionContext(): boolean {
        return validatorPart1.isPublicFunctionContext(this as unknown as ValidatorInternals);
    }
    private isAggregateType(type: TypeSpec): boolean {
        return validatorPart5.isAggregateType(this as unknown as ValidatorInternals, type);
    }
    private inferSimpleType(expression: Expression): TypeSpec | null {
        return validatorPart5.inferSimpleType(this as unknown as ValidatorInternals, expression);
    }
    private isReadonlyStateExpression(expression: Expression): boolean {
        return validatorPart5.isReadonlyStateExpression(this as unknown as ValidatorInternals, expression);
    }
    private isWritableReferenceArgument(argument: Expression, constParams: Set<string>, lookup: (name: string) => {
        const: boolean;
    } | null): boolean {
        return validatorPart5.isWritableReferenceArgument(this as unknown as ValidatorInternals, argument, constParams, lookup);
    }
    // ---- Generic walkers ----
    private walkStatements(statement: Statement, visit: (statement: Statement) => void): void {
        return validatorPart4.walkStatements(this as unknown as ValidatorInternals, statement, visit);
    }
    private walkExpressions(statement: Statement, visit: (expression: Expression) => void): void {
        return validatorPart4.walkExpressions(this as unknown as ValidatorInternals, statement, visit);
    }
}
