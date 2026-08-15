import { AstKind, WatNodeType } from "../../../shared/enums";
import { FunctionEmissionContext } from "../types";
import type { Statement } from "../../../ast";
import { emitDeclarationStatement } from "./declaration-statement";
import { emitReturnStatement } from "./return-statement";
// Tags backend errors with the statement being emitted, so the driver can report a real line.
// Nested statements tag first, leaving the innermost span.
export function emitStatement(context: FunctionEmissionContext, statement: Statement): void {
    try {
        emitStatementByKind(context, statement);
    } catch (error) {
        if (error instanceof Error && !("span" in error)) {
            Object.assign(error, { span: statement.span });
        }
        throw error;
    }
}

function emitStatementByKind(context: FunctionEmissionContext, statement: Statement): void {
    switch (statement.kind) {
        case AstKind.COMPOUND:
            context.lowering.emitCompound(context, statement.body);
            break;
        case AstKind.EXPRESSION: {
            // “Discarded” means the expression's result is not used - e.g., transfer(...); // return value discarded
            const discardedText = context.lowering.emitDiscardedExpression(context, statement.expression);
            if (discardedText) context.lines.push(`    ${discardedText}`);
            break;
        }
        case AstKind.DECLARATION:
            emitDeclarationStatement(context, statement);
            break;
        case AstKind.IF: {
            const condition = context.lowering.emitValue(context, statement.condition);
            context.lines.push(`    (if (i64.ne (i64.const 0) ${condition}) (then`);
            emitStatement(context, statement.then);
            if (statement.else_) {
                context.lines.push(`    ) (else`);
                emitStatement(context, statement.else_);
            }
            context.lines.push(`    ))`);
            break;
        }
        case AstKind.FOR: {
            if (statement.initializer) emitStatement(context, statement.initializer);
            const count = context.loopCount++;
            const brk = `$brk${count}`,
                loop = `$loop${count}`,
                cont = `$cont${count}`;
            context.lines.push(`    (block ${brk} (loop ${loop}`);
            if (statement.condition) {
                context.lines.push(`      (br_if ${brk} (i64.eqz ${context.lowering.emitValue(context, statement.condition)}))`);
            }
            // continue jumps out of the $cont block to run the update, then loops — matching C semantics.
            context.lines.push(`      (block ${cont}`);
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            emitStatement(context, statement.body);
            context.loops.pop();
            context.lines.push(`      )`);
            if (statement.update) {
                const discardedText = context.lowering.emitDiscardedExpression(context, statement.update);
                if (discardedText) context.lines.push(`      ${discardedText}`);
            }
            context.lines.push(`      (br ${loop})))`);
            break;
        }
        case AstKind.WHILE: {
            const count = context.loopCount++;
            const brk = `$brk${count}`,
                loop = `$loop${count}`,
                cont = `$cont${count}`;
            context.lines.push(`    (block ${brk} (loop ${loop}`);
            context.lines.push(`      (br_if ${brk} (i64.eqz ${context.lowering.emitValue(context, statement.condition)}))`);
            context.lines.push(`      (block ${cont}`);
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            emitStatement(context, statement.body);
            context.loops.pop();
            context.lines.push(`      )`);
            context.lines.push(`      (br ${loop})))`);
            break;
        }
        case AstKind.DO_WHILE: {
            const count = context.loopCount++;
            const brk = `$brk${count}`,
                loop = `$loop${count}`,
                cont = `$cont${count}`;
            context.lines.push(`    (block ${brk} (loop ${loop}`);
            context.lines.push(`      (block ${cont}`);
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            emitStatement(context, statement.body);
            context.loops.pop();
            context.lines.push(`      )`);
            context.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${context.lowering.emitValue(context, statement.condition)}))))`);
            break;
        }
        case AstKind.SWITCH: {
            const count = context.loopCount++;
            const brk = `$swbrk${count}`;
            let sw = `__qinit_sw${count}`;
            while (context.localVars.has(sw) || context.params?.has(sw)) sw += "_";
            context.localVars.set(sw, { wasmType: WatNodeType.I64 });
            context.lines.push(`    ${context.lowering.setLocal(context, sw, context.lowering.lowerValueExpression(context, statement.condition))}`);
            context.lines.push(`    (block ${brk}`);
            // break targets the switch; continue still targets the enclosing loop (if any).
            const cont = context.loops.length ? context.loops[context.loops.length - 1].cont : brk;
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            const body = statement.body.kind === AstKind.COMPOUND ? statement.body.body : [statement.body];
            // Give each switch group a block label for fallthrough dispatch.
            const groups: {
                test: string | null;
                statements: Statement[];
                label: string;
            }[] = [];
            let caseIdx = 0;
            for (const bodyItem of body) {
                if (bodyItem.kind === AstKind.CASE) {
                    groups.push({
                        test: `(i64.eq (local.get $${sw}) ${context.lowering.emitValue(context, bodyItem.value)})`,
                        statements: [],
                        label: `$swcase${count}_${caseIdx++}`,
                    });
                } else if (bodyItem.kind === AstKind.DEFAULT) {
                    groups.push({ test: null, statements: [], label: `$swdef${count}` });
                } else if (groups.length) {
                    groups[groups.length - 1].statements.push(bodyItem);
                }
            }
            // Open blocks from outermost to innermost so dispatch is placed inside all of them.
            for (let index = groups.length - 1; index >= 0; index--) {
                context.lines.push(`      (block ${groups[index].label}`);
            }
            // Dispatch chain — one conditional branch per non-default case.
            for (const group of groups) {
                if (group.test) {
                    context.lines.push(`        (if ${group.test} (then (br ${group.label})))`);
                }
            }
            // No match falls through to default group if one exists, otherwise breaks.
            const defaultGroup = groups.find((group) => group.test === null);
            context.lines.push(`        (br ${defaultGroup ? defaultGroup.label : brk})`);
            // Close blocks in source order, emitting each body between block boundaries.
            for (const groupCandidate of groups) {
                context.lines.push(`      )`);
                for (const statement of groupCandidate.statements) {
                    emitStatement(context, statement);
                }
            }
            context.loops.pop();
            context.lines.push(`    )`);
            break;
        }
        case AstKind.BREAK:
            if (context.loops.length) {
                const loop = context.loops[context.loops.length - 1];
                context.lowering.emitScratchpadReleases(context, loop.scratchDepth, false);
                context.lines.push(`    (br ${loop.brk})`);
            } else context.programAnalysis.warn(`break outside loop`, statement.span.line);
            break;
        case AstKind.CONTINUE:
            if (context.loops.length) {
                const loop = context.loops[context.loops.length - 1];
                context.lowering.emitScratchpadReleases(context, loop.scratchDepth, false);
                context.lines.push(`    (br ${loop.cont})`);
            } else context.programAnalysis.warn(`continue outside loop`, statement.span.line);
            break;
        case AstKind.RETURN:
            emitReturnStatement(context, statement);
            break;
        case AstKind.STATIC_ASSERT:
        case AstKind.EMPTY:
        case AstKind.LABEL:
            break;
        case AstKind.GOTO: {
            const target = context.gotoLabels?.get(statement.label);
            if (target) {
                context.lowering.emitScratchpadReleases(context, target.scratchDepth, false);
                context.lines.push(`    (br ${target.label})`);
            } else context.programAnalysis.warn(`unsupported goto '${statement.label}'`, statement.span.line);
            break;
        }
        default:
            context.programAnalysis.warn(`unsupported statement '${statement.kind}'`, statement.span.line);
            break;
    }
}
