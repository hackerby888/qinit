// Builds the `cheats` IDL table from the AST rather than from emission, so the analyzer path — which
// never generates WAT, and which is what feeds the clang backend's IDL and both editors — produces the
// same table as a full compile.
import type { ContractCheat, ContractCheatPart } from "@qinit/proto/contract-idl";
import { AstKind, BinaryOp } from "../../../shared/enums";
import type { CallExpression } from "../calls/call-expression";
import type { Expression, FunctionDecl, Statement, TypeSpec } from "../../../ast";
import type { StructLayout } from "../../../semantics/types";
import type { PreparedContractModule } from "../module/module-analysis";
import { CHEAT_ORDINALS_PER_LINE } from "../../../driver/qpi/cheats";
import type { AbiTypeBuilder } from "./abi-type-builder";
import { collectPayloadRoots, visitStatement, type PayloadRoots } from "../module/log-call-validation";

export const CHEAT_PRINT_INTRINSIC = "__qinit_cheat_print";

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

        visitStatement(declaration.body, (statement: Statement) => {
            const call = cheatPrintCall(statement);

            if (call) {
                cheats.push(cheatFromCall(builder, entryRoots, call));
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

function cheatFromCall(builder: AbiTypeBuilder, roots: PayloadRoots, call: CallExpression): ContractCheat {
    // The macro passes the corrected line first; the rest are the user's own arguments.
    const [lineArgument, ...args] = call.callArguments;
    const line = foldCheatLine(lineArgument);

    return {
        id: line * CHEAT_ORDINALS_PER_LINE,
        line,
        parts: args.map((argument) => partFor(builder, roots, argument)),
    };
}

function partFor(builder: AbiTypeBuilder, roots: PayloadRoots, argument: Expression): ContractCheatPart {
    if (argument.kind === AstKind.STRING_LITERAL) {
        // Interned, never lowered. This is what keeps strings out of the wasm entirely.
        return { lit: argument.value };
    }

    const resolved = resolveArgumentType(roots, argument);

    return {
        type: builder.type(resolved ?? scalarUint64()),
        expr: expressionText(argument),
    };
}

// Anchored reads (`locals.x`, `input.y`, `state.get().z`) carry their declared type. Anything else —
// an rvalue such as `qpi.tick()` — travels by value, so uint64 describes the bytes on the wire.
function resolveArgumentType(roots: PayloadRoots, argument: Expression): TypeSpec | undefined {
    if (argument.kind !== AstKind.MEMBER_ACCESS) {
        return undefined;
    }

    const base = rootLayout(roots, argument.object);

    if (!base || base.fields.size === 0) {
        return undefined;
    }

    return base.fields.get(argument.member)?.type;
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
        default:
            return "?";
    }
}
