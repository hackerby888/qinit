import { qpiWrapperMethod } from "../calls/call-shape";
import { platformPrimitive } from "../calls/platform-primitives";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, StructDecl, FunctionDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
import { addrIr } from "./memory-operations";
// Address of an lvalue or a materializable aggregate. Returns null if not addressable.
export function emitAddress(context: FunctionEmissionContext, expression: Expression): string | null {
    if (expression.kind === "identifier" && expression.name === "SELF")
        return "(call $self_id)";
    // an aggregate value-helper parameter is passed by address
    if (expression.kind === "identifier") {
        const type = context.params?.get(expression.name);
        if (type && type.isAddr)
            return `(local.get $${type.local ?? expression.name})`;
    }
    if (expression.kind === "identifier") {
        const initializer = context.programAnalysis.constexprInit.get(expression.name);
        const declaredType = context.programAnalysis.typeOfConstant(expression.name);
        const type = declaredType
            ? context.programAnalysis.derefType(declaredType)
            : null;
        if (initializer && type && context.programAnalysis.isAggregateType(type)) {
            const size = context.programAnalysis.sizeOfType(
                type,
                context.thisBind ?? EMPTY_TEMPLATE_BINDINGS,
            );
            const destination = context.lowering.allocateScratchSlotNode(context, size);
            const address = watIr.serializeWatNode(destination);
            let initialized = false;

            if (initializer.kind === "initializer_list") {
                initialized = context.lowering.emitConstruct(
                    context,
                    address,
                    type,
                    initializer.expressions,
                );
            } else if (initializer.kind === "construct") {
                initialized = context.lowering.emitConstruct(
                    context,
                    address,
                    type,
                    initializer.callArguments,
                );
            } else {
                const source = emitAddress(context, initializer);
                if (source) {
                    context.lines.push(
                        `    ${watIr.serializeWatNode(
                            watIr.functionCall(
                                "$copyMem",
                                destination,
                                addrIr(source),
                                watIr.i32Constant(size),
                            ),
                        )}`,
                    );
                    initialized = true;
                }
            }

            if (!initialized) {
                throw new Error(
                    `aggregate constant '${expression.name}' is not materializable`,
                );
            }

            (context.materializedCalls ??= new WeakMap()).set(expression, {
                addr: address,
                type,
                size,
                layout: context.programAnalysis.layoutOfType(
                    type,
                    context.thisBind ?? EMPTY_TEMPLATE_BINDINGS,
                ),
            });
            return address;
        }
    }
    if (expression.kind === "paren")
        return emitAddress(context, expression.expression);
    if (expression.kind === "call") {
        const cached = context.materializedCalls?.get(expression);
        if (cached)
            return cached.addr;
    }
    if (expression.kind === "call" &&
        (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")) {
        const primitive = platformPrimitive(expression.callee.name);
        if (primitive?.result === "address") {
            for (const capability of primitive.capabilities ?? [])
                context.programAnalysis.capabilities.add(capability);
            if (expression.callArguments.length !== primitive.operands.length) {
                throw new Error(`${primitive.name} expects ${primitive.operands.length} argument(s), got ${expression.callArguments.length}`);
            }
            const destination = context.lowering.allocateScratchSlotNode(context, 32);
            if (primitive.kind === "zero") {
                context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", destination, watIr.i32Constant(32), watIr.i32Constant(0)))}`);
            }
            else if (primitive.kind === "lane-pack-64") {
                for (let lane = 0; lane < 4; lane++) {
                    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", lane * 8, destination, context.lowering.lowerValueExpression(context, expression.callArguments[3 - lane])))}`);
                }
            }
            else if (primitive.kind === "lane-pack-8") {
                for (let lane = 0; lane < 32; lane++) {
                    const byte = watIr.operation("i32.wrap_i64", context.lowering.lowerValueExpression(context, expression.callArguments[31 - lane]));
                    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store8", lane, destination, byte))}`);
                }
            }
            else if (primitive.kind === "memory-load") {
                const source = emitAddress(context, expression.callArguments[0]);
                if (!source)
                    throw new Error(`${primitive.name} source is not addressable`);
                context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, addrIr(source), watIr.i32Constant(32)))}`);
            }
            else if (primitive.kind === "lane-compare-64") {
                const left = emitAddress(context, expression.callArguments[0]);
                const right = emitAddress(context, expression.callArguments[1]);
                if (!left || !right)
                    throw new Error(`${primitive.name} operands must be addressable`);
                for (let lane = 0; lane < 4; lane++) {
                    const argument = watIr.rawLoad("i64.load", lane * 8, addrIr(left));
                    const templateBindings = watIr.rawLoad("i64.load", lane * 8, addrIr(right));
                    const value = watIr.selectValue(watIr.i64Constant(-1), watIr.i64Constant(0), watIr.operation("i64.eq", argument, templateBindings));
                    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", lane * 8, destination, value))}`);
                }
            }
            else {
                throw new Error(`platform primitive '${primitive.name}' cannot produce an address via ${primitive.kind}`);
            }
            return watIr.serializeWatNode(destination);
        }
    }
    if (context.programAnalysis.gtestMode &&
        expression.kind === "call" &&
        (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")) {
        const calleeName = expression.callee.name;
        if (calleeName === "__qtest_state") {
            const sizeExpr = expression.callArguments[1];
            const size = sizeExpr?.kind === "sizeof_expr" && sizeExpr.expression.kind === "identifier"
                ? context.programAnalysis.sizeOfType({ kind: "name", name: sizeExpr.expression.name }, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)
                : sizeExpr
                    ? Number(context.programAnalysis.evalConstBig(sizeExpr, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS))
                    : 0;
            if (!(size > 0))
                throw new Error("gtest state access requires a constant positive state size");
            const destination = context.lowering.allocateScratchSlotNode(context, size);
            const slot = watIr.operation("i32.wrap_i64", expression.callArguments[0] ? context.lowering.lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0));
            context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_state", slot, destination, watIr.i32Constant(size))))}`);
            const addr = watIr.serializeWatNode(destination);
            (context.materializedCalls ??= new WeakMap()).set(expression, { addr, type: null, size, layout: null });
            return addr;
        }
        // Materialize empty call inputs as zero-initialized temporary objects.
        if (expression.callArguments.length === 0) {
            const type: TypeSpec = { kind: "name", name: calleeName };
            const size = context.programAnalysis.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
            if (size > 0 || /_(?:input|output)$/.test(calleeName)) {
                const destination = size > 0 ? context.lowering.allocateScratchSlotNode(context, size) : watIr.i32Constant(0);
                if (size > 0)
                    context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", destination, watIr.i32Constant(size), watIr.i32Constant(0)))}`);
                const addr = watIr.serializeWatNode(destination);
                (context.materializedCalls ??= new WeakMap()).set(expression, {
                    addr,
                    type,
                    size,
                    layout: context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                });
                return addr;
            }
        }
    }
    if (context.programAnalysis.gtestMode && expression.kind === "call" && expression.callee.kind === "member_access") {
        const resolved = context.lowering.inlineMethodInfo(context, expression);
        if (resolved && context.programAnalysis.isAggregateType(context.programAnalysis.derefType(resolved.fn.returnType))) {
            const type = context.programAnalysis.derefType(resolved.fn.returnType);
            const size = Math.max(1, context.programAnalysis.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
            const destination = context.lowering.allocateScratchSlotNode(context, size);
            context.lowering.emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments, {
                retAddr: watIr.serializeWatNode(destination),
                retSize: size,
            });
            const addr = watIr.serializeWatNode(destination);
            (context.materializedCalls ??= new WeakMap()).set(expression, {
                addr,
                type,
                size,
                layout: context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
            });
            return addr;
        }
    }
    // Materialize computed uint128 values before stripping casts or taking references.
    if ((expression.kind === "call" ||
        expression.kind === "template_call" ||
        expression.kind === "construct" ||
        expression.kind === "binary_op" ||
        expression.kind === "c_cast" ||
        expression.kind === "static_cast" ||
        expression.kind === "ternary") &&
        context.lowering.isU128Expr(context, expression)) {
        return context.lowering.emitU128(context, expression);
    }
    if (expression.kind === "c_cast" || expression.kind === "static_cast")
        return emitAddress(context, expression.expression);
    // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot
    if (expression.kind === "ternary") {
        const ta = context.lowering.resolveExpressionAddress(context, expression.then)?.addr ?? emitAddress(context, expression.then);
        const ea = ta ? (context.lowering.resolveExpressionAddress(context, expression.else_)?.addr ?? emitAddress(context, expression.else_)) : null;
        if (ta && ea) {
            const branchAddress = context.lowering.allocateTemporaryLocalName(context);
            context.lines.push(`    ${context.lowering.setLocal(context, branchAddress, watIr.selectValue(addrIr(ta), addrIr(ea), watIr.operation("i64.ne", watIr.i64Constant(0), context.lowering.lowerValueExpression(context, expression.condition))))}`);
            return `(local.get $${branchAddress})`;
        }
    }
    // Select id and m256i min/max addresses with a 256-bit comparison.
    if (expression.kind === "call" &&
        expression.callArguments.length === 2 &&
        (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")) {
        const cname = expression.callee.kind === "identifier" ? expression.callee.name : expression.callee.name;
        const base = cname.includes("::") ? cname.slice(cname.lastIndexOf("::") + 2) : cname;
        if (base === "min" || base === "max") {
            const la = context.lowering.aggOperand(context, expression.callArguments[0]);
            const ra = la ? context.lowering.aggOperand(context, expression.callArguments[1]) : null;
            if (la && ra && la.size === 32 && ra.size === 32) {
                const selectedAddress = context.lowering.allocateTemporaryLocalName(context);
                const cmp = watIr.functionCall("$m256_lt", addrIr(la.addr), addrIr(ra.addr));
                const pick = base === "min"
                    ? watIr.selectValue(addrIr(la.addr), addrIr(ra.addr), cmp)
                    : watIr.selectValue(addrIr(ra.addr), addrIr(la.addr), cmp);
                context.lines.push(`    ${context.lowering.setLocal(context, selectedAddress, pick)}`);
                return `(local.get $${selectedAddress})`;
            }
        }
    }
    // aggregate construction Type{...} as an rvalue/argument — materialize into a scratch slot.
    if (expression.kind === "construct") {
        const byteSize = context.programAnalysis.sizeOfType(expression.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
        if (byteSize > 0) {
            const scratchAddress = context.lowering.allocateScratchSlot(context, byteSize);
            if (context.lowering.emitConstruct(context, scratchAddress, expression.type, expression.callArguments))
                return scratchAddress;
        }
    }
    // Plain aggregate constructor syntax is normalized through the authoritative class constructor.
    if (expression.kind === "call" &&
        expression.callee.kind === "identifier" &&
        (expression.callee.name === "id" || expression.callee.name === "m256i")) {
        const type: TypeSpec = { kind: "name", name: expression.callee.name };
        const destination = context.lowering.allocateScratchSlot(context, 32);
        if (!context.lowering.emitConstruct(context, destination, type, expression.callArguments)) {
            throw new Error(`authoritative ${expression.callee.name} constructor could not be lowered`);
        }
        return destination;
    }
    // Compile qualified aggregate-returning methods from their owning struct bodies.
    if (expression.kind === "call" &&
        (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")) {
        const qualified = expression.callee.name;
        const separator = qualified.lastIndexOf("::");
        if (separator > 0) {
            const ownerSpelling = qualified.slice(0, separator);
            const method = qualified.slice(separator + 2);
            // Resolve NS::Type (or Type) without assuming a QPI:: prefix — try full spelling, then tail.
            const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
            const resolveOwner = (spelling: string): {
                type: TypeSpec;
                struct: StructDecl;
            } | null => {
                const type = context.programAnalysis.resolveType({ kind: "name", name: spelling }, bind);
                const struct = context.programAnalysis.structOf(type, bind);
                return struct ? { type, struct } : null;
            };
            let owner = resolveOwner(ownerSpelling);
            if (!owner && ownerSpelling.includes("::")) {
                const tail = ownerSpelling.slice(ownerSpelling.lastIndexOf("::") + 2);
                owner = resolveOwner(tail);
            }
            if (owner) {
                const declaration = owner.struct.members.find((member): member is FunctionDecl => member.kind === "function" &&
                    member.name === method &&
                    member.isStatic &&
                    !!member.body);
                if (declaration && context.programAnalysis.isAggregateType(context.programAnalysis.derefType(declaration.returnType))) {
                    const concreteOwner = owner.type.kind === "name" ? owner.type.name : owner.struct.name;
                    const target: TypeSpec & {
                        kind: "template_instance";
                    } = {
                        kind: "template_instance",
                        name: concreteOwner,
                        callArguments: [],
                    };
                    const compiled = context.lowering.callCompiled(context, target, method, "(i32.const 0)", expression.callArguments);
                    if (!compiled?.retDest || !compiled.cm.retType) {
                        throw new Error(`authoritative static aggregate method ${qualified} could not be lowered`);
                    }
                    context.lines.push(`    ${compiled.call}`);
                    const type = context.programAnalysis.substInBindings(context.programAnalysis.derefType(compiled.cm.retType), bind);
                    const size = compiled.cm.retAgg ?? context.programAnalysis.sizeOfType(type, bind);
                    (context.materializedCalls ??= new WeakMap()).set(expression, {
                        addr: compiled.retDest,
                        type,
                        size,
                        layout: context.programAnalysis.layoutOfType(type, bind),
                    });
                    return compiled.retDest;
                }
            }
        }
    }
    // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot.
    if (expression.kind === "call" && expression.callee.kind === "identifier") {
        const hinfo = context.lowering.lookupHelper(context, expression);
        if (hinfo?.retAgg)
            return context.lowering.emitAggHelperCall(context, expression, hinfo);
    }
    // AssetOwnership/PossessionIterator.possessor()/owner() → address of the id in the current buffer record.
    if (expression.kind === "call" && expression.callee.kind === "member_access") {
        const ai = context.lowering.emitAssetIter(context, expression, "addr");
        if (ai !== null)
            return ai;
    }
    // qpi(X).method(...) returning an id/struct (proposerId): compile the real proxy method and materialize the result into its $ret slot
    if (expression.kind === "call" && qpiWrapperMethod(expression)) {
        const pa = context.lowering.emitProposalProxyAddr(context, expression);
        if (pa !== null)
            return pa;
    }
    const resolvedAddress = context.lowering.resolveExpressionAddress(context, expression);
    return resolvedAddress ? resolvedAddress.addr : null;
}
