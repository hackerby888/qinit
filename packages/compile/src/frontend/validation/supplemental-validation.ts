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
    return { severity: "error", message, span };
}

function isModifiableLvalue(expression: any): boolean {
    if (!expression)
        return false;
    switch (expression.kind) {
        case "identifier":
        case "member_access":
        case "subscript":
            return true;
        case "paren":
            return isModifiableLvalue(expression.expression);
        case "unary_op":
            return expression.operator === "*";
        default:
            return false;
    }
}

function isMutableReference(type: any): boolean {
    return type?.kind === "reference" && type.referentType?.kind !== "const";
}

function expressionUsesRuntimeName(expression: any, runtimeNames: Set<string>): boolean {
    if (!expression || typeof expression !== "object")
        return false;
    if (expression.kind === "identifier")
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
    if (expression.kind === "assign" || (expression.kind === "binary_op" && expression.operator === "=")) {
        if (!isModifiableLvalue(expression.left)) {
            diagnostics.push(supplementalDiagnostic("assignment target is not a modifiable lvalue", expression.left?.span ?? expression.span));
        }
    }
    if ((expression.kind === "prefix_op" || expression.kind === "postfix_op") && !isModifiableLvalue(expression.argument)) {
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
            case "compound": {
                const scoped: SupplementalFlowContext = {
                    ...current,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                };
                for (const child of statement.body ?? [])
                    walk(child, scoped);
                return;
            }
            case "declaration": {
                const declaration = statement.declaration;
                if (declaration?.kind === "variable") {
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
            case "expression":
                validateSupplementalExpression(statement.expression, diagnostics);
                return;
            case "if":
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
            case "for": {
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
            case "while":
            case "do_while":
                validateSupplementalExpression(statement.condition, diagnostics);
                walk(statement.body, {
                    ...current,
                    loopDepth: current.loopDepth + 1,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                });
                return;
            case "switch":
                validateSupplementalExpression(statement.condition, diagnostics);
                walk(statement.body, {
                    ...current,
                    switchDepth: current.switchDepth + 1,
                    runtimeNames: new Set(current.runtimeNames),
                    initialized: new Set(current.initialized),
                });
                return;
            case "case":
                if (current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("case label is only valid inside a switch", statement.span));
                }
                else if (expressionUsesRuntimeName(statement.value, current.runtimeNames)) {
                    diagnostics.push(supplementalDiagnostic("case label must be a constant expression", statement.value?.span ?? statement.span));
                }
                validateSupplementalExpression(statement.value, diagnostics);
                return;
            case "default":
                if (current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("default label is only valid inside a switch", statement.span));
                }
                return;
            case "break":
                if (current.loopDepth === 0 && current.switchDepth === 0) {
                    diagnostics.push(supplementalDiagnostic("break is only valid inside a loop or switch", statement.span));
                }
                return;
            case "goto":
                current.gotos.push({
                    label: statement.label,
                    span: statement.span,
                    initialized: new Set(current.initialized),
                });
                return;
            case "label":
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
            case "return":
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
        if (declaration.kind === "function" || declaration.kind === "function_template") {
            validateSupplementalFunction(declaration, diagnostics);
        }
        if (declaration.kind === "struct" || declaration.kind === "class_template") {
            validateSupplementalDeclarations(declaration.members, diagnostics);
        }
        else if (declaration.kind === "namespace" || declaration.kind === "extern_block") {
            validateSupplementalDeclarations(declaration.body, diagnostics);
        }
        else if (declaration.kind === "friend" && declaration.declaration) {
            validateSupplementalDeclarations([declaration.declaration], diagnostics);
        }
    }
}
