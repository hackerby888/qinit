import { AstKind, DiagnosticSeverity } from "../../shared/enums";
// Validation runs after parse and before codegen.
import type {
    Declaration,
    StructDecl,
    FunctionDecl,
    VariableDecl,
    Statement,
    Expression,
    TypeSpec,
    Span,
} from "../../ast";
import type { FnSig, ValidateDiagnostic } from "./validator-context";
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
        return validatorPart0.canonTypeKey(this, type);
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
        return validatorPart0.runTopLevel(this, declarations);
    }
    // Reject mutable file-scope data because it lies outside consensus state.
    checkGlobalVariable(variableDeclaration: VariableDecl): void {
        return validatorPart0.checkGlobalVariable(this, variableDeclaration);
    }
    // ---- Structs ----
    checkStruct(structDeclaration: StructDecl): void {
        return validatorPart0.checkStruct(this, structDeclaration);
    }
    // Qubic contracts must have statically bounded stacks: any call cycle among a struct's member functions (direct or mutual)
    checkRecursion(structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void {
        return validatorPart1.checkRecursion(this, structDeclaration, fnBodies);
    }
    // ---- Function bodies ----
    checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void {
        return validatorPart1.checkFunctionBody(this, fn, memberFns);
    }
    checkReturns(fn: FunctionDecl): void {
        return validatorPart1.checkReturns(this, fn);
    }
    guaranteesReturn(statement: Statement): boolean {
        return validatorPart1.guaranteesReturn(this, statement);
    }
    collectEnumConstants(
        entry: Declaration & {
            kind: AstKind.ENUM;
        },
    ): void {
        return validatorPart0.collectEnumConstants(this, entry);
    }
    checkStaticAssert(condition: Expression, message: Expression | undefined, span: Span): void {
        return validatorPart0.checkStaticAssert(this, condition, message, span);
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
        return validatorPart2.walkScope(
            this,
            statement,
            fn,
            memberFns,
            allLocals,
            constParams,
            scopes,
        );
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
        return validatorPart2.checkDeclarationStatement(this, statement, scopes);
    }
    checkInitializerCardinality(type: TypeSpec, initializer: Expression, span: Span): void {
        return validatorPart3.checkInitializerCardinality(this, type, initializer, span);
    }
    checkSwitchCases(body: Statement, allLocals: Set<string>): void {
        return validatorPart4.checkSwitchCases(this, body, allLocals);
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
        return validatorPart5.checkExpression(
            this,
            root,
            memberFns,
            allLocals,
            constParams,
            scopes,
        );
    }
    // Assignment roots must be mutable; accessor results are read-only views.
    checkAssignTarget(
        target: Expression,
        constParams: Set<string>,
        lookup: (name: string) => {
            const: boolean;
        } | null,
    ): void {
        return validatorPart5.checkAssignTarget(this, target, constParams, lookup);
    }
    isPublicFunctionContext(): boolean {
        return validatorPart1.isPublicFunctionContext(this);
    }
    isAggregateType(type: TypeSpec): boolean {
        return validatorPart5.isAggregateType(this, type);
    }
    inferSimpleType(expression: Expression): TypeSpec | null {
        return validatorPart5.inferSimpleType(this, expression);
    }
    isReadonlyStateExpression(expression: Expression): boolean {
        return validatorPart5.isReadonlyStateExpression(this, expression);
    }
    isWritableReferenceArgument(
        argument: Expression,
        constParams: Set<string>,
        lookup: (name: string) => {
            const: boolean;
        } | null,
    ): boolean {
        return validatorPart5.isWritableReferenceArgument(this, argument, constParams, lookup);
    }
    // ---- Generic walkers ----
    walkStatements(statement: Statement, visit: (statement: Statement) => void): void {
        return validatorPart4.walkStatements(this, statement, visit);
    }
    walkExpressions(statement: Statement, visit: (expression: Expression) => void): void {
        return validatorPart4.walkExpressions(this, statement, visit);
    }
}
