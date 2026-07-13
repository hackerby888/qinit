import { SCALAR_SIZE } from "./tables";
import { emitProposalProxyAddr } from "./calls/proxy";
import { qpiWrapperMethod } from "./calls/dispatch";
import { emitAssetIter, classifyMethodParam, callCompiled } from "./calls/containers";
import { platformPrimitive } from "./platform-primitives";
import { lookupHelper, emitAggHelperCall } from "./calls/library-functions";
import { allocateTemporaryLocalName, collectFunctionLocals, emitStatement } from "./statement-emitter";
import { emitValue, isU128Expr, emitU128, lowerValueExpression, aggOperand } from "./expression-lowering";
import { CodeGenerationContext } from "./code-generation-context";
import { StructLayout, FieldLayout, FunctionEmissionContext, ResolvedAddress, EMPTY_TEMPLATE_BINDINGS, ResolvedLvalue } from "./types";
import type {
  TypeSpec,
  Expression,
  Statement,
  Declaration,
  StructDecl,
  FunctionDecl,
  FunctionTemplateDecl,
  VariableDecl,
  TemplateParam,
  ParamDecl,
} from "../ast";
import * as watIr from "../wat-ir";

// ---- lvalue addressing ----

// True if `state.get()` / `state.mut()`.
export function isStateAccessor(expression: Expression): boolean {
  return (
    expression.kind === "call" &&
    expression.callee.kind === "member_access" &&
    expression.callee.object.kind === "identifier" &&
    expression.callee.object.name === "state" &&
    (expression.callee.member === "mut" || expression.callee.member === "get")
  );
}

// id/m256i expose their 32 bytes as fixed-width limb views (`.u64`/`.u32`/`.u16`/`.u8`) with named limbs `_0.._N` at element-sized strides. Each
export function limbLayout(elemSize: number, count: number): StructLayout {
  const type: TypeSpec = {
    kind: "name",
    name:
      elemSize === 8 ? "uint64" : elemSize === 4 ? "uint32" : elemSize === 2 ? "uint16" : "uint8",
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
export function isIdLike(codeGenerationContext: CodeGenerationContext, type: TypeSpec | null): boolean {
  if (!type) return false;
  const dereferencedType = codeGenerationContext.derefType(type);
  if (dereferencedType.kind !== "name") return false;
  const separator = dereferencedType.name.lastIndexOf("::");
  const name = separator >= 0 ? dereferencedType.name.slice(separator + 2) : dereferencedType.name;
  return name === "id" || name === "m256i";
}
export function isUint128(codeGenerationContext: CodeGenerationContext, type: TypeSpec | null): boolean {
  if (!type) return false;
  const dereferencedType = codeGenerationContext.derefType(type);
  if (dereferencedType.kind !== "name" && dereferencedType.kind !== "template_instance") return false;
  const separator = dereferencedType.name.lastIndexOf("::");
  const name = separator >= 0 ? dereferencedType.name.slice(separator + 2) : dereferencedType.name;
  return name === "uint128" || name === "uint128_t";
}

// Resolve the address of an lvalue expression (member-access chains rooted at input/output/locals/state).
export function castInfo(expression: Expression): { type: TypeSpec; operand: Expression } | null {
  if (expression.kind === "static_cast" || expression.kind === "c_cast" || expression.kind === "reinterpret_cast")
    return { type: expression.type, operand: expression.expression };
  if (
    expression.kind === "template_call" &&
    expression.callee.kind === "identifier" &&
    /^(static|reinterpret|const)_cast$/.test(expression.callee.name) &&
    expression.templateArguments?.[0] &&
    expression.callArguments?.[0]
  ) {
    return { type: expression.templateArguments[0], operand: expression.callArguments[0] };
  }
  return null;
}

export function stripPtrRefConst(type: TypeSpec): TypeSpec {
  while (type.kind === "pointer" || type.kind === "reference" || type.kind === "const") {
    type = type.kind === "pointer" ? type.pointee : type.kind === "reference" ? type.referentType : type.valueType;
  }
  return type;
}

export function resolveExpressionAddress(context: FunctionEmissionContext, expression: Expression): ResolvedAddress | null {
  if (expression.kind === "paren") return resolveExpressionAddress(context, expression.expression);
  // __ScopedScratchpad.ptr → the held scratch buffer base (the local's value). `reinterpret_cast<T*>(sp.ptr)`
  if (
    expression.kind === "member_access" &&
    expression.member === "ptr" &&
    expression.object.kind === "identifier" &&
    context.scratchpadLocals?.has(expression.object.name)
  ) {
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
        size: context.codeGenerationContext.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
        layout: context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
      };
    }
    // an aggregate value-helper / container-method parameter holds the address of its argument; its type may reference template params
    const type = context.params?.get(expression.name);
    if (type && type.isAddr) {
      const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
      return {
        addr: `(local.get $${type.local ?? expression.name})`,
        type: type.type,
        size: context.codeGenerationContext.sizeOfType(type.type, templateBindings),
        layout: context.codeGenerationContext.layoutOfType(type.type, templateBindings),
      };
    }
    if (type) return null; // a scalar param has no address; don't let it fall through to the entry-fn names
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
    // bare `state` (a static helper taking ContractState& — QTF's enableBuyTicket(state, flag)): the resident state region. Only meaningful where
    if (expression.name === "state" && context.hasStateParam && !context.localVars.has("state")) {
      return {
        addr: "(local.get $__qinit_state)",
        type: null,
        size: context.state.size,
        layout: context.state,
      };
    }
    // inside a compiled container method (or an inlined struct method): `this`, or a bare member of *this
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
          layout: context.codeGenerationContext.layoutOfType(fieldLayout.type, context.thisBind),
        };
    }
    return null;
  }

  // arr[i] / ptr[i]: element address from an array member (this+off) or a pointer-valued operand.
  if (expression.kind === "subscript") {
    const base = resolveExpressionAddress(context, expression.object);
    let baseAddr: string | null = null,
      elemType: TypeSpec | null = null;
    if (base?.type?.kind === "array") {
      baseAddr = base.addr;
      elemType = base.type.element;
    } else if (base?.type?.kind === "pointer") {
      baseAddr = base.addr;
      elemType = base.type.pointee;
    }
    if (!baseAddr || !elemType) return null;
    const elemSize = context.codeGenerationContext.sizeOfType(elemType, context.thisBind);
    const idx = `(i32.mul (i32.wrap_i64 ${emitValue(context, expression.index)}) (i32.const ${elemSize}))`;
    return {
      addr: `(i32.add ${baseAddr} ${idx})`,
      type: elemType,
      size: elemSize,
      layout: context.codeGenerationContext.layoutOfType(elemType, context.thisBind),
    };
  }

  // ptr + n / ptr - n: pointer arithmetic — the address n elements away, staying pointer-typed (feeds
  if (expression.kind === "binary_op" && (expression.operator === "+" || expression.operator === "-")) {
    const base = resolveExpressionAddress(context, expression.left);
    const bt = base?.type;
    if (base && bt?.kind === "pointer") {
      const elemSize = context.codeGenerationContext.sizeOfType(bt.pointee, context.thisBind) || 8;
      const off = `(i32.mul (i32.wrap_i64 ${emitValue(context, expression.right)}) (i32.const ${elemSize}))`;
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
  // A pointer/reference cast reinterprets the same address as the target type (the base subobject of a single-inheritance derived
  {
    const ci = castInfo(expression);
    if (ci) {
      const inner = resolveExpressionAddress(context, ci.operand);
      const materialized = !inner && context.codeGenerationContext.gtestMode ? emitAddress(context, ci.operand) : null;
      if (!inner && !materialized) return null;
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
        size: context.codeGenerationContext.sizeOfType(type, templateBindings),
        layout: context.codeGenerationContext.layoutOfType(type, templateBindings),
      };
    }
  }

  // &lvalue (address-of) and *this (deref) are identity at the addressing level — the node already carries the operand's
  if (expression.kind === "unary_op" && expression.operator === "&") return resolveExpressionAddress(context, expression.argument);
  if (expression.kind === "unary_op" && expression.operator === "*") {
    if (expression.argument.kind === "this") return resolveExpressionAddress(context, expression.argument);
    // *cast<T*>(&X): the deref of a pointer cast is the cast operand's address, retyped to the pointee.
    const ci = castInfo(expression.argument);
    if (ci && ci.type.kind === "pointer") {
      const inner = resolveExpressionAddress(context, ci.operand);
      const materialized = !inner && context.codeGenerationContext.gtestMode ? emitAddress(context, ci.operand) : null;
      if (inner || materialized) {
        const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
        const type = stripPtrRefConst(ci.type);
        return {
          addr: inner?.addr ?? materialized!,
          type: type,
          size: context.codeGenerationContext.sizeOfType(type, templateBindings),
          layout: context.codeGenerationContext.layoutOfType(type, templateBindings),
        };
      }
    }
    // *ptr: a pointer param/local holds the pointed-to address, so dereferencing yields that address.
    const pn = resolveExpressionAddress(context, expression.argument);
    const pt = pn?.type ? context.codeGenerationContext.derefType(pn.type) : null;
    if (pn && pt?.kind === "pointer") {
      const pointee = pt.pointee;
      const byteSize = context.codeGenerationContext.sizeOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) || 8;
      return {
        addr: pn.addr,
        type: pointee,
        size: byteSize,
        layout: context.codeGenerationContext.layoutOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
      };
    }
    return null;
  }

  if (isStateAccessor(expression)) {
    // Inside a compiled struct/template method `state` is a ContractState& PARAM (NextEpochData::apply); the wasm local of the same name
    const layout = context.state.size > 0 ? context.state : context.codeGenerationContext.contractStateLayout;
    const stateParam = context.params?.get("state");
    const addr = stateParam?.isAddr
      ? `(local.get $${stateParam.local ?? "state"})`
      : "(local.get $__qinit_state)";
    return { addr, type: null, size: layout.size, layout };
  }

  // a container element getter (arr.get(i), map.value(i)/key(i)) is an lvalue we can keep chaining from
  if (expression.kind === "call") {
    const ce = resolveContainerElem(context, expression);
    if (ce) return ce;
    // obj.method(args) where method is an inline member of obj's struct returning a reference (the fluent `Element& init(...) {
    return tryInlineStructMethod(context, expression);
  }

  // member access: resolve the object, then index its field
  if (expression.kind === "member_access") {
    let parent = resolveExpressionAddress(context, expression.object);
    if (!parent && expression.object.kind === "call" && expression.object.callee.kind === "member_access") {
      const method = inlineMethodInfo(context, expression.object);
      if (method && context.codeGenerationContext.isAggregateType(context.codeGenerationContext.derefType(method.fn.returnType))) {
        const type = context.codeGenerationContext.derefType(method.fn.returnType);
        const addr = emitAddress(context, expression.object);
        if (addr)
          parent = {
            addr,
            type,
            size: Math.max(1, context.codeGenerationContext.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)),
            layout: context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
          };
      }
    }
    if (!parent && expression.object.kind === "call" && expression.object.callee.kind === "identifier") {
      const helper = lookupHelper(context, expression.object);
      if (helper?.retAgg && helper.retType) {
        const addr = emitAggHelperCall(context, expression.object, helper);
        parent = {
          addr,
          type: helper.retType,
          size: helper.retAgg,
          layout: context.codeGenerationContext.layoutOfType(helper.retType, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
        };
      }
    }
    // Member of an id-producing qpi call (`qpi.K12(x).u64._0`): resolveAddr has no lvalue for the call, but emitAddr materializes an
    if (
      !parent &&
      expression.object.kind === "call" &&
      expression.object.callee.kind === "member_access" &&
      expression.object.callee.object.kind === "identifier" &&
      expression.object.callee.object.name === "qpi"
    ) {
      const addr = emitAddress(context, expression.object);
      if (addr) parent = { addr, type: { kind: "name", name: "id" }, size: 32, layout: null };
    }
    if (!parent) return null;
    if (expression.arrow && parent.type?.kind === "pointer") {
      const pointee = parent.type.pointee;
      parent = {
        addr: parent.addr,
        type: pointee,
        size: context.codeGenerationContext.sizeOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
        layout: context.codeGenerationContext.layoutOfType(pointee, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
      };
    }
    // id/m256i limb views (`.u64`/`.u32`/`.u16`/`.u8`) → a fixed-width array at the value's base.
    if (isIdLike(context.codeGenerationContext, parent.type) && ID_VIEWS[expression.member]) {
      return { addr: parent.addr, type: null, size: 32, layout: ID_VIEWS[expression.member] };
    }
    // uint128 `.low` / `.high` → the low / high 64-bit half (low at offset 0).
    if (isUint128(context.codeGenerationContext, parent.type) && (expression.member === "low" || expression.member === "high")) {
      return {
        addr: addressAtOffset(parent.addr, expression.member === "low" ? 0 : 8),
        type: { kind: "name", name: "uint64" },
        size: 8,
        layout: null,
      };
    }
    if (!parent.layout) return null;
    const fieldLayout = parent.layout.fields.get(expression.member);
    if (!fieldLayout) return null;
    // A member type written in terms of the parent instance's own params / nested typedefs (e.g.
    let ptype: TypeSpec | null = parent.type;
    for (let index = 0; index < 8 && ptype?.kind === "name"; index++)
      ptype = context.codeGenerationContext.typedefs.get(ptype.name) ?? null;
    let ftype =
      ptype?.kind === "template_instance" ? context.codeGenerationContext.concreteMemberType(fieldLayout.type, ptype) : fieldLayout.type;
    ftype = resolveInParentStruct(context, ftype, parent);
    return {
      addr: addressAtOffset(parent.addr, fieldLayout.offset),
      type: ftype,
      size: fieldLayout.size,
      layout: context.codeGenerationContext.layoutOfType(ftype),
    };
  }

  return null;
}

// Resolve a field type spelled in its declaring struct's own scope — Array<Order,256> where Order is a sibling
export function resolveInParentStruct(context: FunctionEmissionContext, type: TypeSpec, parent: ResolvedAddress): TypeSpec {
  const declaration =
    parent.type?.kind === "inline_struct"
      ? parent.type.struct
      : parent.type?.kind === "name"
        ? context.codeGenerationContext.structByName(parent.type.name, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)
        : undefined;
  if (!declaration) return type;

  const nestedOf = (typeName: string): TypeSpec | null => {
    const structDeclaration = declaration.members.find((member) => member.kind === "struct" && (member as StructDecl).name === typeName) as
      StructDecl | undefined;
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
  if (!resolvedAddress) return null;
  return { addr: resolvedAddress.addr, size: resolvedAddress.size, type: resolvedAddress.type };
}

// Address of an lvalue or a materializable aggregate. Returns null if not addressable.
export function emitAddress(context: FunctionEmissionContext, expression: Expression): string | null {
  if (expression.kind === "identifier" && expression.name === "SELF") return "(call $self_id)";
  // an aggregate value-helper parameter is passed by address
  if (expression.kind === "identifier") {
    const type = context.params?.get(expression.name);
    if (type && type.isAddr) return `(local.get $${type.local ?? expression.name})`;
  }
  if (expression.kind === "paren") return emitAddress(context, expression.expression);

  if (expression.kind === "call") {
    const cached = context.materializedCalls?.get(expression);
    if (cached) return cached.addr;
  }

  if (
    expression.kind === "call" &&
    (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")
  ) {
    const primitive = platformPrimitive(expression.callee.name);
    if (primitive?.result === "address") {
      for (const capability of primitive.capabilities ?? []) context.codeGenerationContext.capabilities.add(capability);
      if (expression.callArguments.length !== primitive.operands.length) {
        throw new Error(
          `${primitive.name} expects ${primitive.operands.length} argument(s), got ${expression.callArguments.length}`,
        );
      }
      const destination = allocateScratchSlotNode(context, 32);
      if (primitive.kind === "zero") {
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$setMem", destination, watIr.i32Constant(32), watIr.i32Constant(0)))}`);
      } else if (primitive.kind === "lane-pack-64") {
        for (let lane = 0; lane < 4; lane++) {
          context.lines.push(
            `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", lane * 8, destination, lowerValueExpression(context, expression.callArguments[3 - lane])))}`,
          );
        }
      } else if (primitive.kind === "lane-pack-8") {
        for (let lane = 0; lane < 32; lane++) {
          const byte = watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[31 - lane]));
          context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i32.store8", lane, destination, byte))}`);
        }
      } else if (primitive.kind === "memory-load") {
        const source = emitAddress(context, expression.callArguments[0]);
        if (!source) throw new Error(`${primitive.name} source is not addressable`);
        context.lines.push(
          `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, addrIr(source), watIr.i32Constant(32)))}`,
        );
      } else if (primitive.kind === "lane-compare-64") {
        const left = emitAddress(context, expression.callArguments[0]);
        const right = emitAddress(context, expression.callArguments[1]);
        if (!left || !right) throw new Error(`${primitive.name} operands must be addressable`);
        for (let lane = 0; lane < 4; lane++) {
          const argument = watIr.rawLoad("i64.load", lane * 8, addrIr(left));
          const templateBindings = watIr.rawLoad("i64.load", lane * 8, addrIr(right));
          const value = watIr.selectValue(watIr.i64Constant(-1), watIr.i64Constant(0), watIr.operation("i64.eq", argument, templateBindings));
          context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", lane * 8, destination, value))}`);
        }
      } else {
        throw new Error(
          `platform primitive '${primitive.name}' cannot produce an address via ${primitive.kind}`,
        );
      }
      return watIr.serializeWatNode(destination);
    }
  }

  if (
    context.codeGenerationContext.gtestMode &&
    expression.kind === "call" &&
    (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")
  ) {
    const calleeName = expression.callee.name;
    if (calleeName === "__qtest_state") {
      const sizeExpr = expression.callArguments[1];
      const size =
        sizeExpr?.kind === "sizeof_expr" && sizeExpr.expression.kind === "identifier"
          ? context.codeGenerationContext.sizeOfType({ kind: "name", name: sizeExpr.expression.name }, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)
          : sizeExpr
            ? Number(context.codeGenerationContext.evalConstBig(sizeExpr, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS))
            : 0;
      if (!(size > 0))
        throw new Error("gtest state access requires a constant positive state size");
      const destination = allocateScratchSlotNode(context, size);
      const slot = watIr.operation(
        "i32.wrap_i64",
        expression.callArguments[0] ? lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0),
      );
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_state", slot, destination, watIr.i32Constant(size))))}`,
      );
      const addr = watIr.serializeWatNode(destination);
      (context.materializedCalls ??= new WeakMap()).set(expression, { addr, type: null, size, layout: null });
      return addr;
    }

    // Core-lite fixtures commonly pass an empty input temporary directly to callFunction, for example
    // `callFunction(..., CCF::GetProposalFee_input(), output)`. It has the same zero-initialized object
    if (expression.callArguments.length === 0) {
      const type: TypeSpec = { kind: "name", name: calleeName };
      const size = context.codeGenerationContext.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
      if (size > 0 || /_(?:input|output)$/.test(calleeName)) {
        const destination = size > 0 ? allocateScratchSlotNode(context, size) : watIr.i32Constant(0);
        if (size > 0)
          context.lines.push(
            `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", destination, watIr.i32Constant(size), watIr.i32Constant(0)))}`,
          );
        const addr = watIr.serializeWatNode(destination);
        (context.materializedCalls ??= new WeakMap()).set(expression, {
          addr,
          type,
          size,
          layout: context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
        });
        return addr;
      }
    }
  }

  if (context.codeGenerationContext.gtestMode && expression.kind === "call" && expression.callee.kind === "member_access") {
    const resolved = inlineMethodInfo(context, expression);
    if (resolved && context.codeGenerationContext.isAggregateType(context.codeGenerationContext.derefType(resolved.fn.returnType))) {
      const type = context.codeGenerationContext.derefType(resolved.fn.returnType);
      const size = Math.max(1, context.codeGenerationContext.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
      const destination = allocateScratchSlotNode(context, size);
      emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments, {
        retAddr: watIr.serializeWatNode(destination),
        retSize: size,
      });
      const addr = watIr.serializeWatNode(destination);
      (context.materializedCalls ??= new WeakMap()).set(expression, {
        addr,
        type,
        size,
        layout: context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS),
      });
      return addr;
    }
  }

  // A computed uint128 value must go through its source-compiled constructor/operator
  // before it is passed by reference. In particular, do this before stripping a C-style
  if (
    (expression.kind === "call" ||
      expression.kind === "template_call" ||
      expression.kind === "construct" ||
      expression.kind === "binary_op" ||
      expression.kind === "c_cast" ||
      expression.kind === "static_cast" ||
      expression.kind === "ternary") &&
    isU128Expr(context, expression)
  ) {
    return emitU128(context, expression);
  }
  if (expression.kind === "c_cast" || expression.kind === "static_cast") return emitAddress(context, expression.expression);

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot
  if (expression.kind === "ternary") {
    const ta = resolveExpressionAddress(context, expression.then)?.addr ?? emitAddress(context, expression.then);
    const ea = ta ? (resolveExpressionAddress(context, expression.else_)?.addr ?? emitAddress(context, expression.else_)) : null;
    if (ta && ea) {
      const branchAddress = allocateTemporaryLocalName(context);
      context.lines.push(
        `    ${setLocal(context, branchAddress, watIr.selectValue(addrIr(ta), addrIr(ea), watIr.operation("i64.ne", watIr.i64Constant(0), lowerValueExpression(context, expression.condition))))}`,
      );
      return `(local.get $${branchAddress})`;
    }
  }

  // min/max over id/m256i operands select an address by the 256-bit lexicographic compare (mirroring the contract-defined `const T&`-returning template
  if (
    expression.kind === "call" &&
    expression.callArguments.length === 2 &&
    (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")
  ) {
    const cname = expression.callee.kind === "identifier" ? expression.callee.name : expression.callee.name;
    const base = cname.includes("::") ? cname.slice(cname.lastIndexOf("::") + 2) : cname;
    if (base === "min" || base === "max") {
      const la = aggOperand(context, expression.callArguments[0]);
      const ra = la ? aggOperand(context, expression.callArguments[1]) : null;
      if (la && ra && la.size === 32 && ra.size === 32) {
        const selectedAddress = allocateTemporaryLocalName(context);
        const cmp = watIr.functionCall("$m256_lt", addrIr(la.addr), addrIr(ra.addr));
        const pick =
          base === "min"
            ? watIr.selectValue(addrIr(la.addr), addrIr(ra.addr), cmp)
            : watIr.selectValue(addrIr(ra.addr), addrIr(la.addr), cmp);
        context.lines.push(`    ${setLocal(context, selectedAddress, pick)}`);
        return `(local.get $${selectedAddress})`;
      }
    }
  }

  // aggregate construction Type{...} as an rvalue/argument — materialize into a scratch slot.
  if (expression.kind === "construct") {
    const byteSize = context.codeGenerationContext.sizeOfType(expression.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
    if (byteSize > 0) {
      const scratchAddress = allocateScratchSlot(context, byteSize);
      if (emitConstruct(context, scratchAddress, expression.type, expression.callArguments)) return scratchAddress;
    }
  }

  // Plain aggregate constructor syntax is normalized through the authoritative class constructor.
  if (
    expression.kind === "call" &&
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "id" || expression.callee.name === "m256i")
  ) {
    const type: TypeSpec = { kind: "name", name: expression.callee.name };
    const destination = allocateScratchSlot(context, 32);
    if (!emitConstruct(context, destination, type, expression.callArguments)) {
      throw new Error(`authoritative ${expression.callee.name} constructor could not be lowered`);
    }
    return destination;
  }

  // A qualified static method returning an aggregate is compiled from the owning
  // struct's authoritative body. Typedef owners (id -> m256i) resolve to the same
  if (
    expression.kind === "call" &&
    (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name")
  ) {
    const qualified = expression.callee.name;
    const separator = qualified.lastIndexOf("::");
    if (separator > 0) {
      const ownerSpelling = qualified.slice(0, separator);
      const method = qualified.slice(separator + 2);
      // Resolve NS::Type (or Type) without assuming a QPI:: prefix — try full spelling, then tail.
      const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
      const resolveOwner = (spelling: string): { type: TypeSpec; struct: StructDecl } | null => {
        const type = context.codeGenerationContext.resolveType({ kind: "name", name: spelling }, bind);
        const struct = context.codeGenerationContext.structOf(type, bind);
        return struct ? { type, struct } : null;
      };
      let owner = resolveOwner(ownerSpelling);
      if (!owner && ownerSpelling.includes("::")) {
        const tail = ownerSpelling.slice(ownerSpelling.lastIndexOf("::") + 2);
        owner = resolveOwner(tail);
      }
      if (owner) {
        const declaration = owner.struct.members.find(
          (member): member is FunctionDecl =>
            member.kind === "function" &&
            member.name === method &&
            member.isStatic &&
            !!member.body,
        );
        if (declaration && context.codeGenerationContext.isAggregateType(context.codeGenerationContext.derefType(declaration.returnType))) {
          const concreteOwner = owner.type.kind === "name" ? owner.type.name : owner.struct.name;
          const target: TypeSpec & { kind: "template_instance" } = {
            kind: "template_instance",
            name: concreteOwner,
            callArguments: [],
          };
          const compiled = callCompiled(context, target, method, "(i32.const 0)", expression.callArguments);
          if (!compiled?.retDest || !compiled.cm.retType) {
            throw new Error(
              `authoritative static aggregate method ${qualified} could not be lowered`,
            );
          }
          context.lines.push(`    ${compiled.call}`);
          const type = context.codeGenerationContext.substInBindings(context.codeGenerationContext.derefType(compiled.cm.retType), bind);
          const size = compiled.cm.retAgg ?? context.codeGenerationContext.sizeOfType(type, bind);
          (context.materializedCalls ??= new WeakMap()).set(expression, {
            addr: compiled.retDest,
            type,
            size,
            layout: context.codeGenerationContext.layoutOfType(type, bind),
          });
          return compiled.retDest;
        }
      }
    }
  }

  // a call to a helper that returns an aggregate by value (id liquidityPov(...)) → materialize into a slot.
  if (expression.kind === "call" && expression.callee.kind === "identifier") {
    const hinfo = lookupHelper(context, expression);
    if (hinfo?.retAgg) return emitAggHelperCall(context, expression, hinfo);
  }

  // AssetOwnership/PossessionIterator.possessor()/owner() → address of the id in the current buffer record.
  if (expression.kind === "call" && expression.callee.kind === "member_access") {
    const ai = emitAssetIter(context, expression, "addr");
    if (ai !== null) return ai;
  }

  // qpi(X).method(...) returning an id/struct (proposerId): compile the real proxy method and materialize the result into its $ret slot
  if (expression.kind === "call" && qpiWrapperMethod(expression)) {
    const pa = emitProposalProxyAddr(context, expression);
    if (pa !== null) return pa;
  }

  const resolvedAddress = resolveExpressionAddress(context, expression);
  return resolvedAddress ? resolvedAddress.addr : null;
}

// A call `obj.method(args)` where method is an inline member of obj's struct that returns a reference (the fluent
export function tryInlineStructMethod(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): ResolvedAddress | null {
  if (expression.callee.kind !== "member_access") return null;
  const method = expression.callee.member;
  const objNode = resolveExpressionAddress(context, expression.callee.object);
  if (!objNode || !objNode.layout || !objNode.type) return null;
  const struct = context.codeGenerationContext.structOf(objNode.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
  if (!struct) return null;
  const fn = struct.members.find(
    (member) => member.kind === "function" && (member as FunctionDecl).name === method && (member as FunctionDecl).body,
  ) as FunctionDecl | undefined;
  if (!fn) return null;
  // This address channel is only valid for fluent/reference-returning methods. Scalar methods
  // such as WinnerData::isValid() must flow through normal value-call compilation; inlining them
  const returnsAddress = (type: TypeSpec): boolean =>
    type.kind === "reference" ||
    type.kind === "pointer" ||
    (type.kind === "const" && returnsAddress(type.valueType));
  if (!returnsAddress(fn.returnType)) return null;
  const addr = emitInlineStructMethod(context, objNode, fn, expression.callArguments);
  return { addr, type: objNode.type, size: objNode.size, layout: objNode.layout };
}

function inlineMethodInfo(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): { object: ResolvedAddress; fn: FunctionDecl } | null {
  if (expression.callee.kind !== "member_access") return null;
  const object = resolveExpressionAddress(context, expression.callee.object);
  if (!object?.type || !object.layout) return null;
  if (object.type.kind === "template_instance") return null;
  const struct = context.codeGenerationContext.structOf(object.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
  const method = expression.callee.member;
  const fn = struct?.members.find(
    (member) =>
      member.kind === "function" &&
      (member as FunctionDecl).name === method &&
      (member as FunctionDecl).body,
  ) as FunctionDecl | undefined;
  return fn ? { object, fn } : null;
}

export function emitInlineStructValue(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): watIr.WatNode | null {
  if (!context.codeGenerationContext.gtestMode) return null;
  const resolved = inlineMethodInfo(context, expression);
  if (
    !resolved ||
    context.codeGenerationContext.isVoidType(resolved.fn.returnType) ||
    context.codeGenerationContext.isAggregateType(context.codeGenerationContext.derefType(resolved.fn.returnType))
  )
    return null;
  const result = allocateTemporaryLocalName(context);
  context.localVars.set(result, { wasmType: "i64", type: context.codeGenerationContext.derefType(resolved.fn.returnType) });
  context.lines.push(`    ${setLocal(context, result, watIr.i64Constant(0))}`);
  emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments, { retValue: result });
  return watIr.localGet(result, "i64");
}

export function emitInlineStructStatement(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): boolean {
  if (!context.codeGenerationContext.gtestMode) return false;
  const resolved = inlineMethodInfo(context, expression);
  if (!resolved) return false;
  emitInlineStructMethod(context, resolved.object, resolved.fn, expression.callArguments);
  return true;
}

function renameInlineLocals(body: Statement, suffix: string): Statement {
  const names = new Map<string, string>();
  const collect = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (node.kind === "variable" && node.isMember === false && typeof node.name === "string") {
      names.set(node.name, `${node.name}${suffix}`);
    }
    for (const child of Object.values(node)) collect(child);
  };
  collect(body);
  const clone = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(clone);
    const node = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(node)) out[key] = clone(child);
    if (
      (node.kind === "identifier" || (node.kind === "variable" && node.isMember === false)) &&
      typeof node.name === "string"
    ) {
      out.name = names.get(node.name) ?? node.name;
    }
    return out;
  };
  return clone(body) as Statement;
}

// Emit a struct member method inline into the current function: stash the object address in a temp (used
export function emitInlineStructMethod(
  context: FunctionEmissionContext,
  objNode: ResolvedAddress,
  fn: FunctionDecl,
  callArguments: Expression[],
  result: { retAddr?: string; retSize?: number; retValue?: string } = {},
): string {
  const self = allocateTemporaryLocalName(context);
  context.lines.push(`    ${setLocal(context, self, addrIr(objNode.addr))}`);
  const bind = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;

  const params = new Map<
    string,
    { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }
  >();
  for (let parameterIndex = 0; parameterIndex < fn.params.length; parameterIndex++) {
    const parameter = fn.params[parameterIndex];
    const cls = classifyMethodParam(context.codeGenerationContext, parameter, bind);
    const slot = `marg${context.tmpCount++}`;
    context.localVars.set(slot, { wasmType: cls.wasmType });
    const argument = callArguments[parameterIndex] ?? parameter.defaultValue;
    const paramType = context.codeGenerationContext.substInBindings(context.codeGenerationContext.derefType(parameter.type), bind);
    if (argument) {
      const value = cls.isAddr
        ? addrIr(
            argAddr(
              context,
              argument,
              context.codeGenerationContext.sizeOfType(paramType, bind),
              paramType,
              cls.readOnlyRef === true,
            ),
          )
        : lowerValueExpression(context, argument);
      context.lines.push(`    ${setLocal(context, slot, value)}`);
    }
    // Keep dependent fields concrete inside the inlined body. Leaving `T` here made a `const T&`
    // parameter fall back to a signed 32-bit load even when the owning container bound T=uint64.
    params.set(parameter.name, {
      wasmType: cls.wasmType,
      isAddr: cls.isAddr,
      type: paramType,
      local: slot,
    });
  }

  const save = {
    thisLayout: context.thisLayout,
    thisType: context.thisType,
    thisAddr: context.thisAddr,
    params: context.params,
    inlineMethod: context.inlineMethod,
    retIsValue: context.retIsValue,
    retAddr: context.retAddr,
    retAggSize: context.retAggSize,
    retType: context.retType,
    inlineReturnLabel: context.inlineReturnLabel,
    inlineValueLocal: context.inlineValueLocal,
    retTypeName: context.retTypeName,
  };
  context.thisLayout = objNode.layout ?? undefined;
  context.thisType = objNode.type ?? undefined;
  context.thisAddr = `(local.get $${self})`;
  context.params = params;
  context.inlineMethod = true;
  context.retIsValue = false;
  context.retAddr = result.retAddr;
  context.retAggSize = result.retSize;
  context.retType = context.codeGenerationContext.derefType(fn.returnType);
  context.inlineValueLocal = result.retValue;
  context.retTypeName = fn.returnType.kind === "name" ? fn.returnType.name : undefined;
  const returnLabel = `$inline_return_${context.loopCount++}`;
  context.inlineReturnLabel = returnLabel;
  // Hoist the inlined body's own local declarations into the host function's local set — the top-level collectLocals never
  const body = fn.body ? renameInlineLocals(fn.body, `__inline${context.tmpCount++}`) : undefined;
  if (body) collectFunctionLocals(body, context);
  context.lines.push(`    (block ${returnLabel}`);
  if (body) emitStatement(context, body);
  context.lines.push("    )");
  Object.assign(context, save);

  return `(local.get $${self})`;
}

// Resolve a container element getter to an addressable node: Array.get(i) → T, HashMap value(i) → V / key(i)
export function resolveContainerElem(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
): ResolvedAddress | null {
  if (expression.callee.kind !== "member_access") return null;
  const cached = context.materializedCalls?.get(expression);
  if (cached) return cached;
  const node = resolveExpressionAddress(context, expression.callee.object);
  if (!node || !node.type) return null;
  // Follow typedefs / template-param bindings to the concrete container instance (e.g. RevenueDonationT →
  let ct: TypeSpec | null = node.type;
  for (let index = 0; index < 8 && ct?.kind === "name"; index++) {
    const next: TypeSpec | undefined =
      context.thisBind?.types.get(ct.name) ?? context.codeGenerationContext.typedefs.get(ct.name);
    if (!next) break;
    ct = next;
  }
  if (
    ct?.kind === "name" &&
    (context.codeGenerationContext.globalStructs.has(ct.name) || context.codeGenerationContext.templateMethods.has(ct.name))
  ) {
    ct = { kind: "template_instance", name: ct.name, callArguments: [] };
  }
  if (!ct || ct.kind !== "template_instance") return null;
  const ctype = ct;
  const member = expression.callee.member;
  const mk = (addr: string, elemType: TypeSpec): ResolvedAddress => ({
    addr,
    type: elemType,
    size: context.codeGenerationContext.sizeOfType(elemType),
    layout: context.codeGenerationContext.layoutOfType(elemType),
  });

  const compiled = callCompiled(context, ctype, member, node.addr, expression.callArguments);
  if (!compiled || (compiled.cm.retKind !== "i32" && !compiled.cm.retAgg)) return null;
  if (!compiled?.cm.retType) {
    throw new Error(
      `authoritative aggregate/reference method ${ctype.name}::${member} could not be lowered`,
    );
  }
  if (compiled.retDest) context.lines.push(`    ${compiled.call}`);
  const result = mk(compiled.retDest ?? compiled.call, compiled.cm.retType);
  if (compiled.retDest) (context.materializedCalls ??= new WeakMap()).set(expression, result);
  return result;
}

// Aggregate construction `Type{ a, b, c }` written into dstAddr: zero the target, then store each arg into
export function emitConstruct(
  context: FunctionEmissionContext,
  dstAddr: string,
  type: TypeSpec,
  callArguments: Expression[],
): boolean {
  const resolved = context.codeGenerationContext.resolveType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
  const owner =
    resolved.kind === "name"
      ? resolved.name
      : resolved.kind === "template_instance"
        ? resolved.name
        : type.kind === "name"
          ? type.name
          : null;
  if (owner && context.codeGenerationContext.templateMethods.get(owner)?.has(owner)) {
    const instance: TypeSpec & { kind: "template_instance" } = {
      kind: "template_instance",
      name: owner,
      callArguments: resolved.kind === "template_instance" ? resolved.callArguments : [],
    };
    const compiled = callCompiled(context, instance, owner, dstAddr, callArguments);
    if (!compiled || compiled.cm.retKind !== "void") {
      throw new Error(`authoritative ${owner} constructor could not be lowered`);
    }
    context.lines.push(`    ${compiled.call}`);
    return true;
  }
  const layout = context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS);
  if (!layout) return false;
  const fields = [...layout.fields.values()];
  const destinationBase = allocateTemporaryLocalName(context);
  context.lines.push(`    ${setLocal(context, destinationBase, addrIr(dstAddr))}`);
  context.lines.push(
    `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(destinationBase, "i32"), watIr.i32Constant(layout.size), watIr.i32Constant(0)))}`,
  );
  for (let index = 0; index < callArguments.length && index < fields.length; index++) {
    const field = fields[index];
    const fieldDestination = watIr.addressWithOffset(watIr.localGet(destinationBase, "i32"), field.offset);
    if (isAggregate(context, field.type, field.size)) {
      const argument = callArguments[index];
      const nestedArgs =
        argument.kind === "initializer_list" ? argument.expressions : argument.kind === "construct" ? argument.callArguments : null;
      if (nestedArgs && emitConstruct(context, watIr.serializeWatNode(fieldDestination), field.type, nestedArgs)) continue;
      const src = emitAddress(context, argument);
      if (src)
        context.lines.push(
          `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", fieldDestination, addrIr(src), watIr.i32Constant(field.size)))}`,
        );
    } else {
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.storeScalar(fieldDestination, field.size, lowerValueExpression(context, callArguments[index])))}`,
      );
    }
  }
  return true;
}

// Materialize a 256-bit id/m256i from up to four 64-bit limb expressions into scratch; returns its addr.
export function materializeId(context: FunctionEmissionContext, limbs: Expression[]): string {
  const size = allocateScratchSlotNode(context, 32);
  for (let index = 0; index < 4; index++) {
    const value = limbs[index] ? lowerValueExpression(context, limbs[index]) : watIr.i64Constant(0);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, watIr.addressWithOffset(size, index * 8), value))}`);
  }
  return watIr.serializeWatNode(size);
}

// True if a type is an aggregate (id/m256i/struct/array) that lives in memory rather than an i64.
export function isAggregate(context: FunctionEmissionContext, type: TypeSpec | null, size: number): boolean {
  if (!type) return size > 8;
  if (type.kind === "name" && (type.name === "id" || type.name === "m256i")) return true;
  if (type.kind === "array" || type.kind === "inline_struct" || type.kind === "template_instance")
    return true;
  if (type.kind === "name" && context.codeGenerationContext.layoutOfType(type)) return true;
  return size > 8;
}

// Typed local.set line: the value's width is checked against the local's declared wasm type, so an i64 flowing
export function setLocal(context: FunctionEmissionContext, name: string, value: watIr.WatNode): string {
  const lv = context.localVars.get(name) ?? context.params?.get(name);
  if (lv) {
    watIr.assertWatType(value, lv.wasmType, `local.set $${name}`);
  }
  return watIr.serializeWatNode(watIr.localSet(name, value));
}

// Allocate a fresh scratch block, stash its address in a temporary local, and return its local.get node.
export function allocateScratchSlotNode(context: FunctionEmissionContext, size: number): watIr.WatNode {
  const temporaryAddress = allocateTemporaryLocalName(context);
  context.lines.push(
    `    ${watIr.serializeWatNode(watIr.localSet(temporaryAddress, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(size))))}`,
  );
  return watIr.localGet(temporaryAddress, "i32");
}

export function allocateScratchSlot(context: FunctionEmissionContext, size: number): string {
  return watIr.serializeWatNode(allocateScratchSlotNode(context, size));
}

// Address of an argument: use an existing lvalue directly, or materialize a
// temporary according to the declaration's concrete parameter type.
export function argAddr(
  context: FunctionEmissionContext,
  expression: Expression,
  size: number,
  type?: TypeSpec,
  copyConstScalar = false,
  convertScalarToAggregate = false,
): string {
  const targetAggregate = !!type && context.codeGenerationContext.isAggregateType(type);
  const source = convertScalarToAggregate ? resolveExpressionAddress(context, expression) : null;
  const sourceAggregate =
    (!!source && isAggregate(context, source.type, source.size)) ||
    (expression.kind === "construct" && context.codeGenerationContext.isAggregateType(expression.type)) ||
    isU128Expr(context, expression);
  const convertToAggregate = convertScalarToAggregate && targetAggregate && !sourceAggregate;
  const copyValue = copyConstScalar && !!type && !targetAggregate;
  if (!copyValue && !convertToAggregate) {
    const emittedAddress = emitAddress(context, expression);
    if (emittedAddress) return emittedAddress;
  }
  const scratchAddress = allocateScratchSlot(context, size);
  if (
    type &&
    (convertToAggregate || expression.kind === "initializer_list" || expression.kind === "construct")
  ) {
    const callArguments =
      expression.kind === "initializer_list"
        ? expression.expressions
        : expression.kind === "construct"
          ? expression.callArguments
          : [expression];
    if (!emitConstruct(context, scratchAddress, type, callArguments)) {
      throw new Error("aggregate argument initializer could not be constructed");
    }
    return scratchAddress;
  }
  context.lines.push(`    ${emitScalarStore(scratchAddress, size, emitValue(context, expression))}`);
  return scratchAddress;
}

export function addressAtOffset(ptr: string, offset: number): string {
  return watIr.serializeWatNode(watIr.addressWithOffset(watIr.rawWatNode(ptr, "i32"), offset));
}

// Load a scalar into the i64 value model. Signed sub-64-bit fields MUST sign-extend — else a sint32 holding
export function emitScalarLoad(addr: string, size: number, signed = false): string {
  return watIr.serializeWatNode(lowerScalarLoad(addr, size, signed));
}

// Same load, as a typed node — for value-channel callers holding a string address (resolveAddr/Lvalue stay string-typed until
export function lowerScalarLoad(addr: string, size: number, signed = false): watIr.WatNode {
  return watIr.loadScalar(addrIr(addr), size, signed);
}

// Wrap a string-typed address (the resolveAddr/emitAddr channel) as a typed i32 node.
export function addrIr(addressText: string): watIr.WatNode {
  return watIr.rawWatNode(addressText, "i32", "lvalue address channel");
}

export const SIGNED_SCALARS = new Set([
  "sint8",
  "sint16",
  "sint32",
  "sint64",
  "signed char",
  "signed short",
  "signed int",
  "signed long long",
  "long long",
  "int",
  "short",
  "char",
]);
export function isSignedScalarType(type: TypeSpec | null | undefined, codeGenerationContext?: CodeGenerationContext): boolean {
  if (!type) return false;
  if (type.kind === "const") return isSignedScalarType(type.valueType, codeGenerationContext);
  if (codeGenerationContext) type = codeGenerationContext.scalarStorageType(type);
  if (type.kind === "name") return SIGNED_SCALARS.has(type.name);
  return false;
}

export function emitScalarStore(addr: string, size: number, value: string): string {
  return watIr.serializeWatNode(watIr.storeScalar(watIr.rawWatNode(addr, "i32"), size, watIr.rawWatNode(value, "i64")));
}

// Narrow a 64-bit register value to a sub-64-bit scalar type, matching a C++ conversion: unsigned types mask to
export function narrowCastIr(inner: watIr.WatNode, typeName: string | undefined): watIr.WatNode {
  if (!typeName) return inner;
  const byteWidth = SCALAR_SIZE[typeName];
  if (byteWidth === undefined || byteWidth >= 8) return inner;

  if (typeName === "bit" || typeName === "bool") {
    return watIr.operation("i64.extend_i32_u", watIr.operation("i64.ne", watIr.i64Constant(0), inner));
  }
  if (typeName.startsWith("sint") || typeName.startsWith("signed")) {
    const operator = byteWidth === 4 ? "i64.extend32_s" : byteWidth === 2 ? "i64.extend16_s" : "i64.extend8_s";
    return watIr.operation(operator, inner);
  }
  const mask = byteWidth === 4 ? "0xffffffff" : byteWidth === 2 ? "0xffff" : "0xff";
  return watIr.operation("i64.and", inner, watIr.i64Constant(mask));
}

export function narrowCast(inner: string, typeName: string | undefined): string {
  return watIr.serializeWatNode(narrowCastIr(watIr.rawWatNode(inner, "i64"), typeName));
}
