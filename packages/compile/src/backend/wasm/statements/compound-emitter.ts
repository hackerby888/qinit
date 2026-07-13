import { FunctionEmissionContext } from "../types";
import type { Statement, VariableDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { collectGotosIn, collectLabelsIn } from "./jump-analysis";
export function emitScratchpadReleases(context: FunctionEmissionContext, from: number, consume: boolean): void {
    if (!context.scratchpadScope || context.scratchpadScope.length <= from)
        return;
    for (let index = context.scratchpadScope.length - 1; index >= from; index--) {
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$releaseScratchpad", watIr.localGet(context.scratchpadScope[index], "i32")))}`);
    }
    if (consume)
        context.scratchpadScope.length = from;
}
// Emit a brace block, lowering forward gotos (relooper-lite). A `goto L` that jumps forward to a label
export function emitCompound(context: FunctionEmissionContext, body: Statement[]): void {
    const spBase = context.scratchpadScope?.length ?? 0;
    const scratchDepthAt = (child: number): number => {
        let depth = spBase;
        for (let index = 0; index < child; index++) {
            const statement = body[index];
            if (statement.kind !== "declaration" || statement.declaration.kind !== "variable")
                continue;
            const type = (statement.declaration as VariableDecl).type;
            if (type.kind === "name" && /ScopedScratchpad$/.test(type.name))
                depth++;
        }
        return depth;
    };
    // child index where each goto-targeted label is rooted
    const labelChild = new Map<string, number>();
    for (let bodyItemIndex = 0; bodyItemIndex < body.length; bodyItemIndex++) {
        const labels = new Set<string>();
        collectLabelsIn(body[bodyItemIndex], labels);
        for (const label of labels)
            if (!labelChild.has(label))
                labelChild.set(label, bodyItemIndex);
    }
    // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block that
    const wasmLabel = new Map<string, string>();
    const blocks: {
        wl: string;
        firstGoto: number;
        closeAt: number;
    }[] = [];
    for (let bodyItemIndexInner = 0; bodyItemIndexInner < body.length; bodyItemIndexInner++) {
        const gotos = new Set<string>();
        collectGotosIn(body[bodyItemIndexInner], gotos);
        for (const goto of gotos) {
            const lc = labelChild.get(goto);
            if (lc === undefined || lc <= bodyItemIndexInner || wasmLabel.has(goto))
                continue;
            const wl = `$goto_${goto}_${context.loopCount++}`;
            wasmLabel.set(goto, wl);
            blocks.push({ wl, firstGoto: bodyItemIndexInner, closeAt: lc });
        }
    }
    if (wasmLabel.size === 0) {
        for (const bodyItem of body)
            context.lowering.emitStatement(context, bodyItem);
    }
    else {
        if (!context.gotoLabels)
            context.gotoLabels = new Map();
        for (const [labelName, blockLabel] of wasmLabel) {
            context.gotoLabels.set(labelName, { label: blockLabel, scratchDepth: scratchDepthAt(labelChild.get(labelName) ?? 0) });
        }
        // WASM blocks must nest (LIFO). With multiple labels whose [firstGoto..closeAt] ranges OVERLAP without
        const openChild = Math.min(...blocks.map((block) => block.firstGoto));
        blocks.sort((block, blockIndex) => blockIndex.closeAt - block.closeAt);
        const closeStack: number[] = [];
        for (let bodyItemIndex = 0; bodyItemIndex < body.length; bodyItemIndex++) {
            while (closeStack.length && closeStack[closeStack.length - 1] === bodyItemIndex) {
                context.lines.push(`    )`);
                closeStack.pop();
            }
            if (bodyItemIndex === openChild) {
                for (const block of blocks) {
                    context.lines.push(`    (block ${block.wl}`);
                    closeStack.push(block.closeAt);
                }
            }
            context.lowering.emitStatement(context, body[bodyItemIndex]);
        }
        while (closeStack.length) {
            context.lines.push(`    )`);
            closeStack.pop();
        }
        for (const labelName of wasmLabel.keys())
            context.gotoLabels!.delete(labelName);
    }
    // Scope exit: run __ScopedScratchpad destructors declared in this compound (RAII, LIFO). Without the
    emitScratchpadReleases(context, spBase, true);
}
