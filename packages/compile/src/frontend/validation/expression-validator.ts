// Validation runs after parse and before codegen.
import type { Expression, TypeSpec } from "../../ast";
import { unwrapType, isConstType, isZeroLiteral, isLiteral, typeKey } from "./validation-helpers";
import type { FnSig, ValidatorInternals } from "./validator-context";

export function checkExpression(context: ValidatorInternals, root: Expression, memberFns: Map<string, FnSig>, allLocals: Set<string>, constParams: Set<string>, scopes: Array<Map<string, {
    const: boolean;
}>>): void {
    const lookup = (name: string): {
        const: boolean;
    } | null => {
        for (let index = scopes.length - 1; index >= 0; index--) {
            const hit = scopes[index].get(name);
            if (hit) {
                return hit;
            }
        }
        return null;
    };
    const walk = (expression: Expression): void => {
        switch (expression.kind) {
            case "identifier":
                if (allLocals.has(expression.name) && !lookup(expression.name)) {
                    context.error(`'${expression.name}' is used before its declaration (or outside the scope that declares it)`, expression.span);
                }
                break;
            case "assign": {
                const leftType = context.inferSimpleType(expression.left);
                const rightType = context.inferSimpleType(expression.right);
                if (leftType &&
                    rightType &&
                    context.isAggregateType(leftType) &&
                    context.isAggregateType(rightType) &&
                    context.canonTypeKey(leftType) !== context.canonTypeKey(rightType)) {
                    context.error(`incompatible aggregate assignment from '${typeKey(rightType)}' to '${typeKey(leftType)}'`, expression.span);
                }
                context.checkAssignTarget(expression.left, constParams, lookup);
                walk(expression.left);
                walk(expression.right);
                break;
            }
            case "prefix_op":
            case "postfix_op":
                context.checkAssignTarget(expression.argument, constParams, lookup);
                walk(expression.argument);
                break;
            case "unary_op":
                if (expression.operator === "&" && isLiteral(expression.argument)) {
                    context.error(`cannot take the address of a literal`, expression.span);
                }
                walk(expression.argument);
                break;
            case "binary_op":
                if ((expression.operator === "/" || expression.operator === "%") && isZeroLiteral(expression.right)) {
                    context.error(`constant division by zero`, expression.span);
                }
                walk(expression.left);
                walk(expression.right);
                break;
            case "call": {
                const name = expression.callee.kind === "identifier"
                    ? expression.callee.name
                    : expression.callee.kind === "member_access" &&
                        expression.callee.object.kind === "identifier" &&
                        expression.callee.object.name === "this"
                        ? expression.callee.member
                        : null;
                if (expression.callee.kind === "member_access") {
                    const method = expression.callee.member;
                    const object = expression.callee.object;
                    const receiverType = context.inferSimpleType(object);
                    const receiver = receiverType ? unwrapType(receiverType) : null;
                    const isArray = receiver?.kind === "template_instance" && receiver.name === "Array";
                    if (isArray && method === "set" && expression.callArguments.length !== 2) {
                        context.error(`container set expects 2 argument(s) but got ${expression.callArguments.length}`, expression.span);
                    }
                    // state.get() is a zero-argument accessor; a get call with operands is a container get.
                    if (isArray && method === "get" && expression.callArguments.length !== 1) {
                        context.error(`container get expects 1 argument but got ${expression.callArguments.length}`, expression.span);
                    }
                    if (context.isPublicFunctionContext() &&
                        object.kind === "identifier" &&
                        object.name === "state" &&
                        method === "mut") {
                        context.error(`public function is read-only and cannot call state.mut()`, expression.span);
                    }
                }
                const sig = name !== null && !lookup(name) && !allLocals.has(name)
                    ? memberFns.get(name)
                    : undefined;
                if (sig) {
                    // Native rejects a bare non-static member call from a static context (every macro-generated entry body is static) —
                    if (context.currentFn?.isStatic && !sig.declaration.isStatic) {
                        context.error(`cannot call non-static member function '${name}' from a static context — declare it static`, expression.span);
                    }
                    if (expression.callArguments.length < sig.minArgs || expression.callArguments.length > sig.maxArgs) {
                        const want = sig.minArgs === sig.maxArgs ? `${sig.maxArgs}` : `${sig.minArgs}..${sig.maxArgs}`;
                        context.error(`'${name}' expects ${want} argument(s) but got ${expression.callArguments.length}`, expression.span);
                    }
                    else {
                        // Desugar defaults: append the declaration's default expressions so codegen emits the full argument list (C++ evaluates defaults at
                        for (let sigItemIndex = expression.callArguments.length; sigItemIndex < sig.maxArgs; sigItemIndex++) {
                            expression.callArguments.push(sig.declaration.params[sigItemIndex].defaultValue!);
                        }
                    }
                    for (let index = 0; index < Math.min(expression.callArguments.length, sig.declaration.params.length); index++) {
                        const paramType = sig.declaration.params[index].type;
                        const argType = context.inferSimpleType(expression.callArguments[index]);
                        if (argType &&
                            context.isAggregateType(paramType) &&
                            context.isAggregateType(argType) &&
                            context.canonTypeKey(paramType) !== context.canonTypeKey(argType)) {
                            context.error(`argument ${index + 1} to '${name}' has incompatible aggregate type '${typeKey(argType)}'; expected '${typeKey(paramType)}'`, expression.callArguments[index].span);
                        }
                        if (paramType.kind !== "reference" || isConstType(paramType))
                            continue;
                        const argument = expression.callArguments[index];
                        if (!context.isWritableReferenceArgument(argument, constParams, lookup)) {
                            context.error(`argument ${index + 1} to '${name}' cannot bind to a non-const reference`, argument.span);
                        }
                    }
                }
                if (expression.callee.kind !== "identifier") {
                    walk(expression.callee);
                }
                for (const argument of expression.callArguments) {
                    walk(argument);
                }
                break;
            }
            case "template_call":
                for (const argument of expression.callArguments) {
                    walk(argument);
                }
                break;
            case "member_access":
                walk(expression.object);
                break;
            case "subscript":
                walk(expression.object);
                walk(expression.index);
                break;
            case "ternary":
                walk(expression.condition);
                walk(expression.then);
                walk(expression.else_);
                break;
            case "sequence":
                for (const sequenceExpression of expression.expressions) {
                    walk(sequenceExpression);
                }
                break;
            case "c_cast":
            case "static_cast":
            case "reinterpret_cast":
                walk(expression.expression);
                break;
            case "construct":
            case "initializer_list":
                for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
                    walk(itemItem);
                }
                break;
            case "sizeof_expr":
                walk(expression.expression);
                break;
        }
    };
    walk(root);
}

export function checkAssignTarget(context: ValidatorInternals, target: Expression, constParams: Set<string>, lookup: (name: string) => {
    const: boolean;
} | null): void {
    let root = target;
    while (root.kind === "member_access" || root.kind === "subscript") {
        root = root.kind === "member_access" ? root.object : root.object;
    }
    if (root.kind === "call" &&
        root.callee.kind === "member_access" &&
        root.callee.member === "get") {
        context.error(`cannot modify through get(): it returns a read-only view — use mut()`, target.span);
        return;
    }
    if (root.kind === "identifier") {
        const local = lookup(root.name);
        if (local?.const) {
            context.error(`cannot assign to const '${root.name}'`, target.span);
        }
        else if (!local && constParams.has(root.name)) {
            context.error(`cannot assign to const parameter '${root.name}'`, target.span);
        }
    }
}

export function isAggregateType(context: ValidatorInternals, type: TypeSpec): boolean {
    const unwrappedType = unwrapType(type);
    return (unwrappedType.kind === "inline_struct" ||
        unwrappedType.kind === "array" ||
        unwrappedType.kind === "template_instance" ||
        (unwrappedType.kind === "name" && context.aggregateNames.has(unwrappedType.name)));
}

export function inferSimpleType(context: ValidatorInternals, expression: Expression): TypeSpec | null {
    switch (expression.kind) {
        case "identifier":
            return context.currentTypes.get(expression.name) ?? null;
        case "int_literal":
            return { kind: "name", name: "uint64" };
        case "bool_literal":
            return { kind: "name", name: "bool" };
        case "char_literal":
            return { kind: "name", name: "int" };
        case "paren":
            return context.inferSimpleType(expression.expression);
        case "c_cast":
        case "static_cast":
        case "reinterpret_cast":
            return expression.type;
        case "construct":
            return expression.type;
        case "call": {
            const name = expression.callee.kind === "identifier" ? expression.callee.name : null;
            if (expression.callee.kind === "member_access" &&
                expression.callee.object.kind === "identifier" &&
                expression.callee.object.name === "state" &&
                (expression.callee.member === "get" || expression.callee.member === "mut")) {
                return { kind: "name", name: "StateData" };
            }
            return name ? (context.currentMemberFns.get(name)?.declaration.returnType ?? null) : null;
        }
        case "member_access": {
            const owner = context.inferSimpleType(expression.object);
            const concrete = owner ? unwrapType(owner) : null;
            return concrete?.kind === "name"
                ? (context.structFields.get(concrete.name)?.get(expression.member) ?? null)
                : null;
        }
        default:
            return null;
    }
}

export function isReadonlyStateExpression(context: ValidatorInternals, expression: Expression): boolean {
    let root = expression;
    while (root.kind === "member_access" || root.kind === "subscript")
        root = root.object;
    return (root.kind === "call" &&
        root.callee.kind === "member_access" &&
        root.callee.object.kind === "identifier" &&
        root.callee.object.name === "state" &&
        root.callee.member === "get");
}

export function isWritableReferenceArgument(context: ValidatorInternals, argument: Expression, constParams: Set<string>, lookup: (name: string) => {
    const: boolean;
} | null): boolean {
    if (context.isReadonlyStateExpression(argument))
        return false;
    if (argument.kind === "identifier") {
        const local = lookup(argument.name);
        if (local?.const || (!local && constParams.has(argument.name)))
            return false;
        return true;
    }
    return (argument.kind === "member_access" ||
        argument.kind === "subscript" ||
        (argument.kind === "unary_op" && argument.operator === "*"));
}
