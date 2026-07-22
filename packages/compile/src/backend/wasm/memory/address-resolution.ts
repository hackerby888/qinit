import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { StructLayout, FieldLayout, FunctionEmissionContext, ResolvedAddress, EMPTY_TEMPLATE_BINDINGS, ResolvedLvalue } from "../types";
import type { TypeSpec, Expression, StructDecl } from "../../../ast";
import { addressAtOffset } from "./memory-operations";
// ---- lvalue addressing ----
// True if `state.get()` / `state.mut()`.
export function isStateAccessor(expression: Expression): boolean {
    return (expression.kind === "call" &&
        expression.callee.kind === "member_access" &&
        expression.callee.object.kind === "identifier" &&
        expression.callee.object.name === "state" &&
        (expression.callee.member === "mut" || expression.callee.member === "get"));
}
// Build fixed-width limb views for id and m256i storage.
export function limbLayout(elemSize: number, count: number): StructLayout {
    let typeName = "uint8";
    if (elemSize === 8)
        typeName = "uint64";
    else if (elemSize === 4)
        typeName = "uint32";
    else if (elemSize === 2)
        typeName = "uint16";
    const type: TypeSpec = {
        kind: "name",
        name: typeName,
    };
    const fields = new Map<string, FieldLayout>();
    for (let index = 0; index < count; index++)
        fields.set(`_${index}`, { name: `_${index}`, offset: index * elemSize, size: elemSize, type: type });
    return { size: elemSize * count, align: elemSize, fields };
}
export const ID_VIEWS: Record<string, StructLayout> = {
    u64: limbLayout(8, 4),
    u32: limbLayout(4, 8),
    u16: limbLayout(2, 16),
    u8: limbLayout(1, 32),
};
export function isIdLike(programAnalysis: ProgramAnalysis, type: TypeSpec | null): boolean {
    if (!type)
        return false;
    const dereferencedType = programAnalysis.derefType(type);
    if (dereferencedType.kind !== "name")
        return false;
    const separator = dereferencedType.name.lastIndexOf("::");
    const name = separator >= 0 ? dereferencedType.name.slice(separator + 2) : dereferencedType.name;
    return name === "id" || name === "m256i";
}
export function isUint128(programAnalysis: ProgramAnalysis, type: TypeSpec | null): boolean {
    if (!type)
        return false;
    const dereferencedType = programAnalysis.derefType(type);
    if (dereferencedType.kind !== "name" && dereferencedType.kind !== "template_instance")
        return false;
    const separator = dereferencedType.name.lastIndexOf("::");
    const name = separator >= 0 ? dereferencedType.name.slice(separator + 2) : dereferencedType.name;
    return name === "uint128" || name === "uint128_t";
}
// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
export function castInfo(expression: Expression): {
    type: TypeSpec;
    operand: Expression;
} | null {
    if (expression.kind === "static_cast" || expression.kind === "c_cast" || expression.kind === "reinterpret_cast")
        return { type: expression.type, operand: expression.expression };
    if (expression.kind === "template_call" &&
        expression.callee.kind === "identifier" &&
        /^(static|reinterpret|const)_cast$/.test(expression.callee.name) &&
        expression.templateArguments?.[0] &&
        expression.callArguments?.[0]) {
        return { type: expression.templateArguments[0], operand: expression.callArguments[0] };
    }
    return null;
}
export function stripPtrRefConst(type: TypeSpec): TypeSpec {
    while (type.kind === "pointer" || type.kind === "reference" || type.kind === "const") {
        if (type.kind === "pointer")
            type = type.pointee;
        else if (type.kind === "reference")
            type = type.referentType;
        else
            type = type.valueType;
    }
    return type;
}
export function resolveExpressionAddress(context: FunctionEmissionContext, expression: Expression): ResolvedAddress | null {
    if (expression.kind === "paren")
        return resolveExpressionAddress(context, expression.expression);
    // __ScopedScratchpad.ptr → the held scratch buffer base (the local's value). `reinterpret_cast<T*>(sp.ptr)`
    if (expression.kind === "member_access" &&
        expression.member === "ptr" &&
        expression.object.kind === "identifier" &&
        context.scratchpadLocals?.has(expression.object.name)) {
        return {
            addr: `(local.get $${expression.object.name})`,
            type: { kind: "pointer", pointee: { kind: "name", name: "uint8" } },
            size: 4,
            layout: null,
        };
    }
    // roots
    if (expression.kind === "identifier") {
        // a reference/pointer local holds the address of its referent; chain member access through it.
        if (context.refLocals?.has(expression.name)) {
            const type = context.refLocals.get(expression.name)!;
            return {
                addr: `(local.get $${expression.name})`,
                type: type,
                size: context.programAnalysis.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                layout: context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
            };
        }
        // an aggregate value-helper / container-method parameter holds the address of its argument; its type may reference template params
        const type = context.params?.get(expression.name);
        if (type && type.isAddr) {
            const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
            return {
                addr: `(local.get $${type.local ?? expression.name})`,
                type: type.type,
                size: context.programAnalysis.sizeOfType(type.type, templateBindings),
                layout: context.programAnalysis.layoutOfType(type.type, templateBindings),
            };
        }
        if (type)
            return null; // a scalar param has no address; don't let it fall through to the entry-fn names
        if (expression.name === "input")
            return { addr: "(local.get $__qinit_in)", type: null, size: context.in.size, layout: context.in };
        if (expression.name === "output")
            return { addr: "(local.get $__qinit_out)", type: null, size: context.out.size, layout: context.out };
        if (expression.name === "locals")
            return {
                addr: "(local.get $__qinit_locals)",
                type: null,
                size: context.locals.size,
                layout: context.locals,
            };
        // Resolve a static helper's bare `state` parameter to resident state.
        if (expression.name === "state" && context.hasStateParam && !context.localVars.has("state")) {
            return {
                addr: "(local.get $__qinit_state)",
                type: null,
                size: context.state.size,
                layout: context.state,
            };
        }
        // Resolve `this` and bare members against the active method instance.
        if (context.thisLayout) {
            const thisAddr = context.thisAddr ?? "(local.get $this)";
            if (expression.name === "this")
                return {
                    addr: thisAddr,
                    type: context.thisType ?? null,
                    size: context.thisLayout.size,
                    layout: context.thisLayout,
                };
            const fieldLayout = context.thisLayout.fields.get(expression.name);
            if (fieldLayout)
                return {
                    addr: addressAtOffset(thisAddr, fieldLayout.offset),
                    type: fieldLayout.type,
                    size: fieldLayout.size,
                    layout: context.programAnalysis.layoutOfType(fieldLayout.type, context.thisBind),
                };
        }
        return null;
    }
    // arr[i] / ptr[i]: element address from an array member (this+off) or a pointer-valued operand.
    if (expression.kind === "subscript") {
        const base = resolveExpressionAddress(context, expression.object);
        let baseAddr: string | null = null, elemType: TypeSpec | null = null;
        if (base?.type?.kind === "array") {
            baseAddr = base.addr;
            elemType = base.type.element;
        }
        else if (base?.type?.kind === "pointer") {
            baseAddr = base.addr;
            elemType = base.type.pointee;
        }
        if (!baseAddr || !elemType)
            return null;
        const elemSize = context.programAnalysis.sizeOfType(elemType, context.thisBind);
        const idx = `(i32.mul (i32.wrap_i64 ${context.lowering.emitValue(context, expression.index)}) (i32.const ${elemSize}))`;
        return {
            addr: `(i32.add ${baseAddr} ${idx})`,
            type: elemType,
            size: elemSize,
            layout: context.programAnalysis.layoutOfType(elemType, context.thisBind),
        };
    }
    // Keep pointer arithmetic pointer-typed for subsequent dereference or indexing.
    if (expression.kind === "binary_op" && (expression.operator === "+" || expression.operator === "-")) {
        const base = resolveExpressionAddress(context, expression.left);
        const bt = base?.type;
        if (base && bt?.kind === "pointer") {
            const elemSize = context.programAnalysis.sizeOfType(bt.pointee, context.thisBind) || 8;
            const off = `(i32.mul (i32.wrap_i64 ${context.lowering.emitValue(context, expression.right)}) (i32.const ${elemSize}))`;
            const addr = `(${expression.operator === "+" ? "i32.add" : "i32.sub"} ${base.addr} ${off})`;
            return { addr, type: bt, size: base.size, layout: null };
        }
    }
    // inside a compiled container method: `this` (the object) and `*this` both address the instance.
    if (expression.kind === "this" && context.thisLayout) {
        return {
            addr: context.thisAddr ?? "(local.get $this)",
            type: context.thisType ?? null,
            size: context.thisLayout.size,
            layout: context.thisLayout,
        };
    }
    // Reinterpret pointer and reference casts at the same address.
    {
        const ci = castInfo(expression);
        if (ci) {
            const inner = resolveExpressionAddress(context, ci.operand);
            const materialized = !inner && context.programAnalysis.gtestMode ? context.lowering.emitAddress(context, ci.operand) : null;
            if (!inner && !materialized)
                return null;
            const address = inner?.addr ?? materialized!;
            const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
            // A cast to T* produces a pointer value at the same wasm32 address. Keep the pointer wrapper so
            // subsequent `+ n`, subscripting, and unary `*` scale by sizeof(T) and load the pointee.
            if (ci.type.kind === "pointer") {
                return { addr: address, type: ci.type, size: 4, layout: null };
            }
            const type = stripPtrRefConst(ci.type);
            return {
                addr: address,
                type: type,
                size: context.programAnalysis.sizeOfType(type, templateBindings),
                layout: context.programAnalysis.layoutOfType(type, templateBindings),
            };
        }
    }
    // Address-of preserves an lvalue's existing address.
    if (expression.kind === "unary_op" && expression.operator === "&")
        return resolveExpressionAddress(context, expression.argument);
    if (expression.kind === "unary_op" && expression.operator === "*") {
        if (expression.argument.kind === "this")
            return resolveExpressionAddress(context, expression.argument);
        // *cast<T*>(&X): the deref of a pointer cast is the cast operand's address, retyped to the pointee.
        const ci = castInfo(expression.argument);
        if (ci && ci.type.kind === "pointer") {
            const inner = resolveExpressionAddress(context, ci.operand);
            const materialized = !inner && context.programAnalysis.gtestMode ? context.lowering.emitAddress(context, ci.operand) : null;
            if (inner || materialized) {
                const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
                const type = stripPtrRefConst(ci.type);
                return {
                    addr: inner?.addr ?? materialized!,
                    type: type,
                    size: context.programAnalysis.sizeOfType(type, templateBindings),
                    layout: context.programAnalysis.layoutOfType(type, templateBindings),
                };
            }
        }
        // *ptr: a pointer param/local holds the pointed-to address, so dereferencing yields that address.
        const pn = resolveExpressionAddress(context, expression.argument);
        const pt = pn?.type ? context.programAnalysis.derefType(pn.type) : null;
        if (pn && pt?.kind === "pointer") {
            const pointee = pt.pointee;
            const byteSize = context.programAnalysis.sizeOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) || 8;
            return {
                addr: pn.addr,
                type: pointee,
                size: byteSize,
                layout: context.programAnalysis.layoutOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
            };
        }
        return null;
    }
    if (isStateAccessor(expression)) {
        // Prefer a method's ContractState reference parameter over resident state.
        const layout = context.state.size > 0 ? context.state : context.programAnalysis.contractStateLayout;
        const stateParam = context.params?.get("state");
        const addr = stateParam?.isAddr
            ? `(local.get $${stateParam.local ?? "state"})`
            : "(local.get $__qinit_state)";
        return { addr, type: null, size: layout.size, layout };
    }
    // Keep container element getters addressable for chained member access.
    if (expression.kind === "call") {
        const ce = context.lowering.resolveContainerElem(context, expression);
        if (ce)
            return ce;
        // Inline reference-returning struct methods as addressable calls.
        return context.lowering.tryInlineStructMethod(context, expression);
    }
    // member access: resolve the object, then index its field
    if (expression.kind === "member_access") {
        let parent = resolveExpressionAddress(context, expression.object);
        if (!parent && expression.object.kind === "call" && expression.object.callee.kind === "member_access") {
            const method = context.lowering.inlineMethodInfo(context, expression.object);
            if (method && context.programAnalysis.isAggregateType(context.programAnalysis.derefType(method.fn.returnType))) {
                const type = context.programAnalysis.derefType(method.fn.returnType);
                const addr = context.lowering.emitAddress(context, expression.object);
                if (addr)
                    parent = {
                        addr,
                        type,
                        size: Math.max(1, context.programAnalysis.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)),
                        layout: context.programAnalysis.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                    };
            }
        }
        if (!parent && expression.object.kind === "call" && expression.object.callee.kind === "identifier") {
            const helper = context.lowering.lookupHelper(context, expression.object);
            if (helper?.retAgg && helper.retType) {
                const addr = context.lowering.emitAggHelperCall(context, expression.object, helper);
                parent = {
                    addr,
                    type: helper.retType,
                    size: helper.retAgg,
                    layout: context.programAnalysis.layoutOfType(helper.retType, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                };
            }
        }
        // Materialize id-producing QPI calls before resolving their members.
        if (!parent &&
            expression.object.kind === "call" &&
            expression.object.callee.kind === "member_access" &&
            expression.object.callee.object.kind === "identifier" &&
            expression.object.callee.object.name === "qpi") {
            const addr = context.lowering.emitAddress(context, expression.object);
            if (addr)
                parent = { addr, type: { kind: "name", name: "id" }, size: 32, layout: null };
        }
        if (!parent)
            return null;
        if (expression.arrow && parent.type?.kind === "pointer") {
            const pointee = parent.type.pointee;
            parent = {
                addr: parent.addr,
                type: pointee,
                size: context.programAnalysis.sizeOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
                layout: context.programAnalysis.layoutOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
            };
        }
        // id/m256i limb views (`.u64`/`.u32`/`.u16`/`.u8`) → a fixed-width array at the value's base.
        if (isIdLike(context.programAnalysis, parent.type) && ID_VIEWS[expression.member]) {
            return { addr: parent.addr, type: null, size: 32, layout: ID_VIEWS[expression.member] };
        }
        // uint128 `.low` / `.high` → the low / high 64-bit half (low at offset 0).
        if (isUint128(context.programAnalysis, parent.type) && (expression.member === "low" || expression.member === "high")) {
            return {
                addr: addressAtOffset(parent.addr, expression.member === "low" ? 0 : 8),
                type: { kind: "name", name: "uint64" },
                size: 8,
                layout: null,
            };
        }
        if (!parent.layout)
            return null;
        const fieldLayout = parent.layout.fields.get(expression.member);
        if (!fieldLayout)
            return null;
        // Resolve member types through the parent instance's bindings and typedefs.
        let ptype: TypeSpec | null = parent.type;
        for (let index = 0; index < 8 && ptype?.kind === "name"; index++)
            ptype = context.programAnalysis.typedefs.get(ptype.name) ?? null;
        let ftype = ptype?.kind === "template_instance" ? context.programAnalysis.concreteMemberType(fieldLayout.type, ptype) : fieldLayout.type;
        ftype = resolveInParentStruct(context, ftype, parent);
        return {
            addr: addressAtOffset(parent.addr, fieldLayout.offset),
            type: ftype,
            size: fieldLayout.size,
            layout: context.programAnalysis.layoutOfType(ftype),
        };
    }
    return null;
}
// Resolve field types against sibling declarations in their owning struct.
export function resolveInParentStruct(context: FunctionEmissionContext, type: TypeSpec, parent: ResolvedAddress): TypeSpec {
    const declaration = parent.type?.kind === "inline_struct"
        ? parent.type.struct
        : parent.type?.kind === "name"
            ? context.programAnalysis.structByName(parent.type.name, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)
            : undefined;
    if (!declaration)
        return type;
    const nestedOf = (typeName: string): TypeSpec | null => {
        const structDeclaration = declaration.members.find((member) => member.kind === "struct" && (member as StructDecl).name === typeName) as StructDecl | undefined;
        return structDeclaration ? { kind: "inline_struct", struct: structDeclaration } : null;
    };
    if (type.kind === "name") {
        return nestedOf(type.name) ?? type;
    }
    if (type.kind === "template_instance") {
        let changed = false;
        const callArguments = type.callArguments.map((argument) => {
            if (argument.kind === "name") {
                const type = nestedOf(argument.name);
                if (type) {
                    changed = true;
                    return type;
                }
            }
            return argument;
        });
        return changed ? { ...type, callArguments } : type;
    }
    return type;
}
// Scalar lvalue (size <= 8) address+size, for load/store of a scalar field.
export function resolveLvalue(context: FunctionEmissionContext, expression: Expression): ResolvedLvalue | null {
    const resolvedAddress = resolveExpressionAddress(context, expression);
    if (!resolvedAddress)
        return null;
    return { addr: resolvedAddress.addr, size: resolvedAddress.size, type: resolvedAddress.type };
}
