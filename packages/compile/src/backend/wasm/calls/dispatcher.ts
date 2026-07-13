import { addrIr } from "../memory/memory-operations";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { platformPrimitive } from "./platform-primitives";
import { describeShape, qpiWrapperMethod } from "./call-shape";
export function emitCall(context: FunctionEmissionContext, expression: Expression & {
    kind: "call";
}): void {
    if (context.programAnalysis.gtestMode && expression.callee.kind === "identifier") {
        const name = expression.callee.name;
        if (name === "__qtest_noop" || name === "initEmptySpectrum" || name === "initEmptyUniverse")
            return;
        if (name === "invokeUserProcedure") {
            const input = expression.callArguments[2] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[2]) : null;
            const output = expression.callArguments[3] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[3]) : null;
            const origin = expression.callArguments[4] ? context.lowering.emitAddress(context, expression.callArguments[4]) : null;
            if (!input || !output || !origin)
                throw new Error("gtest invokeUserProcedure requires addressable input, output, and origin");
            const slot = watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[0]));
            const inputType = watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[1]));
            const amount = expression.callArguments[5] ? context.lowering.lowerValueExpression(context, expression.callArguments[5]) : watIr.i64Constant(0);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_invoke", slot, inputType, addrIr(input.addr), watIr.i32Constant(input.size), addrIr(output.addr), amount, addrIr(origin))))}`);
            return;
        }
        if (name === "callFunction") {
            let input = expression.callArguments[2] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[2]) : null;
            const output = expression.callArguments[3] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[3]) : null;
            if (!input && expression.callArguments[2]) {
                const addr = context.lowering.emitAddress(context, expression.callArguments[2]);
                const callee = expression.callArguments[2].kind === "call" &&
                    (expression.callArguments[2].callee.kind === "identifier" ||
                        expression.callArguments[2].callee.kind === "qualified_name")
                    ? expression.callArguments[2].callee.name
                    : null;
                const type: TypeSpec | null = callee ? { kind: "name", name: callee } : null;
                const size = type ? context.programAnalysis.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : 0;
                if (addr && type)
                    input = { addr, type, size, layout: context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) };
            }
            if (!input || !output) {
                throw new Error(`gtest callFunction requires addressable input and output (${describeShape(expression.callArguments[2])}, ${describeShape(expression.callArguments[3])})`);
            }
            const slot = watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[0]));
            const inputType = watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[1]));
            context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_query", slot, inputType, addrIr(input.addr), watIr.i32Constant(input.size), addrIr(output.addr), watIr.i32Constant(output.size))))}`);
            return;
        }
        if (name === "increaseEnergy") {
            const who = expression.callArguments[0] ? context.lowering.emitAddress(context, expression.callArguments[0]) : null;
            if (!who)
                throw new Error("gtest increaseEnergy account must be addressable");
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$qt_fund", addrIr(who), expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0)))}`);
            return;
        }
        if (name === "callSystemProcedure") {
            const slot = watIr.operation("i32.wrap_i64", expression.callArguments[0] ? context.lowering.lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0));
            const procedure = watIr.operation("i32.wrap_i64", expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0));
            context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_system", slot, procedure)))}`);
            return;
        }
        const assertion = name.match(/^__qtest_(expect|assert)_(eq|ne|lt|le|gt|ge|true|false)$/);
        if (assertion) {
            const fatal = assertion[1] === "assert";
            const operation = assertion[2];
            const left = expression.callArguments[0] ?? ({ kind: "int_literal", value: "0", span: expression.span } as Expression);
            const right = operation === "true" || operation === "false"
                ? ({
                    kind: "int_literal",
                    value: operation === "true" ? "0" : "0",
                    span: expression.span,
                } as Expression)
                : (expression.callArguments[1] ?? ({ kind: "int_literal", value: "0", span: expression.span } as Expression));
            const operator = operation === "true"
                ? "!="
                : operation === "false"
                    ? "=="
                    : ({ eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" } as const)[operation as "eq" | "ne" | "lt" | "le" | "gt" | "ge"];
            const comparison = context.lowering.lowerValueExpression(context, { kind: "binary_op", operator, left, right, span: expression.span });
            const code = ["eq", "ne", "lt", "le", "gt", "ge", "true", "false"].indexOf(operation);
            context.lines.push(`    (if (i64.eqz ${watIr.serializeWatNode(comparison)}) (then`);
            context.lines.push(`      ${watIr.serializeWatNode(watIr.functionCall("$qt_fail", watIr.i32Constant(code), watIr.i32Constant(fatal ? 1 : 0)))}`);
            if (fatal)
                context.lines.push("      (return)");
            context.lines.push("    ))");
            return;
        }
    }
    // The generic HashFunction<KeyT> source body calls core-lite's KangarooTwelve primitive with an
    // explicit output length. The lite host exposes K12 as a 32-byte producer, so hash into a private
    if (expression.callee.kind === "identifier" && expression.callee.name === "KangarooTwelve") {
        const input = expression.callArguments[0] ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)";
        const inputSize = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
        const digest = context.lowering.allocateScratchSlotNode(context, 32);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$lh_k12", addrIr(input), watIr.operation("i32.wrap_i64", inputSize), digest))}`);
        let output: Expression | undefined = expression.callArguments[2];
        while (output?.kind === "paren" || (output?.kind === "unary_op" && output.operator === "&")) {
            output = output.kind === "paren" ? output.expression : output.argument;
        }
        if (output?.kind === "identifier" && context.localVars.get(output.name)?.wasmType === "i64") {
            context.lines.push(`    ${context.lowering.setLocal(context, output.name, watIr.rawLoad("i64.load", null, digest))}`);
        }
        else {
            const outAddr = expression.callArguments[2] ? context.lowering.emitAddress(context, expression.callArguments[2]) : null;
            if (!outAddr)
                throw new Error("KangarooTwelve output is not addressable");
            const outputSize = expression.callArguments[3] ? context.lowering.lowerValueExpression(context, expression.callArguments[3]) : watIr.i64Constant(32);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(outAddr), digest, watIr.operation("i32.wrap_i64", outputSize)))}`);
        }
        return;
    }
    if (expression.callee.kind === "identifier" && expression.callee.name.startsWith("__qinit_log_")) {
        const levels: Record<string, number> = {
            __qinit_log_error: 4,
            __qinit_log_warning: 5,
            __qinit_log_info: 6,
            __qinit_log_debug: 7,
        };
        const level = levels[expression.callee.name];
        if (level !== undefined) {
            const payload = expression.callArguments[0] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[0]) : null;
            if (!payload)
                throw new Error(`${expression.callee.name} payload must be an addressable aggregate`);
            if (!payload.layout)
                throw new Error(`${expression.callee.name} payload must be a struct`);
            const terminator = payload.layout.fields.get("_terminator");
            if (!terminator)
                throw new Error(`${expression.callee.name} payload struct must contain _terminator`);
            if (terminator.offset < 8)
                throw new Error(`${expression.callee.name} payload _terminator offset must be at least 8 bytes`);
            const address = addrIr(payload.addr);
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$qpi_logBytes", watIr.i32Constant(context.programAnalysis.slot), watIr.i32Constant(level), address, watIr.i32Constant(terminator.offset)))}`);
            // Native qpi.h restores the host-stamped contract index so logging cannot alter contract state.
            context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store", null, address, watIr.i32Constant(0)))}`);
            return;
        }
        if (expression.callee.name === "__qinit_log_pause") {
            context.lines.push("    (call $lh_pauseLog)");
            return;
        }
        if (expression.callee.name === "__qinit_log_resume") {
            context.lines.push("    (call $lh_resumeLog)");
            return;
        }
        throw new Error(`unknown logging intrinsic '${expression.callee.name}'`);
    }
    // ASSERT is ((void)0) in release builds (platform/assert.h) — the argument is not even evaluated, so dropping the statement
    if (expression.callee.kind === "identifier" && expression.callee.name === "ASSERT")
        return;
    const primitive = expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name"
        ? platformPrimitive(expression.callee.name)
        : undefined;
    if (primitive?.kind === "memory-store") {
        const destination = context.lowering.emitAddress(context, expression.callArguments[0]);
        const source = context.lowering.emitAddress(context, expression.callArguments[1]);
        if (!destination || !source)
            throw new Error(`${primitive.name} operands must be addressable`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(destination), addrIr(source), watIr.i32Constant(32)))}`);
        return;
    }
    if (primitive?.kind === "chain-rdrand") {
        context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", context.lowering.emitCallValueIr(context, expression)))}`);
        return;
    }
    if (expression.callee.kind === "member_access" && context.lowering.emitInlineStructStatement(context, expression))
        return;
    // ProposalVoting proxy `qpi(state.proposals).method(...)` as a statement (e.g. getProposal/vote write
    if (context.proxyClass && context.lowering.emitProxySiblingCall(context, expression, false) !== null)
        return;
    const proxyMethod = qpiWrapperMethod(expression);
    if (proxyMethod) {
        if (context.lowering.emitProposalProxyCall(context, expression, false) === null) {
            throw new Error(`authoritative proposal method '${proxyMethod}' could not be lowered`);
        }
        return;
    }
    // AssetOwnership/PossessionIterator.begin()/next() — statement forms.
    if (context.lowering.emitAssetIter(context, expression, "stmt") !== null)
        return;
    // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract, passing the caller's in/out
    if (expression.callee.kind === "identifier" && expression.callee.name === "__qpi_call_self") {
        const fnArg = expression.callArguments[0];
        const info = fnArg?.kind === "identifier"
            ? (context.programAnalysis.privates.get(fnArg.name) ?? context.programAnalysis.registered.get(fnArg.name))
            : undefined;
        if (info) {
            const inAddr = expression.callArguments[1]
                ? (context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)")
                : "(i32.const 0)";
            const outAddr = expression.callArguments[2]
                ? (context.lowering.emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
                : "(i32.const 0)";
            const locals = `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
            context.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${locals})`);
            return;
        }
    }
    // Direct PRIVATE_ function call: `priv(qpi, state, in, out, locals)` — QUtil calls its helpers this way (get_voter_balance/get_qubic_balance) instead
    if (expression.callee.kind === "identifier" &&
        expression.callArguments[0]?.kind === "identifier" &&
        expression.callArguments[0].name === "qpi") {
        // Registered PUBLIC entries are callable the same way (MsVault's isShareHolder(qpi, state, ...)).
        const info = context.programAnalysis.privates.get(expression.callee.name) ?? context.programAnalysis.registered.get(expression.callee.name);
        if (info) {
            const inAddr = expression.callArguments[2]
                ? (context.lowering.emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
                : "(i32.const 0)";
            const outAddr = expression.callArguments[3]
                ? (context.lowering.emitAddress(context, expression.callArguments[3]) ?? "(i32.const 0)")
                : "(i32.const 0)";
            const localsAddr = expression.callArguments[4]
                ? (context.lowering.emitAddress(context, expression.callArguments[4]) ?? `(call $qpiAllocLocals (i32.const ${info.localsSize}))`)
                : `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
            context.lines.push(`    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${localsAddr})`);
            return;
        }
    }
    // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a host-mediated call into the contract at C's index. Needs C's callee IDL (index
    if (expression.callee.kind === "identifier" &&
        (expression.callee.name === "__qpi_call_other" || expression.callee.name === "__qpi_invoke_other")) {
        const wat = context.lowering.emitInterContract(context, expression, expression.callee.name === "__qpi_invoke_other");
        if (wat)
            context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.rawWatNode(wat, "i32", "unconverted: inter-contract call")))}`);
        else
            context.programAnalysis.warn(`unsupported inter-contract call to '${expression.callArguments[0]?.kind === "identifier" ? expression.callArguments[0].name : "?"}' (no callee IDL)`, expression.span.line);
        return;
    }
    // QPI memory wrappers: setMemory(dst,val) / copyMemory(dst,src) / copyFromBuffer(dst,src) / copyToBuffer(dst,src,tailZero). Lowered at the call site so the byte
    if (expression.callee.kind === "identifier" &&
        (expression.callee.name === "setMemory" ||
            expression.callee.name === "copyMemory" ||
            expression.callee.name === "copyFromBuffer" ||
            expression.callee.name === "copyToBuffer")) {
        const name = expression.callee.name;
        const dstNode = expression.callArguments[0] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[0]) : null;
        const dst = dstNode?.addr ??
            (expression.callArguments[0] ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)");
        if (name === "setMemory") {
            const val = expression.callArguments[1] ? context.lowering.lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
            // $setMem is (dst, size, val).
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(dst), watIr.i32Constant(dstNode?.size ?? 0), watIr.operation("i32.wrap_i64", val)))}`);
            return;
        }
        const srcNode = expression.callArguments[1] ? context.lowering.resolveExpressionAddress(context, expression.callArguments[1]) : null;
        const src = srcNode?.addr ??
            (expression.callArguments[1] ? (context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)") : "(i32.const 0)");
        // copyToBuffer copies sizeof(src) (the smaller object into a larger buffer); the others copy sizeof(dst).
        const size = name === "copyToBuffer" ? (srcNode?.size ?? 0) : (dstNode?.size ?? 0);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(dst), addrIr(src), watIr.i32Constant(size)))}`);
        return;
    }
    // Low-level memory intrinsics copyMem(dst,src,n) / setMem(dst,val,n). Handled here (not only in
    if (expression.callee.kind === "identifier" &&
        (expression.callee.name === "copyMem" || expression.callee.name === "setMem")) {
        const dst = expression.callArguments[0] ? (context.lowering.emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)";
        const wrapArg = (expression: Expression | undefined) => watIr.operation("i32.wrap_i64", expression ? context.lowering.lowerValueExpression(context, expression) : watIr.i64Constant(0));
        if (expression.callee.name === "copyMem") {
            const src = expression.callArguments[1] ? (context.lowering.emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)") : "(i32.const 0)";
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(dst), addrIr(src), wrapArg(expression.callArguments[2])))}`);
        }
        else {
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(dst), wrapArg(expression.callArguments[1]), wrapArg(expression.callArguments[2])))}`);
        }
        return;
    }
    const tc = context.lowering.emitThisCall(context, expression, false);
    if (tc !== null)
        return;
    const helperCallText = context.lowering.emitHelperCall(context, expression, false);
    if (helperCallText !== null)
        return;
    const containerCallText = context.lowering.emitContainerCall(context, expression, false);
    if (containerCallText !== null)
        return;
    context.lowering.emitQpiCall(context, expression);
    context.programAnalysis.warn(`unsupported call statement [${describeShape(expression)}]`, expression.span.line);
}
