import { AstKind, ContainerEmissionMode, WatNodeType } from "../../../shared/enums";
import { addrIr } from "../memory/memory-operations";
import { isUint128 } from "../memory/address-resolution";
import { EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { FunctionEmissionContext } from "../types";
import type { Expression, FunctionDecl, Statement, VariableDecl } from "../../../ast";
import * as watIr from "../wat-ir";
import { isProxyAliasLocal } from "../qpi-names";

type DeclarationStatement = Extract<Statement, { kind: AstKind.DECLARATION }>;

// Locals need storage decided before their initializer runs: scratchpads and iterators take arena slots,
// containers and structs bind a base address, and plain scalars just take the narrowed initializer.
export function emitDeclarationStatement(context: FunctionEmissionContext, statement: DeclarationStatement): void {
    if (statement.declaration.kind === AstKind.VARIABLE) {
        const variableDeclaration = statement.declaration as VariableDecl;
        // Keep initializer classification consistent with the pre-scanned local type.
        const declared = context.localVars.get(variableDeclaration.name)?.type ?? variableDeclaration.type;
        // Allocate scratchpad storage from the arena and retain its base address.
        if (variableDeclaration.type.kind === AstKind.NAME && /ScopedScratchpad$/.test(variableDeclaration.type.name)) {
            const callArguments =
                variableDeclaration.initializer &&
                (variableDeclaration.initializer.kind === AstKind.CONSTRUCT || variableDeclaration.initializer.kind === AstKind.CALL)
                    ? variableDeclaration.initializer.callArguments
                    : [];
            const size = callArguments[0] ? context.lowering.lowerValueExpression(context, callArguments[0]) : watIr.i64Constant(0);
            const initZero = callArguments[1]
                ? watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, callArguments[1]))
                : watIr.i32Constant(0);
            context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$acquireScratchpad", size, initZero))}`);
            (context.scratchpadLocals ??= new Set()).add(variableDeclaration.name);
            (context.scratchpadScope ??= []).push(variableDeclaration.name);
            return;
        }
        // Track asset iterators so their methods use the iterator buffer.
        if (variableDeclaration.type.kind === AstKind.NAME && /Asset(Ownership|Possession)Iterator$/.test(variableDeclaration.type.name)) {
            context.lines.push(
                `    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(8)))}`,
            );
            (context.refLocals ??= new Map()).set(variableDeclaration.name, variableDeclaration.type);
            const argument =
                variableDeclaration.initializer &&
                (variableDeclaration.initializer.kind === AstKind.CONSTRUCT || variableDeclaration.initializer.kind === AstKind.CALL)
                    ? variableDeclaration.initializer.callArguments[0]
                    : undefined;
            if (argument) {
                context.lowering.emitAssetIter(
                    context,
                    {
                        kind: AstKind.CALL,
                        span: statement.span,
                        callArguments: [argument],
                        callee: {
                            kind: AstKind.MEMBER_ACCESS,
                            span: statement.span,
                            object: {
                                kind: AstKind.IDENTIFIER,
                                name: variableDeclaration.name,
                                span: statement.span,
                            },
                            member: "begin",
                        },
                    } as Expression & {
                        kind: AstKind.CALL;
                    },
                    ContainerEmissionMode.STATEMENT,
                );
            }
            return;
        }
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it resolves through that address.
        if (declared.kind === AstKind.REFERENCE || declared.kind === AstKind.POINTER) {
            // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
            if (context.proxyClass && isProxyAliasLocal(variableDeclaration.name)) return;
            if (variableDeclaration.initializer) {
                const node = context.lowering.resolveExpressionAddress(context, variableDeclaration.initializer);
                // Materialize address-yielding initializers that are not plain lvalues.
                const addr = node?.addr ?? context.lowering.emitAddress(context, variableDeclaration.initializer);
                if (addr) {
                    if (!context.refLocals) context.refLocals = new Map();
                    // Preserve pointer types for indexing; references bind to their referent type.
                    const refType = declared.kind === AstKind.POINTER ? declared : (node?.type ?? declared.referentType);
                    context.refLocals.set(variableDeclaration.name, refType);
                    context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, addrIr(addr))}`);
                } else {
                    context.programAnalysis.warn(`unsupported reference initializer for '${variableDeclaration.name}'`, statement.span.line);
                }
            }
            return;
        }
        // Store aggregate locals in slots so member access uses their address.
        {
            const db = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
            const concrete = declared.kind === AstKind.NAME && db.types.has(declared.name) ? db.types.get(declared.name)! : declared;
            if (context.programAnalysis.isAggregateType(concrete)) {
                // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this branch must consume the declaration
                let aggSz = context.programAnalysis.sizeOfType(concrete, db);
                if (concrete.kind === AstKind.ARRAY && aggSz <= 0 && variableDeclaration.initializer?.kind === AstKind.INITIALIZER_LIST) {
                    aggSz = context.programAnalysis.sizeOfType(concrete.element, db) * ((variableDeclaration.initializer as any).expressions ?? []).length;
                }
                const byteSize = Math.max(aggSz, 8);
                context.lines.push(
                    `    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(byteSize)))}`,
                );
                (context.refLocals ??= new Map()).set(variableDeclaration.name, concrete);
                // Route uint128 construction through its high/low-aware constructor.
                if (variableDeclaration.initializer && isUint128(context.programAnalysis, concrete)) {
                    context.lines.push(
                        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, WatNodeType.I32), context.lowering.lowerUint128Expression(context, variableDeclaration.initializer), watIr.i32Constant(16)))}`,
                    );
                    return;
                }
                const ctorArgs =
                    variableDeclaration.initializer &&
                    (variableDeclaration.initializer.kind === AstKind.CONSTRUCT ||
                        (variableDeclaration.initializer.kind === AstKind.CALL &&
                            variableDeclaration.initializer.callee.kind === AstKind.IDENTIFIER &&
                            (variableDeclaration.initializer.callee as any).name ===
                                (variableDeclaration.type.kind === AstKind.NAME ? variableDeclaration.type.name : "")))
                        ? (variableDeclaration.initializer as any).callArguments
                        : null;
                if (ctorArgs && context.lowering.emitConstruct(context, `(local.get $${variableDeclaration.name})`, concrete, ctorArgs)) {
                    return;
                }
                // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise; struct locals go field-wise through emitConstruct.
                if (variableDeclaration.initializer?.kind === AstKind.INITIALIZER_LIST) {
                    if (concrete.kind === AstKind.ARRAY) {
                        context.lines.push(
                            `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, WatNodeType.I32), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`,
                        );
                        context.lowering.emitArrayInitializer(
                            context,
                            watIr.localGet(variableDeclaration.name, WatNodeType.I32),
                            concrete,
                            variableDeclaration.initializer,
                        );
                        return;
                    }
                    if (
                        context.lowering.emitConstruct(
                            context,
                            `(local.get $${variableDeclaration.name})`,
                            concrete,
                            (variableDeclaration.initializer as any).expressions ?? [],
                        )
                    ) {
                        return;
                    }
                }
                if (variableDeclaration.initializer) {
                    const src =
                        context.lowering.resolveExpressionAddress(context, variableDeclaration.initializer)?.addr ??
                        context.lowering.emitAddress(context, variableDeclaration.initializer);
                    if (src) {
                        context.lines.push(
                            `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, WatNodeType.I32), addrIr(src), watIr.i32Constant(byteSize)))}`,
                        );
                        return;
                    }
                    context.programAnalysis.warn(`unsupported struct-local initializer for '${variableDeclaration.name}'`, statement.span.line);
                }
                context.lines.push(
                    `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, WatNodeType.I32), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`,
                );
                if (context.programAnalysis.gtestMode && !variableDeclaration.initializer && concrete.kind === AstKind.NAME) {
                    const struct = context.programAnalysis.structOf(concrete, db);
                    const constructor = struct?.members.find(
                        (member) => member.kind === AstKind.FUNCTION && (member as FunctionDecl).name === concrete.name && (member as FunctionDecl).body,
                    ) as FunctionDecl | undefined;
                    const layout = context.programAnalysis.layoutOfType(concrete, db);
                    if (constructor && layout) {
                        context.lowering.emitInlineStructMethod(
                            context,
                            {
                                addr: `(local.get $${variableDeclaration.name})`,
                                type: concrete,
                                size: byteSize,
                                layout,
                            },
                            constructor,
                            [],
                        );
                    }
                }
                return;
            }
        }
        if (variableDeclaration.initializer) {
            context.lines.push(
                `    ${context.lowering.setLocal(context, variableDeclaration.name, context.lowering.narrowLocalValue(context, variableDeclaration.name, context.lowering.lowerValueExpression(context, variableDeclaration.initializer)))}`,
            );
        }
    }
}
