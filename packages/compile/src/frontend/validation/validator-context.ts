// Validation runs after parse and before codegen.
import type { Declaration, StructDecl, FunctionDecl, VariableDecl, Statement, Expression, TypeSpec, Span } from "../../ast";
export interface ValidateDiagnostic {
    severity: "error";
    message: string;
    span: Span;
}
export interface FnSig {
    declaration: FunctionDecl;
    minArgs: number;
    maxArgs: number;
}


export interface ValidatorInternals {
  diagnostics: ValidateDiagnostic[];
  seen: Set<string>;
  currentFn: FunctionDecl | null;
  loopDepth: number;
  constants: Map<string, bigint>;
  aggregateNames: Set<string>;
  typeAliases: Map<string, string>;
  aggregateFieldCount: Map<string, number>;
  structFields: Map<string, Map<string, TypeSpec>>;
  currentTypes: Map<string, TypeSpec>;
  currentMemberFns: Map<string, FnSig>;
  canonTypeKey(type: TypeSpec): string;
  error(message: string, span: Span | undefined): void;
  runTopLevel(declarations: Declaration[]): void;
  checkGlobalVariable(variableDeclaration: VariableDecl): void;
  checkStruct(structDeclaration: StructDecl): void;
  checkRecursion(structDeclaration: StructDecl, fnBodies: Map<string, FunctionDecl>): void;
  checkFunctionBody(fn: FunctionDecl, memberFns: Map<string, FnSig>): void;
  checkReturns(fn: FunctionDecl): void;
  guaranteesReturn(statement: Statement): boolean;
  collectEnumConstants(entry: Declaration & {
        kind: "enum";
    }): void;
  checkStaticAssert(condition: Expression, message: Expression | undefined, span: Span): void;
  walkScope(statement: Statement, fn: FunctionDecl, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
        const: boolean;
    }>>): void;
  checkDeclarationStatement(statement: Statement & {
        kind: "declaration";
    }, scopes: Array<Map<string, {
        const: boolean;
    }>>): void;
  checkInitializerCardinality(type: TypeSpec, initializer: Expression, span: Span): void;
  checkSwitchCases(body: Statement, allLocals: Set<string>): void;
  checkExpression(root: Expression, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
        const: boolean;
    }>>): void;
  checkAssignTarget(target: Expression, constParams: Set<string>, lookup: (name: string) => {
        const: boolean;
    } | null): void;
  isPublicFunctionContext(): boolean;
  isAggregateType(type: TypeSpec): boolean;
  inferSimpleType(expression: Expression): TypeSpec | null;
  isReadonlyStateExpression(expression: Expression): boolean;
  isWritableReferenceArgument(argument: Expression, constParams: Set<string>, lookup: (name: string) => {
        const: boolean;
    } | null): boolean;
  walkStatements(statement: Statement, visit: (statement: Statement) => void): void;
  walkExpressions(statement: Statement, visit: (expression: Expression) => void): void;
}
