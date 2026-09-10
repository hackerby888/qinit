// C99/C++ block scoping, lowered onto a flat set of function locals by alpha-renaming.
// The backend allocates one wasm local per name per function, so nothing resolved names against the
// block structure; renaming a nested declaration that hides an outer name adds that missing step.
import { AstKind } from "../../shared/enums";
import type { Declaration, Expression, FunctionDecl, Statement, VariableDecl } from "../../ast";

/** One block's bindings: the name as written -> the name it was given. */
type Frame = Map<string, string>;

class FunctionScopes {
    private readonly frames: Frame[] = [new Map()];
    private counter = 0;
    constructor(
        private readonly taken: Set<string>,
        private readonly outerNames: ReadonlySet<string>,
    ) {}

    push(): void {
        this.frames.push(new Map());
    }
    pop(): void {
        this.frames.pop();
    }
    /** The name `written` currently resolves to, or null when no block in scope declares it. */
    resolve(written: string): string | null {
        for (let index = this.frames.length - 1; index >= 0; index--) {
            const bound = this.frames[index]!.get(written);
            if (bound !== undefined) return bound;
        }
        return null;
    }
    /** Whether the innermost block already binds this name — a redeclaration, not a shadow. */
    declaredHere(written: string): boolean {
        return this.frames[this.frames.length - 1]!.has(written);
    }
    /**
     * Bind `written` in the innermost block, returning the name to use. A nested declaration is renamed
     * when the name means something outside the block too, not only when it collides with another local.
     */
    declare(written: string): string {
        // Two declarations of one name in the *same* block are a redeclaration, which the validator
        // reports. Renaming the second would make the two distinct and silence that, so leave it.
        if (this.declaredHere(written)) return written;
        const hidesOuterName = this.frames.length > 1 && this.outerNames.has(written);
        const shadowsEnclosing = this.resolve(written) !== null;
        let assigned = written;
        if (hidesOuterName || shadowsEnclosing) {
            do {
                assigned = `${written}__blk${++this.counter}`;
            } while (this.taken.has(assigned));
            this.taken.add(assigned);
        }
        this.frames[this.frames.length - 1]!.set(written, assigned);
        return assigned;
    }
}

/** Every identifier the function mentions, so a generated name cannot collide with one — including a
 * global the body reads, which a bare counter suffix could otherwise shadow in turn. */
function mentionedNames(statement: Statement, into: Set<string>): void {
    walkStatement(statement, {
        onExpression: (expression) => {
            if (expression.kind === AstKind.IDENTIFIER) into.add(expression.name);
            if (expression.kind === AstKind.QUALIFIED_NAME) into.add(expression.name);
        },
        onDeclaration: (declaration) => {
            if ("name" in declaration && typeof declaration.name === "string") into.add(declaration.name);
        },
    });
}

interface Visitor {
    onExpression?: (expression: Expression) => void;
    onDeclaration?: (declaration: Declaration) => void;
}

/** A read-only walk used only to collect names; the renaming walk below is separate and scope-aware. */
function walkStatement(statement: Statement | undefined, visitor: Visitor): void {
    if (!statement) return;
    switch (statement.kind) {
        case AstKind.COMPOUND:
            for (const item of statement.body) walkStatement(item, visitor);
            break;
        case AstKind.IF:
            walkExpressionTree(statement.condition, visitor);
            walkStatement(statement.then, visitor);
            walkStatement(statement.else_, visitor);
            break;
        case AstKind.FOR:
            walkStatement(statement.initializer, visitor);
            if (statement.condition) walkExpressionTree(statement.condition, visitor);
            if (statement.update) walkExpressionTree(statement.update, visitor);
            walkStatement(statement.body, visitor);
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
            walkExpressionTree(statement.condition, visitor);
            walkStatement(statement.body, visitor);
            break;
        case AstKind.SWITCH:
            walkExpressionTree(statement.condition, visitor);
            walkStatement(statement.body, visitor);
            break;
        case AstKind.CASE:
            walkExpressionTree(statement.value, visitor);
            break;
        case AstKind.EXPRESSION:
            walkExpressionTree(statement.expression, visitor);
            break;
        case AstKind.RETURN:
            if (statement.value) walkExpressionTree(statement.value, visitor);
            break;
        case AstKind.DECLARATION:
            visitor.onDeclaration?.(statement.declaration);
            if (statement.declaration.kind === AstKind.VARIABLE && statement.declaration.initializer) {
                walkExpressionTree(statement.declaration.initializer, visitor);
            }
            break;
        case AstKind.STATIC_ASSERT:
            walkExpressionTree(statement.condition, visitor);
            break;
    }
}

function walkExpressionTree(expression: Expression | undefined, visitor: Visitor): void {
    if (!expression) return;
    visitor.onExpression?.(expression);
    for (const child of subExpressions(expression)) walkExpressionTree(child, visitor);
}

/** The sub-expressions of a node, in evaluation order. A call's callee is excluded when it is a bare
 * or qualified name: that spells a function or a type, never a local, so it must not be renamed. */
function subExpressions(expression: Expression): Expression[] {
    switch (expression.kind) {
        case AstKind.UNARY_OP:
        case AstKind.PREFIX_OP:
        case AstKind.POSTFIX_OP:
            return [expression.argument];
        case AstKind.BINARY_OP:
            return [expression.left, expression.right];
        case AstKind.ASSIGN:
            return [expression.left, expression.right];
        case AstKind.TERNARY:
            return [expression.condition, expression.then, expression.else_];
        case AstKind.MEMBER_ACCESS:
            return [expression.object];
        case AstKind.SUBSCRIPT:
            return [expression.object, expression.index];
        case AstKind.SEQUENCE:
            return expression.expressions;
        case AstKind.CALL:
            return NAME_CALLEE_KINDS.has(expression.callee.kind) ? expression.callArguments : [expression.callee, ...expression.callArguments];
        case AstKind.TEMPLATE_CALL:
            return expression.callArguments;
        case AstKind.CONSTRUCT:
            return expression.callArguments;
        case AstKind.INITIALIZER_LIST:
            return expression.expressions;
        case AstKind.C_CAST:
        case AstKind.STATIC_CAST:
        case AstKind.REINTERPRET_CAST:
            return [expression.expression];
        case AstKind.PAREN:
            return [expression.expression];
        case AstKind.SIZEOF_EXPR:
            return [expression.expression];
        default:
            return [];
    }
}

const NAME_CALLEE_KINDS: ReadonlySet<AstKind> = new Set([AstKind.IDENTIFIER, AstKind.QUALIFIED_NAME]);

/** Rewrite the identifiers in one expression against the bindings currently in scope. */
function renameExpression(expression: Expression | undefined, scopes: FunctionScopes): void {
    if (!expression) return;
    if (expression.kind === AstKind.IDENTIFIER) {
        const bound = scopes.resolve(expression.name);
        if (bound !== null && bound !== expression.name) expression.name = bound;
        return;
    }
    for (const child of subExpressions(expression)) renameExpression(child, scopes);
}

/** Resolve one statement. A block opens a scope; a declaration binds after its declarator and before
 * its initializer, which is where C++ puts the point of declaration ([basic.scope.pdecl]/1). */
function resolveStatement(statement: Statement | undefined, scopes: FunctionScopes): void {
    if (!statement) return;
    switch (statement.kind) {
        case AstKind.COMPOUND: {
            // `uint64 x = 1, y = 3;` parses as a compound marked synthetic. It is one statement, not
            // a block: opening a scope for it would put x and y out of reach of the next line.
            const opensScope = !(statement as { synthetic?: boolean }).synthetic;
            if (opensScope) scopes.push();
            for (const item of statement.body) resolveStatement(item, scopes);
            if (opensScope) scopes.pop();
            break;
        }
        case AstKind.IF:
            renameExpression(statement.condition, scopes);
            resolveStatement(statement.then, scopes);
            resolveStatement(statement.else_, scopes);
            break;
        case AstKind.FOR:
            // The init-statement's declarations belong to the loop, not to the enclosing block.
            scopes.push();
            resolveStatement(statement.initializer, scopes);
            renameExpression(statement.condition, scopes);
            renameExpression(statement.update, scopes);
            resolveStatement(statement.body, scopes);
            scopes.pop();
            break;
        case AstKind.WHILE:
        case AstKind.DO_WHILE:
            renameExpression(statement.condition, scopes);
            resolveStatement(statement.body, scopes);
            break;
        case AstKind.SWITCH:
            renameExpression(statement.condition, scopes);
            resolveStatement(statement.body, scopes);
            break;
        case AstKind.CASE:
            renameExpression(statement.value, scopes);
            break;
        case AstKind.EXPRESSION:
            renameExpression(statement.expression, scopes);
            break;
        case AstKind.RETURN:
            renameExpression(statement.value, scopes);
            break;
        case AstKind.STATIC_ASSERT:
            renameExpression(statement.condition, scopes);
            break;
        case AstKind.DECLARATION: {
            const declaration = statement.declaration;
            if (declaration.kind !== AstKind.VARIABLE) break;
            const variable = declaration as VariableDecl;
            const written = variable.name;
            variable.name = scopes.declare(written);
            // Keep the name as written. It is how the validator still reports a read of a block
            // local from outside its block — after renaming, that read no longer matches any
            // declared name and would otherwise pass silently.
            if (variable.name !== written) variable.blockScopedFrom = written;
            renameExpression(variable.initializer, scopes);
            break;
        }
    }
}

function resolveFunction(fn: FunctionDecl, outerNames: ReadonlySet<string>): void {
    if (!fn.body) return;
    const taken = new Set<string>(fn.params.map((parameter) => parameter.name));
    mentionedNames(fn.body, taken);
    const scopes = new FunctionScopes(taken, outerNames);
    // Parameters occupy the function's outermost scope, so a top-level local of the same name is
    // itself a shadow and gets renamed rather than colliding with the parameter's slot.
    for (const parameter of fn.params) scopes.declare(parameter.name);
    // The body's own compound statement is that same scope, not a nested one.
    if (fn.body.kind === AstKind.COMPOUND) for (const item of fn.body.body) resolveStatement(item, scopes);
    else resolveStatement(fn.body, scopes);
}

/** Every name declared outside a function body. A block-local declaration that reuses one of these is
 * what the flat local set cannot represent. */
function collectOuterNames(declarations: Declaration[], into: Set<string>): void {
    for (const declaration of declarations) {
        switch (declaration.kind) {
            case AstKind.VARIABLE:
            case AstKind.TYPEDEF_DECL:
                into.add(declaration.name);
                break;
            case AstKind.FUNCTION:
            case AstKind.FUNCTION_TEMPLATE:
                // The name only; a body's own locals are not visible from any other body.
                into.add(declaration.name);
                break;
            case AstKind.ENUM:
                if (declaration.name) into.add(declaration.name);
                for (const member of declaration.members) into.add(member.name);
                break;
            case AstKind.STRUCT:
            case AstKind.CLASS_TEMPLATE:
                if (declaration.name) into.add(declaration.name);
                collectOuterNames(declaration.members, into);
                break;
            case AstKind.NAMESPACE:
            case AstKind.EXTERN_BLOCK:
                collectOuterNames(declaration.body, into);
                break;
        }
    }
}

function resolveIn(declarations: Declaration[], outerNames: ReadonlySet<string>): void {
    for (const declaration of declarations) {
        switch (declaration.kind) {
            case AstKind.FUNCTION:
            case AstKind.FUNCTION_TEMPLATE:
                resolveFunction(declaration as FunctionDecl, outerNames);
                break;
            case AstKind.STRUCT:
            case AstKind.CLASS_TEMPLATE:
                resolveIn(declaration.members, outerNames);
                break;
            case AstKind.NAMESPACE:
            case AstKind.EXTERN_BLOCK:
                resolveIn(declaration.body, outerNames);
                break;
        }
    }
}

/** Resolve every function body in the translation unit, members and templates included. */
export function resolveBlockScopes(declarations: Declaration[]): void {
    const outerNames = new Set<string>();
    collectOuterNames(declarations, outerNames);
    resolveIn(declarations, outerNames);
}
