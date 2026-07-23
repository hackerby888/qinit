import { AstKind, BinaryOp, UnaryOp } from "../../enums";
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
            case AstKind.IDENTIFIER:
                if (allLocals.has(expression.name) && !lookup(expression.name)) {
                    context.error(`'${expression.name}' is used before its declaration (or outside the scope that declares it)`, expression.span);
                }
                break;
            case AstKind.ASSIGN: {
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
            case AstKind.PREFIX_OP:
            case AstKind.POSTFIX_OP:
                context.checkAssignTarget(expression.argument, constParams, lookup);
                walk(expression.argument);
                break;
            case AstKind.UNARY_OP:
                if (expression.operator === UnaryOp.ADDRESS_OF && isLiteral(expression.argument)) {
                    context.error(`cannot take the address of a literal`, expression.span);
                }
                walk(expression.argument);
                break;
            case AstKind.BINARY_OP:
                if ((expression.operator === BinaryOp.DIVIDE || expression.operator === BinaryOp.MODULO) && isZeroLiteral(expression.right)) {
                    context.error(`constant division by zero`, expression.span);
                }
                walk(expression.left);
                walk(expression.right);
                break;
            case AstKind.CALL: {
                const name = expression.callee.kind === AstKind.IDENTIFIER
                    ? expression.callee.name
                    : expression.callee.kind === AstKind.MEMBER_ACCESS &&
                        expression.callee.object.kind === AstKind.IDENTIFIER &&
                        expression.callee.object.name === "this"
                        ? expression.callee.member
                        : null;
                if (expression.callee.kind === AstKind.MEMBER_ACCESS) {
                    const method = expression.callee.member;
                    const object = expression.callee.object;
                    const receiverType = context.inferSimpleType(object);
                    const receiver = receiverType ? unwrapType(receiverType) : null;
                    const isArray = receiver?.kind === AstKind.TEMPLATE_INSTANCE && receiver.name === "Array";
                    if (isArray && method === "set" && expression.callArguments.length !== 2) {
                        context.error(`container set expects 2 argument(s) but got ${expression.callArguments.length}`, expression.span);
                    }
                    // state.get() is a zero-argument accessor; a get call with operands is a container get.
                    if (isArray && method === "get" && expression.callArguments.length !== 1) {
                        context.error(`container get expects 1 argument but got ${expression.callArguments.length}`, expression.span);
                    }
                    if (context.isPublicFunctionContext() &&
                        object.kind === AstKind.IDENTIFIER &&
                        object.name === "state" &&
                        method === "mut") {
                        context.error(`public function is read-only and cannot call state.mut()`, expression.span);
                    }
                }
                const sig = name !== null && !lookup(name) && !allLocals.has(name)
                    ? memberFns.get(name)
                    : undefined;
                if (sig) {
                    // Entry bodies are static, so reject bare non-static member calls.
                    if (context.currentFn?.isStatic && !sig.declaration.isStatic) {
                        context.error(`cannot call non-static member function '${name}' from a static context — declare it static`, expression.span);
                    }
                    if (expression.callArguments.length < sig.minArgs || expression.callArguments.length > sig.maxArgs) {
                        const want = sig.minArgs === sig.maxArgs ? `${sig.maxArgs}` : `${sig.minArgs}..${sig.maxArgs}`;
                        context.error(`'${name}' expects ${want} argument(s) but got ${expression.callArguments.length}`, expression.span);
                    }
                    else {
                        // Append default arguments so codegen sees the complete call.
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
                        if (paramType.kind !== AstKind.REFERENCE || isConstType(paramType))
                            continue;
                        const argument = expression.callArguments[index];
                        if (!context.isWritableReferenceArgument(argument, constParams, lookup)) {
                            context.error(`argument ${index + 1} to '${name}' cannot bind to a non-const reference`, argument.span);
                        }
                    }
                }
                if (expression.callee.kind !== AstKind.IDENTIFIER) {
                    walk(expression.callee);
                }
                for (const argument of expression.callArguments) {
                    walk(argument);
                }
                break;
            }
            case AstKind.TEMPLATE_CALL:
                for (const argument of expression.callArguments) {
                    walk(argument);
                }
                break;
            case AstKind.MEMBER_ACCESS:
                walk(expression.object);
                break;
            case AstKind.SUBSCRIPT:
                walk(expression.object);
                walk(expression.index);
                break;
            case AstKind.TERNARY:
                walk(expression.condition);
                walk(expression.then);
                walk(expression.else_);
                break;
            case AstKind.SEQUENCE:
                for (const sequenceExpression of expression.expressions) {
                    walk(sequenceExpression);
                }
                break;
            case AstKind.C_CAST:
            case AstKind.STATIC_CAST:
            case AstKind.REINTERPRET_CAST:
                walk(expression.expression);
                break;
            case AstKind.CONSTRUCT:
            case AstKind.INITIALIZER_LIST:
                for (const itemItem of (expression as any).callArguments ?? (expression as any).expressions ?? []) {
                    walk(itemItem);
                }
                break;
            case AstKind.SIZEOF_EXPR:
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
    while (root.kind === AstKind.MEMBER_ACCESS || root.kind === AstKind.SUBSCRIPT) {
        root = root.kind === AstKind.MEMBER_ACCESS ? root.object : root.object;
    }
    if (root.kind === AstKind.CALL &&
        root.callee.kind === AstKind.MEMBER_ACCESS &&
        root.callee.member === "get") {
        context.error(`cannot modify through get(): it returns a read-only view — use mut()`, target.span);
        return;
    }
    if (root.kind === AstKind.IDENTIFIER) {
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
    return (unwrappedType.kind === AstKind.INLINE_STRUCT ||
        unwrappedType.kind === AstKind.ARRAY ||
        unwrappedType.kind === AstKind.TEMPLATE_INSTANCE ||
        (unwrappedType.kind === AstKind.NAME && context.aggregateNames.has(unwrappedType.name)));
}

export function inferSimpleType(context: ValidatorInternals, expression: Expression): TypeSpec | null {
    switch (expression.kind) {
        case AstKind.IDENTIFIER:
            return context.currentTypes.get(expression.name) ?? null;
        case AstKind.INT_LITERAL:
            return { kind: AstKind.NAME, name: "uint64" };
        case AstKind.BOOL_LITERAL:
            return { kind: AstKind.NAME, name: "bool" };
        case AstKind.CHAR_LITERAL:
            return { kind: AstKind.NAME, name: "int" };
        case AstKind.PAREN:
            return context.inferSimpleType(expression.expression);
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
        case AstKind.REINTERPRET_CAST:
            return expression.type;
        case AstKind.CONSTRUCT:
            return expression.type;
        case AstKind.CALL: {
            const name = expression.callee.kind === AstKind.IDENTIFIER ? expression.callee.name : null;
            if (expression.callee.kind === AstKind.MEMBER_ACCESS &&
                expression.callee.object.kind === AstKind.IDENTIFIER &&
                expression.callee.object.name === "state" &&
                (expression.callee.member === "get" || expression.callee.member === "mut")) {
                return { kind: AstKind.NAME, name: "StateData" };
            }
            return name ? (context.currentMemberFns.get(name)?.declaration.returnType ?? null) : null;
        }
        case AstKind.MEMBER_ACCESS: {
            const owner = context.inferSimpleType(expression.object);
            const concrete = owner ? unwrapType(owner) : null;
            return concrete?.kind === AstKind.NAME
                ? (context.structFields.get(concrete.name)?.get(expression.member) ?? null)
                : null;
        }
        default:
            return null;
    }
}

export function isReadonlyStateExpression(context: ValidatorInternals, expression: Expression): boolean {
    let root = expression;
    while (root.kind === AstKind.MEMBER_ACCESS || root.kind === AstKind.SUBSCRIPT)
        root = root.object;
    return (root.kind === AstKind.CALL &&
        root.callee.kind === AstKind.MEMBER_ACCESS &&
        root.callee.object.kind === AstKind.IDENTIFIER &&
        root.callee.object.name === "state" &&
        root.callee.member === "get");
}

export function isWritableReferenceArgument(context: ValidatorInternals, argument: Expression, constParams: Set<string>, lookup: (name: string) => {
    const: boolean;
} | null): boolean {
    if (context.isReadonlyStateExpression(argument))
        return false;
    if (argument.kind === AstKind.IDENTIFIER) {
        const local = lookup(argument.name);
        if (local?.const || (!local && constParams.has(argument.name)))
            return false;
        return true;
    }
    return (argument.kind === AstKind.MEMBER_ACCESS ||
        argument.kind === AstKind.SUBSCRIPT ||
        (argument.kind === AstKind.UNARY_OP && argument.operator === UnaryOp.DEREFERENCE));
}
