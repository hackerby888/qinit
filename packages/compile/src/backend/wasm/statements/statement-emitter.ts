import { addrIr, narrowCast } from "../memory/memory-operations";
import { isUint128 } from "../memory/address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { Expression, Statement, FunctionDecl, VariableDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
export function emitStatement(context: FunctionEmissionContext, statement: Statement): void {
    switch (statement.kind) {
        case "compound":
            context.lowering.emitCompound(context, statement.body);
            break;
        case "expression": {
            const discardedText = context.lowering.emitDiscardedExpression(context, statement.expression);
            if (discardedText)
                context.lines.push(`    ${discardedText}`);
            break;
        }
        case "declaration": {
            if (statement.declaration.kind === "variable") {
                const variableDeclaration = statement.declaration as VariableDecl;
                // The collect pass stored the declared type with `auto` resolved from the initializer; classification here must agree with
                const declared = context.localVars.get(variableDeclaration.name)?.type ?? variableDeclaration.type;
                // __ScopedScratchpad scratchpad(size, initZero): bump a scratch buffer off the arena; the local holds its base address, read back
                if (variableDeclaration.type.kind === "name" && /ScopedScratchpad$/.test(variableDeclaration.type.name)) {
                    const callArguments = variableDeclaration.initializer && (variableDeclaration.initializer.kind === "construct" || variableDeclaration.initializer.kind === "call") ? variableDeclaration.initializer.callArguments : [];
                    const size = callArguments[0] ? context.lowering.lowerValueExpression(context, callArguments[0]) : watIr.i64Constant(0);
                    const initZero = callArguments[1]
                        ? watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, callArguments[1]))
                        : watIr.i32Constant(0);
                    context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$acquireScratchpad", size, initZero))}`);
                    (context.scratchpadLocals ??= new Set()).add(variableDeclaration.name);
                    (context.scratchpadScope ??= []).push(variableDeclaration.name);
                    break;
                }
                // AssetOwnership/PossessionIterator iter(asset): an 8-byte iterator buffer (count@0, cursor@4); the constructor runs the enumerate. Track its type so iter.possessor()/reachedEnd()/next()
                if (variableDeclaration.type.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(variableDeclaration.type.name)) {
                    context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(8)))}`);
                    (context.refLocals ??= new Map()).set(variableDeclaration.name, variableDeclaration.type);
                    const argument = variableDeclaration.initializer && (variableDeclaration.initializer.kind === "construct" || variableDeclaration.initializer.kind === "call")
                        ? variableDeclaration.initializer.callArguments[0]
                        : undefined;
                    if (argument) {
                        context.lowering.emitAssetIter(context, {
                            kind: "call",
                            span: statement.span,
                            callArguments: [argument],
                            callee: {
                                kind: "member_access",
                                span: statement.span,
                                object: { kind: "identifier", name: variableDeclaration.name, span: statement.span },
                                member: "begin",
                            },
                        } as Expression & {
                            kind: "call";
                        }, "stmt");
                    }
                    break;
                }
                // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it resolves through that address.
                if (declared.kind === "reference" || declared.kind === "pointer") {
                    // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
                    if (context.proxyClass && (variableDeclaration.name === "pv" || variableDeclaration.name === "qpi"))
                        break;
                    if (variableDeclaration.initializer) {
                        const node = context.lowering.resolveExpressionAddress(context, variableDeclaration.initializer);
                        // Fall back to emitAddr for initializers that aren't plain lvalues but still yield an address — an asset-iterator
                        const addr = node?.addr ?? context.lowering.emitAddress(context, variableDeclaration.initializer);
                        if (addr) {
                            if (!context.refLocals)
                                context.refLocals = new Map();
                            // A pointer local keeps its pointer type so resolveAddr's subscript path fires (`shareholders[i]`); a reference binds to its
                            const refType = declared.kind === "pointer" ? declared : (node?.type ?? declared.referentType);
                            context.refLocals.set(variableDeclaration.name, refType);
                            context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, addrIr(addr))}`);
                        }
                        else {
                            context.programAnalysis.warn(`unsupported reference initializer for '${variableDeclaration.name}'`, statement.span.line);
                        }
                    }
                    break;
                }
                // struct-typed local (DateAndTime begin = *this): allocate a slot the wasm local points at, so member reads and
                {
                    const db = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
                    const concrete = declared.kind === "name" && db.types.has(declared.name)
                        ? db.types.get(declared.name)!
                        : declared;
                    if (context.programAnalysis.isAggregateType(concrete)) {
                        // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this branch must consume the declaration
                        let aggSz = context.programAnalysis.sizeOfType(concrete, db);
                        if (concrete.kind === "array" && aggSz <= 0 && variableDeclaration.initializer?.kind === "initializer_list") {
                            aggSz = context.programAnalysis.sizeOfType(concrete.element, db) * ((variableDeclaration.initializer as any).expressions ?? []).length;
                        }
                        const byteSize = Math.max(aggSz, 8);
                        context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(byteSize)))}`);
                        (context.refLocals ??= new Map()).set(variableDeclaration.name, concrete);
                        // uint128_t is a class, not a pair of fields to initialize positionally: its two-argument
                        // constructor accepts (high, low), while the resident layout is (low, high). Route every
                        if (variableDeclaration.initializer && isUint128(context.programAnalysis, concrete)) {
                            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, "i32"), context.lowering.lowerUint128Expression(context, variableDeclaration.initializer), watIr.i32Constant(16)))}`);
                            break;
                        }
                        const ctorArgs = variableDeclaration.initializer &&
                            (variableDeclaration.initializer.kind === "construct" ||
                                (variableDeclaration.initializer.kind === "call" &&
                                    variableDeclaration.initializer.callee.kind === "identifier" &&
                                    (variableDeclaration.initializer.callee as any).name === (variableDeclaration.type.kind === "name" ? variableDeclaration.type.name : "")))
                            ? (variableDeclaration.initializer as any).callArguments
                            : null;
                        if (ctorArgs && context.lowering.emitConstruct(context, `(local.get $${variableDeclaration.name})`, concrete, ctorArgs)) {
                            break;
                        }
                        // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise; struct locals go field-wise through emitConstruct.
                        if (variableDeclaration.initializer?.kind === "initializer_list") {
                            if (concrete.kind === "array") {
                                context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, "i32"), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`);
                                context.lowering.emitArrayInitializer(context, watIr.localGet(variableDeclaration.name, "i32"), concrete, variableDeclaration.initializer);
                                break;
                            }
                            if (context.lowering.emitConstruct(context, `(local.get $${variableDeclaration.name})`, concrete, (variableDeclaration.initializer as any).expressions ?? [])) {
                                break;
                            }
                        }
                        if (variableDeclaration.initializer) {
                            const src = context.lowering.resolveExpressionAddress(context, variableDeclaration.initializer)?.addr ?? context.lowering.emitAddress(context, variableDeclaration.initializer);
                            if (src) {
                                context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, "i32"), addrIr(src), watIr.i32Constant(byteSize)))}`);
                                break;
                            }
                            context.programAnalysis.warn(`unsupported struct-local initializer for '${variableDeclaration.name}'`, statement.span.line);
                        }
                        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, "i32"), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`);
                        if (context.programAnalysis.gtestMode && !variableDeclaration.initializer && concrete.kind === "name") {
                            const struct = context.programAnalysis.structOf(concrete, db);
                            const constructor = struct?.members.find((member) => member.kind === "function" &&
                                (member as FunctionDecl).name === concrete.name &&
                                (member as FunctionDecl).body) as FunctionDecl | undefined;
                            const layout = context.programAnalysis.layoutOfType(concrete, db);
                            if (constructor && layout) {
                                context.lowering.emitInlineStructMethod(context, { addr: `(local.get $${variableDeclaration.name})`, type: concrete, size: byteSize, layout }, constructor, []);
                            }
                        }
                        break;
                    }
                }
                if (variableDeclaration.initializer) {
                    context.lines.push(`    ${context.lowering.setLocal(context, variableDeclaration.name, context.lowering.narrowLocalValue(context, variableDeclaration.name, context.lowering.lowerValueExpression(context, variableDeclaration.initializer)))}`);
                }
            }
            break;
        }
        case "if": {
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
        case "for": {
            if (statement.initializer)
                emitStatement(context, statement.initializer);
            const count = context.loopCount++;
            const brk = `$brk${count}`, loop = `$loop${count}`, cont = `$cont${count}`;
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
                if (discardedText)
                    context.lines.push(`      ${discardedText}`);
            }
            context.lines.push(`      (br ${loop})))`);
            break;
        }
        case "while": {
            const count = context.loopCount++;
            const brk = `$brk${count}`, loop = `$loop${count}`, cont = `$cont${count}`;
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
        case "do_while": {
            const count = context.loopCount++;
            const brk = `$brk${count}`, loop = `$loop${count}`, cont = `$cont${count}`;
            context.lines.push(`    (block ${brk} (loop ${loop}`);
            context.lines.push(`      (block ${cont}`);
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            emitStatement(context, statement.body);
            context.loops.pop();
            context.lines.push(`      )`);
            context.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${context.lowering.emitValue(context, statement.condition)}))))`);
            break;
        }
        case "switch": {
            const count = context.loopCount++;
            const brk = `$swbrk${count}`;
            let sw = `__qinit_sw${count}`;
            while (context.localVars.has(sw) || context.params?.has(sw))
                sw += "_";
            context.localVars.set(sw, { wasmType: "i64" });
            context.lines.push(`    ${context.lowering.setLocal(context, sw, context.lowering.lowerValueExpression(context, statement.condition))}`);
            context.lines.push(`    (block ${brk}`);
            // break targets the switch; continue still targets the enclosing loop (if any).
            const cont = context.loops.length ? context.loops[context.loops.length - 1].cont : brk;
            context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
            const body = statement.body.kind === "compound" ? statement.body.body : [statement.body];
            // Group statements by case/default markers. Each group gets a block label so
            const groups: {
                test: string | null;
                statements: Statement[];
                label: string;
            }[] = [];
            let caseIdx = 0;
            for (const bodyItem of body) {
                if (bodyItem.kind === "case") {
                    groups.push({
                        test: `(i64.eq (local.get $${sw}) ${context.lowering.emitValue(context, bodyItem.value)})`,
                        statements: [],
                        label: `$swcase${count}_${caseIdx++}`,
                    });
                }
                else if (bodyItem.kind === "default") {
                    groups.push({ test: null, statements: [], label: `$swdef${count}` });
                }
                else if (groups.length) {
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
        case "break":
            if (context.loops.length) {
                const loop = context.loops[context.loops.length - 1];
                context.lowering.emitScratchpadReleases(context, loop.scratchDepth, false);
                context.lines.push(`    (br ${loop.brk})`);
            }
            else
                context.programAnalysis.warn(`break outside loop`, statement.span.line);
            break;
        case "continue":
            if (context.loops.length) {
                const loop = context.loops[context.loops.length - 1];
                context.lowering.emitScratchpadReleases(context, loop.scratchDepth, false);
                context.lines.push(`    (br ${loop.cont})`);
            }
            else
                context.programAnalysis.warn(`continue outside loop`, statement.span.line);
            break;
        case "return":
            if (context.inlineReturnLabel) {
                if (statement.value && context.retAddr) {
                    const src = context.lowering.emitAddress(context, statement.value);
                    if (src) {
                        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr), addrIr(src), watIr.i32Constant(context.retAggSize ?? 0)))}`);
                    }
                    else if (context.retType &&
                        (statement.value.kind === "initializer_list" || statement.value.kind === "construct")) {
                        const callArguments = statement.value.kind === "initializer_list" ? statement.value.expressions : statement.value.callArguments;
                        if (!context.lowering.emitConstruct(context, context.retAddr, context.retType, callArguments)) {
                            throw new Error("aggregate return initializer could not be constructed");
                        }
                    }
                    else {
                        throw new Error("aggregate return expression from inline method is not addressable");
                    }
                }
                else if (statement.value && context.inlineValueLocal) {
                    context.lines.push(`    ${context.lowering.setLocal(context, context.inlineValueLocal, context.lowering.narrowLocalValue(context, context.inlineValueLocal, context.lowering.lowerValueExpression(context, statement.value)))}`);
                }
                context.lines.push(`    (br ${context.inlineReturnLabel})`);
                break;
            }
            // an inlined struct method's `return *this` carries no value out (the object flows via thisAddr); emitting a wasm
            if (context.inlineMethod)
                break;
            if (statement.value && context.retAddr) {
                // aggregate-returning helper: copy the returned value into the caller-supplied dest, then return
                const src = context.lowering.emitAddress(context, statement.value);
                if (src) {
                    context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr!), addrIr(src), watIr.i32Constant(context.retAggSize!)))}`);
                }
                else if (context.retType &&
                    (statement.value.kind === "initializer_list" || statement.value.kind === "construct")) {
                    const callArguments = statement.value.kind === "initializer_list" ? statement.value.expressions : statement.value.callArguments;
                    if (!context.lowering.emitConstruct(context, context.retAddr, context.retType, callArguments)) {
                        throw new Error("aggregate return initializer could not be constructed");
                    }
                }
                else {
                    throw new Error("aggregate return expression is not addressable");
                }
                context.lowering.emitScratchpadReleases(context, 0, false);
                context.lines.push(`    (return)`);
            }
            else if (statement.value && context.retIsAddr) {
                // Reference-returning compound operators commonly return their assignment
                // expression (`return *this += rhs`). Perform the write, then return the
                let addr: string | null;
                if (statement.value.kind === "assign") {
                    context.lowering.emitAssign(context, statement.value);
                    addr = context.lowering.emitAddress(context, statement.value.left);
                }
                else {
                    addr = context.lowering.emitAddress(context, statement.value);
                }
                if (!addr) {
                    context.programAnalysis.warn("reference return expression is not addressable", statement.span.line);
                    context.lines.push("    (return (i32.const 0))");
                    break;
                }
                const result = context.lowering.allocateTemporaryLocalName(context);
                context.lines.push(`    (local.set $${result} ${addr})`);
                context.lowering.emitScratchpadReleases(context, 0, false);
                context.lines.push(`    (return (local.get $${result}))`);
            }
            else if (statement.value && context.retIsValue) {
                // `return e` converts e to the declared return type (sub-64-bit returns truncate / sign-extend).
                const value = narrowCast(context.lowering.emitValue(context, statement.value), context.retTypeName);
                if (context.scratchpadScope?.length) {
                    const result = context.lowering.allocateTemporaryLocalName(context);
                    context.localVars.set(result, { wasmType: "i64" });
                    context.lines.push(`    (local.set $${result} ${value})`);
                    context.lowering.emitScratchpadReleases(context, 0, false);
                    context.lines.push(`    (return (local.get $${result}))`);
                }
                else {
                    context.lines.push(`    (return ${value})`);
                }
            }
            else {
                context.lowering.emitScratchpadReleases(context, 0, false);
                context.lines.push(`    (return)`);
            }
            break;
        case "static_assert":
        case "empty":
        case "label":
            break;
        case "goto": {
            const target = context.gotoLabels?.get(statement.label);
            if (target) {
                context.lowering.emitScratchpadReleases(context, target.scratchDepth, false);
                context.lines.push(`    (br ${target.label})`);
            }
            else
                context.programAnalysis.warn(`unsupported goto '${statement.label}'`, statement.span.line);
            break;
        }
        default:
            context.programAnalysis.warn(`unsupported statement '${statement.kind}'`, statement.span.line);
            break;
    }
}
