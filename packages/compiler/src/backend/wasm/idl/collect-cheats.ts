// Builds the `cheats` IDL table from the AST rather than from emission, so the analyzer path — which
// never generates WAT, and which is what feeds the clang backend's IDL and both editors — produces the
// same table as a full compile.
import type { AbiType, ContractCheat, ContractCheatPart } from "@qinit/proto/contract-idl";
import { AstKind, BinaryOp } from "../../../shared/enums";
import type { CallExpression } from "../calls/call-expression";
import type { Expression, FunctionDecl, Statement, TypeSpec } from "../../../ast";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import { EMPTY_TEMPLATE_BINDINGS, type StructLayout } from "../../../semantics/types";
import type { PreparedContractModule } from "../module/module-analysis";
import type { AbiTypeBuilder } from "./abi-type-builder";
import { collectPayloadRoots, visitStatement, type PayloadRoots } from "../module/log-call-validation";
import { stripPtrRefConst } from "../memory/address-resolution";

export const CHEAT_PRINT_INTRINSIC = "__qinit_cheat_print";

// Where each payload root sits in an entry's parameter list: (qpi, state, input, output, locals).
const ROOT_PARAMETER: Record<string, number> = { input: 2, output: 3, locals: 4 };

const ARRAY_TEMPLATES = new Set(["Array", "SlowAnySizeArray"]);

interface CheatScope {
    programAnalysis: ProgramAnalysis;
    builder: AbiTypeBuilder;
    roots: PayloadRoots;
    declaration: FunctionDecl;
}

export function collectContractCheats(prepared: PreparedContractModule, builder: AbiTypeBuilder): ContractCheat[] {
    const cheats: ContractCheat[] = [];
    const roots = collectPayloadRoots(prepared);

    if (!prepared.contract) {
        return cheats;
    }

    for (const member of prepared.contract.members) {
        if (member.kind !== AstKind.FUNCTION) {
            continue;
        }

        const declaration = member as FunctionDecl;
        const entryRoots = roots.get(declaration.name);

        if (!entryRoots || !declaration.body) {
            continue;
        }

        const scope: CheatScope = { programAnalysis: prepared.programAnalysis, builder, roots: entryRoots, declaration };

        visitStatement(declaration.body, (statement: Statement) => {
            const call = cheatPrintCall(statement);

            if (call) {
                cheats.push(cheatFromCall(scope, call));
            }
        });
    }

    return cheats;
}

function cheatPrintCall(statement: Statement): CallExpression | undefined {
    if (statement.kind !== AstKind.EXPRESSION) {
        return undefined;
    }

    const call = statement.expression;

    if (call.kind !== AstKind.CALL || call.callee.kind !== AstKind.IDENTIFIER || call.callee.name !== CHEAT_PRINT_INTRINSIC) {
        return undefined;
    }

    return call as CallExpression;
}

function cheatFromCall(scope: CheatScope, call: CallExpression): ContractCheat {
    // The macro passes the corrected line first; the rest are the user's own arguments.
    const [lineArgument, ...args] = call.callArguments;
    const line = foldCheatLine(lineArgument);

    return {
        id: line,
        line,
        parts: args.map((argument) => partFor(scope, argument)),
    };
}

function partFor(scope: CheatScope, argument: Expression): ContractCheatPart {
    if (argument.kind === AstKind.STRING_LITERAL) {
        // Interned, never lowered. This is what keeps strings out of the wasm entirely.
        return { lit: argument.value };
    }

    return {
        type: partType(scope, argument) ?? scope.builder.type(scalarUint64()),
        expr: expressionText(argument),
    };
}

// The type must describe exactly the bytes the emitter ships, which is the layout of whatever the
// argument addresses. An rvalue has no address and travels by register, so uint64 describes it.
function partType(scope: CheatScope, argument: Expression): AbiType | undefined {
    const root = rootLayout(scope.roots, argument);

    if (root) {
        return scope.builder.namedStruct(rootName(scope.declaration, argument), root, false);
    }

    const resolved = argumentType(scope, argument);

    return resolved && resolved.kind !== AstKind.VOID ? scope.builder.type(resolved) : undefined;
}

function argumentType(scope: CheatScope, expression: Expression): TypeSpec | undefined {
    if (expression.kind === AstKind.PAREN) {
        return argumentType(scope, expression.expression);
    }

    if (expression.kind === AstKind.MEMBER_ACCESS) {
        const root = rootLayout(scope.roots, expression.object);

        if (root) {
            return root.fields.get(expression.member)?.type;
        }

        const parent = argumentType(scope, expression.object);

        return parent ? (scope.programAnalysis.fieldOf(parent, expression.member)?.type ?? undefined) : undefined;
    }

    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.MEMBER_ACCESS) {
        const { object, member } = expression.callee;

        if (object.kind === AstKind.IDENTIFIER && object.name === "qpi") {
            return qpiReturnType(scope, member);
        }

        // `Array<T, N>::get(i)` hands back one element by reference, so the element's bytes ship.
        if (member === "get" && !rootLayout(scope.roots, object)) {
            const owner = argumentType(scope, object);
            const resolved = owner ? scope.programAnalysis.resolveType(owner, EMPTY_TEMPLATE_BINDINGS) : undefined;

            if (resolved?.kind === AstKind.TEMPLATE_INSTANCE && ARRAY_TEMPLATES.has(resolved.name)) {
                return resolved.callArguments[0];
            }
        }
    }

    return undefined;
}

// `qpi.<method>()` carries the return type the context declares, searched through its bases the way
// the address emitter binds the call.
function qpiReturnType(scope: CheatScope, method: string): TypeSpec | undefined {
    const contextParameter = scope.declaration.params[0];

    if (!contextParameter) {
        return undefined;
    }

    const context = scope.programAnalysis.derefType(stripPtrRefConst(contextParameter.type));

    if (context.kind !== AstKind.NAME) {
        return undefined;
    }

    for (const owner of scope.programAnalysis.methodOwnerNames(context.name)) {
        const struct = scope.programAnalysis.structOf({ kind: AstKind.NAME, name: owner });
        const found = struct?.members.find((candidate): candidate is FunctionDecl => candidate.kind === AstKind.FUNCTION && candidate.name === method);

        if (found) {
            return stripPtrRefConst(found.returnType);
        }
    }

    return undefined;
}

// The struct's own name, when the entry's parameter spells one, so the IDL reads `Get_input`.
function rootName(declaration: FunctionDecl, expression: Expression): string | undefined {
    if (expression.kind !== AstKind.IDENTIFIER) {
        return undefined;
    }

    const parameter = declaration.params[ROOT_PARAMETER[expression.name]];
    const type = parameter ? stripPtrRefConst(parameter.type) : undefined;

    return type?.kind === AstKind.NAME ? type.name : undefined;
}

function rootLayout(roots: PayloadRoots, expression: Expression): StructLayout | undefined {
    if (expression.kind === AstKind.IDENTIFIER) {
        switch (expression.name) {
            case "locals":
                return roots.locals;
            case "input":
                return roots.input;
            case "output":
                return roots.output;
            default:
                return undefined;
        }
    }

    // `state.get()` and `state.mut()` both hand back the state struct.
    if (expression.kind === AstKind.CALL && expression.callee.kind === AstKind.MEMBER_ACCESS) {
        const receiver = expression.callee.object;
        const accessor = expression.callee.member;

        if (receiver.kind === AstKind.IDENTIFIER && receiver.name === "state" && (accessor === "get" || accessor === "mut")) {
            return roots.state;
        }
    }

    return undefined;
}

// `__LINE__ - QINIT_CC_LINE_BASE` reaches the AST unfolded, because the preprocessor substitutes text
// rather than evaluating it. Both users of the id fold it the same way so their ordinals line up.
export function foldCheatLine(argument: Expression | undefined): number {
    if (!argument) {
        return 0;
    }

    if (argument.kind === AstKind.INT_LITERAL) {
        return Number(argument.value);
    }

    if (argument.kind === AstKind.PAREN) {
        return foldCheatLine(argument.expression);
    }

    if (argument.kind === AstKind.BINARY_OP && argument.operator === BinaryOp.SUBTRACT) {
        return foldCheatLine(argument.left) - foldCheatLine(argument.right);
    }

    return 0;
}

function scalarUint64(): TypeSpec {
    return { kind: AstKind.NAME, name: "uint64" } as TypeSpec;
}

// The label a reader sees next to the value. Rendered from the AST so the analyzer path, which never
// holds the user's source text, produces the same label as a full compile.
function expressionText(expression: Expression): string {
    switch (expression.kind) {
        case AstKind.IDENTIFIER:
            return expression.name;
        case AstKind.INT_LITERAL:
            return String(expression.value);
        case AstKind.MEMBER_ACCESS:
            return `${expressionText(expression.object)}.${expression.member}`;
        case AstKind.CALL:
            return `${expressionText(expression.callee)}(${expression.callArguments.map(expressionText).join(", ")})`;
        case AstKind.SUBSCRIPT:
            return `${expressionText(expression.object)}[${expressionText(expression.index)}]`;
        case AstKind.PAREN:
            return `(${expressionText(expression.expression)})`;
        case AstKind.BINARY_OP:
            return `${expressionText(expression.left)} ${expression.operator} ${expressionText(expression.right)}`;
        case AstKind.UNARY_OP:
            return `${expression.operator}${expressionText(expression.argument)}`;
        default:
            return "?";
    }
}
