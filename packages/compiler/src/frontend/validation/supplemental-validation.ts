import {
    AstKind,
    BinaryOp,
    DiagnosticSeverity,
    UnaryOp,
} from "../../enums";
import type { ValidateDiagnostic } from "./validator-context";

interface SupplementalFlowContext {
    loopDepth: number;
    switchDepth: number;
    runtimeNames: Set<string>;
    initialized: Set<string>;
    labels: Map<string, {
        span: any;
        initialized: Set<string>;
    }>;
    gotos: Array<{
        label: string;
        span: any;
        initialized: Set<string>;
    }>;
}

function supplementalDiagnostic(message: string, span: any): ValidateDiagnostic {
    return { severity: DiagnosticSeverity.ERROR, message, span };
}

function isModifiableLvalue(expression: any): boolean {
    if (!expression)
        return false;
    switch (expression.kind) {
        case AstKind.IDENTIFIER:
        case AstKind.MEMBER_ACCESS:
        case AstKind.SUBSCRIPT:
            return true;
        case AstKind.PAREN:
            return isModifiableLvalue(expression.expression);
        case AstKind.UNARY_OP:
            return expression.operator === UnaryOp.DEREFERENCE;
        default:
            return false;
    }
}

function isMutableReference(type: any): boolean {
    return type?.kind === AstKind.REFERENCE && type.referentType?.kind !== AstKind.CONST;
}

function expressionUsesRuntimeName(expression: any, runtimeNames: Set<string>): boolean {
    if (!expression || typeof expression !== "object")
        return false;
    if (expression.kind === AstKind.IDENTIFIER)
        return runtimeNames.has(expression.name);
    for (const [key, value] of Object.entries(expression)) {
        if (key === "span" || key === "kind")
            continue;
        if (Array.isArray(value)) {
            if (value.some((item) => expressionUsesRuntimeName(item, runtimeNames)))
                return true;
        }
        else if (value &&
            typeof value === "object" &&
            expressionUsesRuntimeName(value, runtimeNames)) {
            return true;
        }
    }
    return false;
}

function validateSupplementalExpression(expression: any, diagnostics: ValidateDiagnostic[]): void {
    if (!expression || typeof expression !== "object")
        return;
    if (expression.kind === AstKind.ASSIGN || (expression.kind === AstKind.BINARY_OP && expression.operator === BinaryOp.ASSIGN)) {
        if (!isModifiableLvalue(expression.left)) {
            diagnostics.push(supplementalDiagnostic("assignment target is not a modifiable lvalue", expression.left?.span ?? expression.span));
        }
    }
    if ((expression.kind === AstKind.PREFIX_OP || expression.kind === AstKind.POSTFIX_OP) && !isModifiableLvalue(expression.argument)) {
        diagnostics.push(supplementalDiagnostic(`operand of '${expression.operator}' is not a modifiable lvalue`, expression.argument?.span ?? expression.span));
    }
    for (const [key, value] of Object.entries(expression)) {
        if (key === "span" || key === "kind")
            continue;
        if (Array.isArray(value)) {
            for (const item of value)
                validateSupplementalExpression(item, diagnostics);
        }
        else if (value && typeof value === "object") {
            validateSupplementalExpression(value, diagnostics);
        }
    }
}

function validateSupplementalFunction(fn: any, diagnostics: ValidateDiagnostic[]): void {
    const params = fn.params ?? fn.functionParameters ?? [];
    const context: SupplementalFlowContext = {
        loopDepth: 0,
        switchDepth: 0,
        runtimeNames: new Set(params.map((param: any) => param.name)),
        initialized: new Set(),
        labels: new Map(),
        gotos: [],
    };
    let sawDefault = false;
    for (const param of params) {
        if (param.defaultValue)
            sawDefault = true;
        else if (sawDefault) {
            diagnostics.push(supplementalDiagnostic(`parameter '${param.name}' without a default follows a parameter with a default`, param.span ?? fn.span));
        }
    }
    const walk = (statement: any, current: SupplementalFlowContext): void => {
        if (!statement)
            return;
        switch (statement.kind) {
            case AstKind.COMPOUND: {
                const scoped: SupplementalFlowContext = {
                    ...current,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                };
                for (const child of statement.body ?? [])
                    walk(child, scoped);
                return;
            }
            case AstKind.DECLARATION: {
                const declaration = statement.declaration;
                if (declaration?.kind === AstKind.VARIABLE) {
                    if (declaration.initializer)
                        validateSupplementalExpression(declaration.initializer, diagnostics);
                    if (isMutableReference(declaration.type) &&
                        declaration.initializer &&
                        !isModifiableLvalue(declaration.initializer)) {
                        diagnostics.push(supplementalDiagnostic(`mutable reference '${declaration.name}' cannot bind to a temporary`, declaration.initializer.span ?? declaration.span));
                    }
                    if (!declaration.isConstexpr)
                        current.runtimeNames.add(declaration.name);
                    if (declaration.initializer)
                        current.initialized.add(`${declaration.name}@${declaration.span?.start ?? 0}`);
                }
                return;
            }
            case AstKind.EXPRESSION:
                validateSupplementalExpression(statement.expression, diagnostics);
                return;
            case AstKind.IF:
                validateSupplementalExpression(statement.condition, diagnostics);
                walk(statement.then, {
                    ...current,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                });
                if (statement.else_)
                    walk(statement.else_, {
                        ...current,
                        runtimeNames: new Set(current.runtimeNames),
                        initialized: new Set(current.initialized),
                    });
                return;
            case AstKind.FOR: {
                const nested = {
                    ...current,
                    loopDepth: current.loopDepth + 1,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                };
                if (statement.initializer)
                    walk(statement.initializer, nested);
                validateSupplementalExpression(statement.condition, diagnostics);
                validateSupplementalExpression(statement.update, diagnostics);
                walk(statement.body, nested);
                return;
            }
            case AstKind.WHILE:
            case AstKind.DO_WHILE:
                validateSupplementalExpression(statement.condition, diagnostics);
                walk(statement.body, {
                    ...current,
                    loopDepth: current.loopDepth + 1,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                });
                return;
            case AstKind.SWITCH:
                validateSupplementalExpression(statement.condition, diagnostics);
                walk(statement.body, {
                    ...current,
                    switchDepth: current.switchDepth + 1,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                });
                return;
            case AstKind.CASE:
                if (current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("case label is only valid inside a switch", statement.span));
                }
                else if (expressionUsesRuntimeName(statement.value, current.runtimeNames)) {
                    diagnostics.push(supplementalDiagnostic("case label must be a constant expression", statement.value?.span ?? statement.span));
                }
                validateSupplementalExpression(statement.value, diagnostics);
                return;
            case AstKind.DEFAULT:
                if (current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("default label is only valid inside a switch", statement.span));
                }
                return;
            case AstKind.BREAK:
                if (current.loopDepth === 0 && current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("break is only valid inside a loop or switch", statement.span));
                }
                return;
            case AstKind.GOTO:
                current.gotos.push({
                    label: statement.label,
                    span: statement.span,
                    initialized: new Set(current.initialized),
                });
                return;
            case AstKind.LABEL:
                if (current.labels.has(statement.name)) {
                    diagnostics.push(supplementalDiagnostic(`duplicate label '${statement.name}'`, statement.span));
                }
                else {
                    current.labels.set(statement.name, {
                        span: statement.span,
                        initialized: new Set(current.initialized),
                    });
                }
                return;
            case AstKind.RETURN:
                validateSupplementalExpression(statement.value, diagnostics);
                return;
        }
    };
    if (fn.body)
        walk(fn.body, context);
    for (const jump of context.gotos) {
        const target = context.labels.get(jump.label);
        if (!target) {
            diagnostics.push(supplementalDiagnostic(`goto target '${jump.label}' is not defined`, jump.span));
            continue;
        }
        if ([...target.initialized].some((declaration) => !jump.initialized.has(declaration))) {
            diagnostics.push(supplementalDiagnostic(`goto '${jump.label}' crosses an initialized declaration`, jump.span));
        }
    }
}

export function validateSupplementalDeclarations(declarations: any[], diagnostics: ValidateDiagnostic[]): void {
    for (const declaration of declarations ?? []) {
        if (declaration.kind === AstKind.FUNCTION || declaration.kind === AstKind.FUNCTION_TEMPLATE) {
            validateSupplementalFunction(declaration, diagnostics);
        }
        if (declaration.kind === AstKind.STRUCT || declaration.kind === AstKind.CLASS_TEMPLATE) {
            validateSupplementalDeclarations(declaration.members, diagnostics);
        }
        else if (declaration.kind === AstKind.NAMESPACE || declaration.kind === AstKind.EXTERN_BLOCK) {
            validateSupplementalDeclarations(declaration.body, diagnostics);
        }
        else if (declaration.kind === AstKind.FRIEND && declaration.declaration) {
            validateSupplementalDeclarations([declaration.declaration], diagnostics);
        }
    }
}
