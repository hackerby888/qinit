import { CodeGenerationContext } from "./code-generation-context";
import { emitAggHelperCall, emitHelperCall, lookupHelper, pickHelperOverload } from "./calls/library-functions";
import { SCALAR_SIZE, MATH_INTRINSIC_NAMES, symbolBaseName } from "./tables";
import { isScalarLocal, emitIncrementOrDecrement, allocateTemporaryLocalName } from "./statement-emitter";
import { describeShape, emitCallValueIr } from "./calls/dispatch";
import { emitTemplateContainerCall } from "./calls/containers";
import { callCompiled, emitAssetIter } from "./calls/containers";
import {
  resolveExpressionAddress,
  isUint128,
  addrIr,
  isAggregate,
  emitConstruct,
  emitAddress,
  emitInlineStructValue,
  setLocal,
  narrowCastIr,
  lowerScalarLoad,
  isSignedScalarType,
  allocateScratchSlotNode,
} from "./address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "./types";
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

function newValueTmp(context: FunctionEmissionContext): string {
  let name: string;
  do name = `__qinit_value${context.tmpCount++}`;
  while (context.localVars.has(name) || context.params?.has(name));
  context.localVars.set(name, { wasmType: "i64" });
  return name;
}

// ---- assignment ----

// Lowers an assignment by pushing WAT lines to the function context; returns "" because the statement is fully emitted.
export function emitAssign(context: FunctionEmissionContext, expression: Expression & { kind: "assign" }): string {
  if (
    context.codeGenerationContext.gtestMode &&
    expression.operator === "=" &&
    expression.left.kind === "member_access" &&
    expression.left.object.kind === "identifier" &&
    expression.left.object.name === "system" &&
    (expression.left.member === "epoch" || expression.left.member === "tick")
  ) {
    const host = expression.left.member === "epoch" ? "$qt_set_epoch" : "$qt_set_tick";
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall(host, watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.right))))}`,
    );
    return "";
  }
  const lhs = resolveExpressionAddress(context, expression.left);

  // uint128 plain assignment materializes RHS through source-compiled uint128_t helpers for computed expressions.
  if (lhs && expression.operator === "=" && isUint128(context.codeGenerationContext, lhs.type)) {
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), lowerUint128Expression(context, expression.right), watIr.i32Constant(16)))}`,
    );
    return "";
  }

  // aggregate target (id/m256i/struct/array): copy by value, or let a qpi producer write into it
  if (lhs && expression.operator === "=" && isAggregate(context, lhs.type, lhs.size)) {
    // Assignment-form iterator construction (`locals.aoi = AssetOwnershipIterator(asset)`): the RHS `Type(...)` parses as a plain call, so it has no
    if (
      lhs.type?.kind === "name" &&
      /Asset(Ownership|Possession)Iterator$/.test(lhs.type.name) &&
      (expression.right.kind === "call" || expression.right.kind === "construct") &&
      ((expression.right.kind === "call" &&
        expression.right.callee.kind === "identifier" &&
        /Asset(Ownership|Possession)Iterator$/.test(expression.right.callee.name)) ||
        expression.right.kind === "construct")
    ) {
      const argument = expression.right.callArguments[0];
      if (argument) {
        emitAssetIter(
          context,
          {
            kind: "call",
            span: expression.span,
            callArguments: [argument],
            callee: { kind: "member_access", span: expression.span, object: expression.left, member: "begin" },
          } as Expression & { kind: "call" },
          "stmt",
        );
      } else {
        context.lines.push(
          `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, addrIr(lhs.addr), watIr.i64Constant(0)))}`,
        ); // zero count+cursor
      }
      return "";
    }
    // aggregate construction `target = Type{ ... }` (e.g. a Logger) — materialize the fields in place.
    if (
      expression.right.kind === "construct" &&
      lhs.type &&
      emitConstruct(context, lhs.addr, lhs.type, expression.right.callArguments)
    ) {
      return "";
    }
    // bare brace-init-list `target = { a, b, c };` — same field-wise materialization, typed by the target.
    if (
      expression.right.kind === "initializer_list" &&
      lhs.type &&
      emitConstruct(context, lhs.addr, lhs.type, expression.right.expressions)
    ) {
      return "";
    }
    const src = emitAddress(context, expression.right);
    if (src) {
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), addrIr(src), watIr.i32Constant(lhs.size)))}`,
      );
      return "";
    }
    context.codeGenerationContext.warn(
      `unsupported aggregate assignment [${describeShape(expression.left)} = ${describeShape(expression.right)}]`,
      expression.span.line,
    );
    return "";
  }

  // uint128 compound assignment (z >>= n, prod -= y + z): lhs = lhs <op> rhs via the
  if (lhs && expression.operator !== "=" && isUint128(context.codeGenerationContext, lhs.type)) {
    const binOp = expression.operator.slice(0, -1);
    const src = lowerUint128Expression(context, {
      kind: "binary_op",
      operator: binOp,
      left: expression.left,
      right: expression.right,
      span: expression.span,
    } as Expression & { kind: "binary_op" });
    context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(lhs.addr), src, watIr.i32Constant(16)))}`);
    return "";
  }

  // scalar field target
  if (lhs) {
    if (expression.operator === "=") {
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.storeScalar(addrIr(lhs.addr), lhs.size, lowerValueExpression(context, expression.right)))}`,
      );
      return "";
    }

    // Compound assignment lowers as lhs = lhs <op> rhs so the binary op carries the operands' real types
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.storeScalar(addrIr(lhs.addr), lhs.size, lowerValueExpression(context, compoundToBinary(expression))))}`,
    );
    return "";
  }

  // local variable / scalar value-parameter target (both are mutable wasm locals)
  if (expression.left.kind === "identifier" && isScalarLocal(context, expression.left.name)) {
    const name = expression.left.name;
    const rhs =
      expression.operator === "=" ? lowerValueExpression(context, expression.right) : lowerValueExpression(context, compoundToBinary(expression));
    context.lines.push(`    ${setLocal(context, name, narrowLocalValue(context, name, rhs))}`);
    return "";
  }

  context.codeGenerationContext.warn(`unsupported assignment target [${describeShape(expression.left)}]`, expression.span.line);
  return "";
}

// Rewrite `lhs <op>= rhs` into the equivalent `lhs <op> rhs` expression node.
export function compoundToBinary(expression: Expression & { kind: "assign" }): Expression {
  return {
    kind: "binary_op",
    operator: expression.operator.slice(0, -1),
    left: expression.left,
    right: expression.right,
    span: expression.span,
  } as Expression;
}

// Keep sub-64-bit scalar locals in canonical i64 form (zero-/sign-extended) on every store, so loads and compares can consume
export function narrowLocalValue(context: FunctionEmissionContext, name: string, value: watIr.WatNode): watIr.WatNode {
  const raw = context.localVars.get(name)?.type ?? context.params?.get(name)?.type;
  const type = raw ? context.codeGenerationContext.scalarStorageType(raw) : undefined;
  if (type?.kind === "name" && (SCALAR_SIZE[type.name] ?? 8) < 8) {
    return narrowCastIr(value, type.name);
  }
  return value;
}

// ---- value (rvalue) codegen — produces an i64 ----

export function lowerValueExpression(context: FunctionEmissionContext, expression: Expression): watIr.WatNode {
  if (
    context.codeGenerationContext.gtestMode &&
    expression.kind === "member_access" &&
    expression.member === "constructionEpoch" &&
    expression.object.kind === "subscript" &&
    expression.object.object.kind === "identifier" &&
    expression.object.object.name === "contractDescriptions"
  ) {
    return watIr.operation(
      "i64.extend_i32_u",
      watIr.functionCall("$qt_construction_epoch", watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.object.index))),
    );
  }
  if (
    expression.kind === "member_access" &&
    expression.member === "ptr" &&
    expression.object.kind === "identifier" &&
    context.scratchpadLocals?.has(expression.object.name)
  ) {
    return watIr.operation("i64.extend_i32_u", watIr.localGet(expression.object.name, "i32"));
  }
  // A uint128-valued expression used in a scalar/boolean context (a `while(z)` / `if(z)` truthiness test): materialize it and collapse
  if (
    (expression.kind === "call" ||
      expression.kind === "binary_op" ||
      expression.kind === "identifier" ||
      expression.kind === "member_access") &&
    isU128Expr(context, expression)
  ) {
    const result = sourceU128Result(context, "operator bool", lowerUint128Expression(context, expression), []);
    return result.ty === "i64" ? result : watIr.operation("i64.extend_i32_u", result);
  }

  // `.low` / `.high` of a uint128-valued expression that is not itself an lvalue (e.g. `div(a, b).low`):
  if (
    expression.kind === "member_access" &&
    (expression.member === "low" || expression.member === "high") &&
    isU128Expr(context, expression.object)
  ) {
    const argument = lowerUint128Expression(context, expression.object);
    return watIr.rawLoad("i64.load", expression.member === "high" ? 8 : 0, argument);
  }

  switch (expression.kind) {
    case "int_literal": {
      const numericValue = context.codeGenerationContext["sema"].evaluateConstexpr(expression) ?? 0n;
      return watIr.i64Constant(numericValue);
    }
    case "bool_literal":
      return watIr.i64Constant(expression.value ? 1 : 0);
    case "nullptr_literal":
      return watIr.i64Constant(0);
    case "char_literal":
      return watIr.i64Constant(expression.value);
    case "paren":
      return lowerValueExpression(context, expression.expression);
    case "identifier": {
      // a reference local is an address, not a scalar value — its scalar use is always via a
      if (context.localVars.has(expression.name) && !context.refLocals?.has(expression.name)) {
        return watIr.localGet(expression.name, context.localVars.get(expression.name)!.wasmType);
      }
      // a pointer local read as a value (p == NULL): the held address, zero-extended.
      if (context.refLocals?.get(expression.name)?.kind === "pointer") {
        return watIr.operation("i64.extend_i32_u", watIr.localGet(expression.name, "i32"));
      }
      const type = context.params?.get(expression.name);
      if (type && !type.isAddr) return watIr.localGet(type.local ?? expression.name, type.wasmType);
      // A pointer param read as a value (if (ptr), ptr == NULL) is the held address; a scalar
      if (type && type.isAddr && type.type.kind === "pointer")
        return watIr.operation("i64.extend_i32_u", watIr.localGet(type.local ?? expression.name, "i32"));
      if (type && type.isAddr && !context.codeGenerationContext.isAggregateType(type.type))
        return watIr.loadScalar(
          watIr.localGet(type.local ?? expression.name, "i32"),
          context.codeGenerationContext.sizeOfType(type.type),
          !unsignedScalar(type.type),
        );
      if (expression.name === "SELF_INDEX")
        return watIr.operation("i64.extend_i32_u", watIr.functionCall("$qpi_contractIndex"));
      if (expression.name === "NULL") return watIr.i64Constant(0);
      if (expression.name.startsWith("__id_")) {
        const line = context.codeGenerationContext.memberFnLine.get(expression.name.slice(5));
        if (line !== undefined) return watIr.i64Constant((context.codeGenerationContext.slot << 22) | (line & 0x3fffff));
      }
      // inside a compiled container method: a template non-type param (L), a static constexpr member (_nEncodedFlags), or a bare
      if (context.thisBind?.values.has(expression.name)) return watIr.i64Constant(context.thisBind.values.get(expression.name)!);
      if (context.staticConsts?.has(expression.name)) return watIr.i64Constant(context.staticConsts.get(expression.name)!);
      if (context.thisLayout) {
        const tn = resolveExpressionAddress(context, expression);
        if (tn && tn.size <= 8)
          return lowerScalarLoad(tn.addr, tn.size, isSignedScalarType(tn.type, context.codeGenerationContext));
      }
      // entry-fn `input`/`output` typed by a scalar typedef (typedef uint16 SetShareholderProposal_output): the io name is a region address, so
      if ((expression.name === "input" || expression.name === "output") && !context.localVars.has(expression.name)) {
        const io = resolveExpressionAddress(context, expression);
        if (io && io.size > 0 && io.size <= 8 && (!io.layout || io.layout.fields.size === 0)) {
          return lowerScalarLoad(io.addr, io.size, isSignedScalarType(io.type, context.codeGenerationContext));
        }
      }
      // a named constant: enum constant or constexpr (incl. qualified Type::NAME)
      const resolvedConstant = context.codeGenerationContext.resolveConst(expression.name);
      if (resolvedConstant !== null) return watIr.i64Constant(resolvedConstant);
      context.codeGenerationContext.warn(`unknown identifier '${expression.name}'`, expression.span);
      return watIr.i64Constant(0);
    }
    case "member_access": {
      const resolvedAddress = resolveExpressionAddress(context, expression);
      if (resolvedAddress && resolvedAddress.size <= 8) return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.codeGenerationContext));
      if (resolvedAddress) {
        context.codeGenerationContext.warn(`aggregate value read unsupported [${describeShape(expression)}]`, expression.span.line);
        return watIr.i64Constant(0);
      }
      // a static constexpr member of the object's type (pv.maxProposals / pv.maxVotes on ProposalVoting<P,D>): not a runtime field, so
      const obj = resolveExpressionAddress(context, expression.object);
      let ot: TypeSpec | null = obj?.type ?? null;
      for (let index = 0; index < 8 && ot?.kind === "name"; index++) ot = context.codeGenerationContext.typedefs.get(ot.name) ?? null;
      if (ot?.kind === "template_instance") {
        const sc = context.codeGenerationContext.staticConstsOf(ot.name, context.codeGenerationContext.bindContainer(ot.name, ot.callArguments));
        if (sc.has(expression.member)) return watIr.i64Constant(sc.get(expression.member)!);
      }
      // the same static constexpr read through an inline-typed object (data.variableScalar carries its union/struct decl inline): fold the member's
      if (ot?.kind === "inline_struct") {
        const sm = ot.struct.members.find(
          (member) =>
            member.kind === "variable" &&
            (member as VariableDecl).name === expression.member &&
            ((member as VariableDecl).isStatic || (member as VariableDecl).isConstexpr) &&
            (member as VariableDecl).initializer,
        ) as VariableDecl | undefined;
        if (sm?.initializer) {
          try {
            return watIr.i64Constant(context.codeGenerationContext.evalConstBig(sm.initializer, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
          } catch {
            /* not foldable under these bindings — fall through to the warning */
          }
        }
      }
      // qpi.invocationReward() etc. handled in call; bare member returns 0
      context.codeGenerationContext.warn(`unsupported member read [${describeShape(expression)}]`, expression.span.line);
      return watIr.i64Constant(0);
    }
    case "subscript": {
      const resolvedAddress = resolveExpressionAddress(context, expression);
      if (resolvedAddress && resolvedAddress.size <= 8) return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.codeGenerationContext));
      context.codeGenerationContext.warn(`unsupported subscript value`, (expression as any).span?.line ?? 0);
      return watIr.i64Constant(0);
    }
    case "call": {
      const inline = emitInlineStructValue(context, expression);
      return inline ?? emitCallValueIr(context, expression);
    }
    case "template_call": {
      if (expression.callee.kind === "identifier") {
        const name = expression.callee.name;
        // C++ cast spelled as a template call. static_cast narrows to its target width; reinterpret_cast/
        if (
          (name === "static_cast" || name === "reinterpret_cast" || name === "const_cast") &&
          expression.callArguments[0]
        ) {
          const inner = lowerValueExpression(context, expression.callArguments[0]);
          const tgt = expression.templateArguments?.[0];
          return name === "static_cast" && tgt?.kind === "name"
            ? narrowCastIr(inner, tgt.name)
            : inner;
        }
        const helper = emitHelperCall(context, expression as unknown as Expression & { kind: "call" }, true);
        if (helper !== null) return watIr.rawWatNode(helper, "i64", "source-compiled template helper");
      }
      if (
        expression.callee.kind === "member_access" &&
        expression.callee.object.kind === "identifier" &&
        expression.callee.object.name === "qpi"
      ) {
        const source = emitTemplateContainerCall(context, expression, true);
        if (source !== null)
          return watIr.rawWatNode(source, "i64", "source-compiled template instance method");
      }
      context.codeGenerationContext.warn(
        `unsupported template_call '${expression.callee.kind === "identifier" ? expression.callee.name : "?"}' as value`,
        expression.span.line,
      );
      return watIr.i64Constant(0);
    }
    case "binary_op":
      return lowerBinaryExpression(context, expression);
    case "unary_op": {
      // *ptr as a value: load the pointee through the pointer's held address.
      if (expression.operator === "*") {
        const resolvedAddress = resolveExpressionAddress(context, expression);
        if (resolvedAddress && resolvedAddress.size <= 8) {
          return lowerScalarLoad(resolvedAddress.addr, resolvedAddress.size, isSignedScalarType(resolvedAddress.type, context.codeGenerationContext));
        }
      }
      const valueNode = lowerValueExpression(context, expression.argument);
      // A 32-bit result wraps at 32 bits, so - and ~ reduce back to the canonical form: mask
      const info = scalarTypeInfo(context, expression);
      const mask32 = info !== null && info.width === 4 && info.unsigned;
      const sext32 = info !== null && info.width === 4 && !info.unsigned;
      const canon32 = (count: watIr.WatNode) =>
        mask32
          ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff"))
          : sext32
            ? watIr.operation("i64.extend32_s", count)
            : count;
      switch (expression.operator) {
        case "-": {
          return canon32(watIr.operation("i64.sub", watIr.i64Constant(0), valueNode));
        }
        case "~": {
          return canon32(watIr.operation("i64.xor", valueNode, watIr.i64Constant(-1)));
        }
        case "!":
          return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", valueNode));
        default:
          return valueNode;
      }
    }
    case "prefix_op": {
      // ++x / --x as a value: apply in place (as a side-effect line), then yield the new value.
      const emittedText = emitIncrementOrDecrement(context, expression);
      if (emittedText) context.lines.push(`    ${emittedText}`);
      return lowerValueExpression(context, expression.argument);
    }
    case "postfix_op": {
      // x++ / x-- as a value: capture the old value, then apply — the expression evaluates to the old.
      const oldValueLocal = newValueTmp(context);
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.localSet(oldValueLocal, lowerValueExpression(context, expression.argument)))}`,
      );
      const stepExpression = emitIncrementOrDecrement(context, expression);
      if (stepExpression) context.lines.push(`    ${stepExpression}`);
      return watIr.localGet(oldValueLocal, "i64");
    }
    case "ternary": {
      // C++ evaluates the condition, then exactly ONE arm. wasm select is eager, so it is only safe
      const cv = usualConversion(context, expression.then, expression.else_);
      const cvName = cv.width < 8 ? (cv.unsigned ? "uint32" : "sint32") : undefined;
      const condition = lowerValueExpression(context, expression.condition);
      const saved = context.lines;
      context.lines = [];
      const thenV = lowerValueExpression(context, expression.then);
      const thenLines = context.lines;
      context.lines = [];
      const elseV = lowerValueExpression(context, expression.else_);
      const elseLines = context.lines;
      context.lines = saved;
      if (
        thenLines.length === 0 &&
        elseLines.length === 0 &&
        watIr.isPureWatNode(thenV) &&
        watIr.isPureWatNode(elseV)
      ) {
        return narrowCastIr(watIr.selectValue(thenV, elseV, watIr.operation("i64.ne", watIr.i64Constant(0), condition)), cvName);
      }
      const branchResultLocal = newValueTmp(context);
      const thenB = [...thenLines, `      ${setLocal(context, branchResultLocal, thenV)}`].join("\n");
      const elseB = [...elseLines, `      ${setLocal(context, branchResultLocal, elseV)}`].join("\n");
      context.lines.push(
        `    (if (i64.ne (i64.const 0) ${watIr.serializeWatNode(condition)}) (then\n${thenB}\n    ) (else\n${elseB}\n    ))`,
      );
      return narrowCastIr(watIr.localGet(branchResultLocal, "i64"), cvName);
    }
    case "c_cast":
    case "static_cast":
      return narrowCastIr(
        lowerValueExpression(context, expression.expression),
        expression.type?.kind === "name" ? expression.type.name : undefined,
      );
    case "construct": {
      const storageType = context.codeGenerationContext.scalarStorageType(expression.type);
      if (storageType.kind === "name" && SCALAR_SIZE[storageType.name] !== undefined && SCALAR_SIZE[storageType.name] <= 8) {
        return narrowCastIr(expression.callArguments[0] ? lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0), storageType.name);
      }
      context.codeGenerationContext.warn(`aggregate construction used as a scalar value`, expression.span);
      return watIr.i64Constant(0);
    }
    case "initializer_list":
      return expression.expressions.length === 1 ? lowerValueExpression(context, expression.expressions[0]) : watIr.i64Constant(0);
    case "sizeof_type":
      return watIr.i64Constant(context.codeGenerationContext.sizeOfType(expression.type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS));
    case "sizeof_expr": {
      // sizeof someLvalue — e.g. sizeof(*this) (the container).
      const resolvedAddress = resolveExpressionAddress(context, expression.expression);
      if (resolvedAddress) return watIr.i64Constant(resolvedAddress.size);
      const scalar = scalarTypeInfo(context, expression.expression);
      if (scalar) return watIr.i64Constant(scalar.width);
      // sizeof(TypeName) parses here when the operand is a bare type (e.g. sizeof(Element)) rather than
      if (expression.expression.kind === "identifier") {
        const byteSize = context.codeGenerationContext.sizeOfType(
          { kind: "name", name: expression.expression.name },
          context.thisBind ?? EMPTY_TEMPLATE_BINDINGS,
        );
        if (byteSize > 0) return watIr.i64Constant(byteSize);
      }
      context.codeGenerationContext.warn(`unsupported sizeof expr`, expression.span.line);
      return watIr.i64Constant(0);
    }
    case "assign": {
      // assignment used as a value — `while ((i = next()) >= 0)`, `a = b = 0`. Perform
      emitAssign(context, expression);
      return lowerValueExpression(context, expression.left);
    }
    default:
      context.codeGenerationContext.warn(`unsupported expression '${expression.kind}' as value`, (expression as any).span?.line ?? 0);
      return watIr.i64Constant(0);
  }
}

export function emitValue(context: FunctionEmissionContext, expression: Expression): string {
  return watIr.serializeWatNode(lowerValueExpression(context, expression));
}

// Address+size of an operand that is an aggregate (id/m256i/struct): a struct-field lvalue, or a materialized id producer (SELF
export function aggOperand(context: FunctionEmissionContext, expression: Expression): { addr: string; size: number } | null {
  const resolvedAddress = resolveExpressionAddress(context, expression);
  if (resolvedAddress) return resolvedAddress.size > 8 ? { addr: resolvedAddress.addr, size: resolvedAddress.size } : null;
  const emittedAddress = emitAddress(context, expression);
  return emittedAddress ? { addr: emittedAddress, size: 32 } : null;
}

// Whether an expression is uint128-typed (so it flows as a 16-byte value through source-compiled methods rather than
export function isU128Expr(context: FunctionEmissionContext, expression: Expression): boolean {
  if (expression.kind === "paren") return isU128Expr(context, expression.expression);
  if (expression.kind === "construct") return isUint128(context.codeGenerationContext, expression.type);
  if (expression.kind === "c_cast" || expression.kind === "static_cast") {
    const type = (expression as any).type;
    if (type?.kind === "name" && (type.name === "uint128" || type.name === "uint128_t")) return true;
    return isU128Expr(context, expression.expression);
  }
  if (expression.kind === "ternary") return isU128Expr(context, expression.then) || isU128Expr(context, expression.else_);
  if (expression.kind === "template_call" && expression.callee.kind === "identifier") {
    const base = symbolBaseName((expression.callee as any).name);
    if (
      (base === "div" || base === "mod") &&
      MATH_INTRINSIC_NAMES.has(base) &&
      expression.callArguments.length === 2
    ) {
      const ta = expression.templateArguments?.[0];
      if (ta?.kind === "name" && (ta.name === "uint128" || ta.name === "uint128_t")) return true;
      return isU128Expr(context, expression.callArguments[0]) || isU128Expr(context, expression.callArguments[1]);
    }
  }
  if (expression.kind === "call" && expression.callee.kind === "identifier") {
    const nm = expression.callee.name;
    if (nm === "uint128" || nm === "uint128_t") return true;
    const bound = context.thisBind?.types.get(nm);
    if (bound && isUint128(context.codeGenerationContext, bound)) return true;
    const base = symbolBaseName(nm);
    if (
      (base === "div" || base === "mod") &&
      MATH_INTRINSIC_NAMES.has(base) &&
      expression.callArguments.length === 2
    ) {
      return isU128Expr(context, expression.callArguments[0]) || isU128Expr(context, expression.callArguments[1]);
    }
  }
  if (expression.kind === "binary_op") {
    if (expression.operator === "<<" || expression.operator === ">>") return isU128Expr(context, expression.left);
    if (
      expression.operator === "*" ||
      expression.operator === "/" ||
      expression.operator === "+" ||
      expression.operator === "-" ||
      expression.operator === "&" ||
      expression.operator === "|" ||
      expression.operator === "^"
    )
      return isU128Expr(context, expression.left) || isU128Expr(context, expression.right);
    return false;
  }

  // Method calls: answer from the DECLARED return type. Falling through to resolveAddr would
  if (expression.kind === "call" && expression.callee.kind === "member_access") {
    const obj = resolveExpressionAddress(context, expression.callee.object);
    let ot: TypeSpec | null = obj?.type ?? null;
    for (let index = 0; index < 8 && ot?.kind === "name"; index++) {
      const next = context.thisBind?.types.get(ot.name) ?? context.codeGenerationContext.typedefs.get(ot.name);
      if (!next) break;
      ot = next;
    }

    if (ot?.kind === "template_instance") {
      const mt = context.codeGenerationContext.methodTemplate(ot.name, ot.callArguments, expression.callee.member, expression.callArguments.length);
      if (mt?.def.returnType) {
        return isUint128(
          context.codeGenerationContext,
          context.codeGenerationContext.substInBindings(context.codeGenerationContext.derefType(mt.def.returnType), mt.bind),
        );
      }
    }
    const struct = ot ? context.codeGenerationContext.structOf(ot, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : null;
    const fn = struct?.members.find(
      (member) =>
        member.kind === "function" &&
        (member as FunctionDecl).name === (expression.callee as Expression & { kind: "member_access" }).member,
    ) as FunctionDecl | undefined;
    if (fn?.returnType) {
      return isUint128(context.codeGenerationContext, fn.returnType);
    }
  }

  const resolvedAddress = resolveExpressionAddress(context, expression);
  return !!(resolvedAddress && isUint128(context.codeGenerationContext, resolvedAddress.type));
}

// Materialize a uint128 expression into a fresh 16-byte slot (low@0, high@8) and return its address; an existing uint128
const U128_CLASS: TypeSpec & { kind: "template_instance" } = {
  kind: "template_instance",
  name: "uint128_t",
  callArguments: [],
};

function constructU128(context: FunctionEmissionContext, callArguments: Expression[]): watIr.WatNode {
  const destination = allocateScratchSlotNode(context, 16);
  const compiled = callCompiled(context, U128_CLASS, "uint128_t", watIr.serializeWatNode(destination), callArguments);
  if (!compiled || compiled.cm.retKind !== "void") {
    throw new Error("authoritative uint128_t constructor could not be lowered");
  }
  context.lines.push(`    ${compiled.call}`);
  return destination;
}

function u128ConstructorExpr(expression: Expression): Expression {
  return {
    kind: "call",
    callee: { kind: "identifier", name: "uint128_t", span: expression.span },
    callArguments: [expression],
    span: expression.span,
  };
}

function sourceU128Result(
  context: FunctionEmissionContext,
  method: string,
  self: watIr.WatNode,
  callArguments: Expression[],
  paramTypeKey?: string,
): watIr.WatNode {
  const compiled = callCompiled(context, U128_CLASS, method, watIr.serializeWatNode(self), callArguments, paramTypeKey);
  if (!compiled) throw new Error(`authoritative uint128_t::${method} could not be lowered`);
  if (compiled.retDest) {
    context.lines.push(`    ${compiled.call}`);
    return watIr.rawWatNode(compiled.retDest, "i32", "source-compiled uint128 aggregate result");
  }
  if (compiled.cm.retKind === "i64")
    return watIr.rawWatNode(compiled.call, "i64", "source-compiled uint128 scalar result");
  if (compiled.cm.retKind === "i32")
    return watIr.rawWatNode(compiled.call, "i32", "source-compiled uint128 reference result");
  context.lines.push(`    ${compiled.call}`);
  throw new Error(`void uint128_t::${method} used as a value`);
}

// Materialize a uint128 expression into a 16-byte slot (low@0, high@8). Arithmetic and
// comparisons are instantiated from the authoritative platform/uint128.h method bodies.
export function lowerUint128Expression(context: FunctionEmissionContext, expression: Expression): watIr.WatNode {
  if (expression.kind === "paren") return lowerUint128Expression(context, expression.expression);
  if (expression.kind === "initializer_list") return constructU128(context, expression.expressions);
  if (expression.kind === "construct" && isUint128(context.codeGenerationContext, expression.type))
    return constructU128(context, expression.callArguments);
  if (expression.kind === "c_cast" || expression.kind === "static_cast") {
    if (isU128Expr(context, expression.expression)) return lowerUint128Expression(context, expression.expression);
    return constructU128(context, [expression.expression]);
  }

  const resolvedAddress = resolveExpressionAddress(context, expression);
  if (resolvedAddress && isUint128(context.codeGenerationContext, resolvedAddress.type)) return watIr.rawWatNode(resolvedAddress.addr, "i32", "lvalue address channel");

  if (expression.kind === "call" && expression.callee.kind === "identifier") {
    const bound = context.thisBind?.types.get(expression.callee.name);
    const constructor =
      expression.callee.name === "uint128" ||
      expression.callee.name === "uint128_t" ||
      (bound ? isUint128(context.codeGenerationContext, bound) : false);
    if (constructor) return constructU128(context, expression.callArguments);

    if (
      symbolBaseName(expression.callee.name) === "div" &&
      MATH_INTRINSIC_NAMES.has("div") &&
      expression.callArguments.length === 2
    ) {
      const helper = lookupHelper(context, expression);
      if (!helper?.retAgg || helper.retAgg !== 16) {
        throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
      }
      return watIr.rawWatNode(
        emitAggHelperCall(context, expression, helper),
        "i32",
        "source-compiled uint128 div result",
      );
    }
  }

  if (
    expression.kind === "template_call" &&
    expression.callee.kind === "identifier" &&
    symbolBaseName(expression.callee.name) === "div" &&
    MATH_INTRINSIC_NAMES.has("div") &&
    expression.callArguments.length === 2
  ) {
    const callExpr = expression as unknown as Expression & { kind: "call" };
    const helper = lookupHelper(context, callExpr);
    if (!helper?.retAgg || helper.retAgg !== 16) {
      throw new Error(`authoritative QPI::div<uint128_t> could not be lowered`);
    }
    return watIr.rawWatNode(
      emitAggHelperCall(context, callExpr, helper),
      "i32",
      "source-compiled uint128 div result",
    );
  }

  if (expression.kind === "ternary") {
    const destination = allocateScratchSlotNode(context, 16);
    context.lines.push(
      `    (if ${watIr.serializeWatNode(watIr.operation("i64.ne", watIr.i64Constant(0), lowerValueExpression(context, expression.condition)))} (then`,
    );
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.then), watIr.i32Constant(16)))}`,
    );
    context.lines.push("    ) (else");
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, lowerUint128Expression(context, expression.else_), watIr.i32Constant(16)))}`,
    );
    context.lines.push("    ))");
    return destination;
  }

  if (expression.kind === "binary_op") {
    // The pinned uint128_t class has no |/^ overloads. Keep these representation-level bitwise
    // operations as compiler primitives; every defined class operator below is source-compiled.
    if (expression.operator === "|" || expression.operator === "^") {
      const destination = allocateScratchSlotNode(context, 16);
      const left = lowerUint128Expression(context, expression.left);
      const right = lowerUint128Expression(context, expression.right);
      const opcode = expression.operator === "|" ? "i64.or" : "i64.xor";
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", null, left), watIr.rawLoad("i64.load", null, right))))}`,
      );
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", 8, destination, watIr.operation(opcode, watIr.rawLoad("i64.load", 8, left), watIr.rawLoad("i64.load", 8, right))))}`,
      );
      return destination;
    }

    const method = ["+", "-", "*", "/", "&", "<<", ">>"].includes(expression.operator)
      ? `operator${expression.operator}`
      : null;
    if (method) {
      const left = lowerUint128Expression(context, expression.left);
      const scalarRight = !isU128Expr(context, expression.right);
      // platform/uint128.h defines scalar overloads only for `& int` and `>> unsigned
      // int`. Every other scalar operand reaches the uint128_t overload through the
      const key =
        scalarRight && expression.operator === "&"
          ? "int"
          : scalarRight && expression.operator === ">>"
            ? "unsigned int"
            : "uint128_t";
      const right =
        key === "uint128_t" && scalarRight ? u128ConstructorExpr(expression.right) : expression.right;
      return sourceU128Result(context, method, left, [right], key);
    }
  }

  return constructU128(context, [expression]);
}
export function emitU128(context: FunctionEmissionContext, expression: Expression): string {
  return watIr.serializeWatNode(lowerUint128Expression(context, expression));
}

// True for `auto` (or `auto*`) type specs, which take their real type from the initializer.
export function isAutoType(type: TypeSpec): boolean {
  if (type.kind === "pointer") {
    return isAutoType(type.pointee);
  }
  return type.kind === "name" && type.name === "auto";
}

// Resolve a named type through typedef/using aliases to its underlying spec (bounded walk; stops at a known scalar
export function resolveAliasType(codeGenerationContext: CodeGenerationContext, type: TypeSpec): TypeSpec {
  let resolvedType = type;
  for (
    let index = 0;
    index < 8 && resolvedType.kind === "name" && SCALAR_SIZE[resolvedType.name] === undefined;
    index++
  ) {
    const typedefType = codeGenerationContext.typedefs.get(resolvedType.name);
    if (!typedefType || typedefType.kind === "void") {
      break;
    }
    resolvedType = typedefType;
  }
  return resolvedType;
}

// True if a scalar type is unsigned (uint*/unsigned/size_t-like). Drives signed-vs-unsigned op selection.
export function unsignedScalar(type: TypeSpec | null | undefined): boolean {
  if (!type) return false;
  if (type.kind === "const") return unsignedScalar(type.valueType);
  if (type.kind === "reference") return unsignedScalar(type.referentType);
  if (type.kind === "pointer") return false;
  if (type.kind !== "name") return false;
  return (
    /^(uint|unsigned\b|size_t$|bool$|bit$)/.test(type.name) ||
    type.name === "uint128" ||
    type.name === "uint128_t"
  );
}

// Best-effort signedness is unsigned when unsigned lvalue/params, casts, or suffixed literals are present.
export function isUnsignedExpr(context: FunctionEmissionContext, expression: Expression): boolean {
  switch (expression.kind) {
    case "c_cast":
    case "static_cast":
      return unsignedScalar(expression.type);
    case "paren":
      return isUnsignedExpr(context, expression.expression);
    case "int_literal":
      return /[uU]/.test(expression.suffix ?? "");
    case "identifier": {
      const type = context.params?.get(expression.name);
      if (type) return unsignedScalar(context.codeGenerationContext.scalarStorageType(type.type));
      const rl = context.refLocals?.get(expression.name);
      if (rl) return unsignedScalar(context.codeGenerationContext.scalarStorageType(rl));
      const lv = context.localVars.get(expression.name)?.type;
      if (lv) return unsignedScalar(context.codeGenerationContext.scalarStorageType(lv));
      const constant = context.codeGenerationContext.typeOfConstant(expression.name);
      if (constant) return unsignedScalar(context.codeGenerationContext.scalarStorageType(constant));
      const addrType = resolveExpressionAddress(context, expression)?.type;
      return addrType ? unsignedScalar(context.codeGenerationContext.scalarStorageType(addrType)) : false;
    }
    case "member_access":
    case "subscript": {
      const type = resolveExpressionAddress(context, expression)?.type ?? null;
      if (type?.kind === "name" && type.name === "DateAndTime") return true; // compares via its packed uint64 value
      return type ? unsignedScalar(context.codeGenerationContext.scalarStorageType(type)) : false;
    }
    case "call": {
      if (
        expression.callee.kind !== "member_access" ||
        expression.callee.object.kind !== "identifier" ||
        expression.callee.object.name !== "qpi"
      ) {
        return false;
      }
      const calleeObjectType = resolveExpressionAddress(context, expression.callee.object)?.type;
      const separator =
        calleeObjectType?.kind === "name" ? calleeObjectType.name.lastIndexOf("::") : -1;
      const owner =
        calleeObjectType?.kind === "name"
          ? separator >= 0
            ? calleeObjectType.name.slice(separator + 2)
            : calleeObjectType.name
          : calleeObjectType?.kind === "template_instance"
            ? calleeObjectType.name
            : null;
      if (!owner) return false;
      const method = context.codeGenerationContext.methodTemplate(
        owner,
        calleeObjectType?.kind === "template_instance" ? calleeObjectType.callArguments : [],
        expression.callee.member,
        expression.callArguments.length,
      );
      if (!method) return false;
      const result = context.codeGenerationContext.substInBindings(context.codeGenerationContext.derefType(method.def.returnType), method.bind);
      return context.codeGenerationContext.isAggregateType(result) || unsignedScalar(context.codeGenerationContext.scalarStorageType(result));
    }
    case "binary_op":
      if (["+", "-", "*", "/", "%", "&", "|", "^", "<<", ">>"].includes(expression.operator))
        return isUnsignedExpr(context, expression.left) || isUnsignedExpr(context, expression.right);
      return false;
    case "unary_op":
      if (expression.operator === "-" || expression.operator === "~" || expression.operator === "+")
        return isUnsignedExpr(context, expression.argument);
      return false;
    case "prefix_op":
    case "postfix_op":
      return isUnsignedExpr(context, expression.argument);
    case "ternary":
      return isUnsignedExpr(context, expression.then) || isUnsignedExpr(context, expression.else_);
    default:
      return false;
  }
}

// Best-effort (byte width, signedness) of a scalar expression, mirroring isUnsignedExpr's coverage.
export function scalarTypeInfo(
  context: FunctionEmissionContext,
  expression: Expression,
): { width: number; unsigned: boolean } | null {
  switch (expression.kind) {
    case "paren":
      return scalarTypeInfo(context, expression.expression);
    case "c_cast":
    case "static_cast": {
      const castTypeName = expression.type?.kind === "name" ? expression.type.name : null;
      const byteWidth = castTypeName ? SCALAR_SIZE[castTypeName] : undefined;
      return byteWidth ? { width: byteWidth, unsigned: unsignedScalar(expression.type) } : null;
    }
    case "int_literal": {
      // C++ literal typing: int → (uint for hex/octal) → long long by fit; a u/U suffix forces unsigned
      const numericValue = context.codeGenerationContext["sema"].evaluateConstexpr(expression) ?? 0n;
      const suffixU = /[uU]/.test(expression.suffix ?? "");
      const suffixL = /[lL]/.test(expression.suffix ?? "");
      const hex = /^0[xX0-7]/.test(expression.value ?? "");
      if (suffixL) return { width: 8, unsigned: suffixU };
      if (numericValue >= -(2n ** 31n) && numericValue < 2n ** 31n) return { width: 4, unsigned: suffixU };
      if (suffixU && numericValue < 2n ** 32n) return { width: 4, unsigned: true };
      if (hex && numericValue < 2n ** 32n) return { width: 4, unsigned: true };
      if (!suffixU && numericValue < 2n ** 63n) return { width: 8, unsigned: false };
      return { width: 8, unsigned: true };
    }
    case "identifier":
    case "member_access":
    case "subscript": {
      const type =
        expression.kind === "identifier"
          ? (context.params?.get(expression.name)?.type ??
            context.refLocals?.get(expression.name) ??
            context.localVars.get(expression.name)?.type ??
            context.codeGenerationContext.typeOfConstant(expression.name) ??
            resolveExpressionAddress(context, expression)?.type ??
            null)
          : (resolveExpressionAddress(context, expression)?.type ?? null);
      let resolvedType = type;
      if (resolvedType?.kind === "const") resolvedType = resolvedType.valueType;
      if (resolvedType?.kind === "reference") resolvedType = resolvedType.referentType;
      if (resolvedType) resolvedType = context.codeGenerationContext.scalarStorageType(resolvedType);
      const byteWidth =
        resolvedType?.kind === "name" ? SCALAR_SIZE[resolvedType.name] : undefined;
      return byteWidth
        ? { width: byteWidth, unsigned: unsignedScalar(resolvedType) }
        : null;
    }
    case "binary_op": {
      if (["+", "-", "*", "/", "%", "&", "|", "^"].includes(expression.operator)) {
        const cv = usualConversion(context, expression.left, expression.right);
        return { width: cv.width, unsigned: cv.unsigned };
      }
      if (expression.operator === "<<" || expression.operator === ">>") return promoteInfo(context, expression.left);
      // Comparisons and logical ops yield bool, which promotes to int.
      if (["<", ">", "<=", ">=", "==", "!=", "&&", "||"].includes(expression.operator))
        return { width: 4, unsigned: false };
      return null;
    }
    // The C++ common type of the two arms (condition contributes nothing).
    case "ternary": {
      const cv = usualConversion(context, expression.then, expression.else_);
      return { width: cv.width, unsigned: cv.unsigned };
    }
    case "unary_op": {
      if (expression.operator === "-" || expression.operator === "~" || expression.operator === "+") return promoteInfo(context, expression.argument);
      if (expression.operator === "!") return { width: 4, unsigned: false };
      return null;
    }
    // ++x / x++ yield the operand's own type (no promotion).
    case "prefix_op":
    case "postfix_op":
      return scalarTypeInfo(context, expression.argument);
    case "call":
    case "template_call": {
      // QPI safe-math intrinsics return their (deduced or explicit) argument type; without this a comparison against e.g. `math_lib::max((uint64)a, (uint64)b)`
      const nm = expression.callee?.kind === "identifier" ? expression.callee.name : null;
      if (!nm) return null;
      const base = nm.includes("::") ? nm.slice(nm.lastIndexOf("::") + 2) : nm;
      if (!MATH_INTRINSIC_NAMES.has(base)) {
        // A member value helper carries its declared return type; the width/signedness of `pick(x) + 1` etc. follow the
        const set = context.codeGenerationContext.helperOverloads.get(nm);
        const helper = set?.length
          ? pickHelperOverload(context, set, expression.callArguments ?? [])
          : context.codeGenerationContext.helpers.get(nm);
        const rt = helper?.retType;
        const byteWidth = rt?.kind === "name" ? SCALAR_SIZE[rt.name] : undefined;
        if (byteWidth !== undefined && byteWidth <= 8)
          return { width: byteWidth, unsigned: unsignedScalar(rt) };
        return null;
      }
      if (expression.kind === "template_call" && expression.templateArguments?.[0]?.kind === "name") {
        const byteWidth = SCALAR_SIZE[expression.templateArguments[0].name];
        if (byteWidth)
          return { width: byteWidth, unsigned: unsignedScalar(expression.templateArguments[0]) };
      }
      const a0 = expression.callArguments?.[0],
        a1 = expression.callArguments?.[1];
      if (base === "abs") return a0 ? promoteInfo(context, a0) : null;
      if (!a0 || !a1) return null;
      const cv = usualConversion(context, a0, a1);
      return base === "sdiv" ? { width: cv.width, unsigned: false } : cv;
    }
    default:
      return null;
  }
}

// Integral promotion: sub-int scalars become int (signed, 4 bytes); unknown types fall back to the legacy 64-bit +
export function promoteInfo(context: FunctionEmissionContext, expression: Expression): { width: number; unsigned: boolean } {
  const info = scalarTypeInfo(context, expression) ?? { width: 8, unsigned: isUnsignedExpr(context, expression) };
  if (info.width < 4) return { width: 4, unsigned: false };
  return info;
}

// C++ usual arithmetic conversions over the promoted operands: same signedness → wider wins; mixed → unsigned wins at
export function usualConversion(
  context: FunctionEmissionContext,
  left: Expression,
  right: Expression,
): { width: number; unsigned: boolean } {
  const leftInfo = promoteInfo(context, left);
  const rightInfo = promoteInfo(context, right);
  const width = Math.max(leftInfo.width, rightInfo.width);
  if (leftInfo.unsigned === rightInfo.unsigned) return { width, unsigned: leftInfo.unsigned };
  const unsignedInfo = leftInfo.unsigned ? leftInfo : rightInfo;
  const signedInfo = leftInfo.unsigned ? rightInfo : leftInfo;
  return unsignedInfo.width >= signedInfo.width
    ? { width, unsigned: true }
    : { width, unsigned: false };
}

export function lowerBinaryExpression(context: FunctionEmissionContext, expression: Expression & { kind: "binary_op" }): watIr.WatNode {
  // uint128 comparisons instantiate the corresponding platform/uint128.h operator body.
  if (
    (expression.operator === "==" ||
      expression.operator === "!=" ||
      expression.operator === "<" ||
      expression.operator === ">" ||
      expression.operator === "<=" ||
      expression.operator === ">=") &&
    (isU128Expr(context, expression.left) || isU128Expr(context, expression.right))
  ) {
    const left = lowerUint128Expression(context, expression.left);
    const method = expression.operator === "!=" ? "operator==" : `operator${expression.operator}`;
    const right = isU128Expr(context, expression.right) ? expression.right : u128ConstructorExpr(expression.right);
    const result = sourceU128Result(context, method, left, [right], "uint128_t");
    if (result.ty !== "i64") throw new Error(`uint128_t::${method} did not return a scalar`);
    return expression.operator === "!=" ? watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", result)) : result;
  }

  // id/struct equality compares bytes, not an i64 value.
  if (expression.operator === "==" || expression.operator === "!=") {
    const la = aggOperand(context, expression.left);
    const ra = aggOperand(context, expression.right);
    if (la && ra) {
      const eq = watIr.functionCall(
        "$memeq",
        watIr.rawWatNode(la.addr, "i32", "lvalue address channel"),
        watIr.rawWatNode(ra.addr, "i32", "lvalue address channel"),
        watIr.i32Constant(Math.min(la.size, ra.size)),
      );
      return expression.operator === "=="
        ? watIr.operation("i64.extend_i32_u", eq)
        : watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", eq));
    }
  }

  // id/m256i ordering is a 256-bit lexicographic compare of 4 u64 limbs.
  if (expression.operator === "<" || expression.operator === ">" || expression.operator === "<=" || expression.operator === ">=") {
    const la = aggOperand(context, expression.left);
    const ra = aggOperand(context, expression.right);
    if (la && ra && la.size === 32 && ra.size === 32) {
      const leftAddressAndSize = (left: { addr: string }, right: { addr: string }) =>
        watIr.functionCall(
          "$m256_lt",
          watIr.rawWatNode(left.addr, "i32", "lvalue address channel"),
          watIr.rawWatNode(right.addr, "i32", "lvalue address channel"),
        );
      if (expression.operator === "<") return watIr.operation("i64.extend_i32_u", leftAddressAndSize(la, ra));
      if (expression.operator === ">") return watIr.operation("i64.extend_i32_u", leftAddressAndSize(ra, la));
      if (expression.operator === "<=") {
        return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(ra, la)));
      }
      return watIr.operation("i64.extend_i32_u", watIr.operation("i32.eqz", leftAddressAndSize(la, ra)));
    }
  }

  // Short-circuit `&&` / `||`: the right operand must not be evaluated when the left already decides the result
  if (expression.operator === "&&" || expression.operator === "||") {
    const lb = watIr.operation("i64.ne", watIr.i64Constant(0), lowerValueExpression(context, expression.left));
    const saved = context.lines;
    context.lines = [];
    const rExpr = lowerValueExpression(context, expression.right);
    const rLines = context.lines;
    context.lines = saved;
    const rb = watIr.operation("i64.ne", watIr.i64Constant(0), rExpr);
    if (rLines.length === 0) {
      return expression.operator === "||"
        ? watIr.rawWatNode(
            `(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then (i32.const 1)) (else ${watIr.serializeWatNode(rb)})))`,
            "i64",
            "inline if-expression",
          )
        : watIr.rawWatNode(
            `(i64.extend_i32_u (if (result i32) ${watIr.serializeWatNode(lb)} (then ${watIr.serializeWatNode(rb)}) (else (i32.const 0))))`,
            "i64",
            "inline if-expression",
          );
    }
    const temporaryLocalName = allocateTemporaryLocalName(context);
    const rBranch = [...rLines, `      (local.set $${temporaryLocalName} ${watIr.serializeWatNode(rb)})`].join("\n");
    if (expression.operator === "||") {
      context.lines.push(
        `    (if ${watIr.serializeWatNode(lb)} (then (local.set $${temporaryLocalName} (i32.const 1))) (else\n${rBranch}\n    ))`,
      );
    } else {
      context.lines.push(
        `    (if ${watIr.serializeWatNode(lb)} (then\n${rBranch}\n    ) (else (local.set $${temporaryLocalName} (i32.const 0))))`,
      );
    }
    return watIr.operation("i64.extend_i32_u", watIr.localGet(temporaryLocalName, "i32"));
  }

  const valueNode = lowerValueExpression(context, expression.left);
  const valueNodeCandidate = lowerValueExpression(context, expression.right);
  // C++ usual arithmetic conversions decide the operation's signedness and rank. A 32-bit result
  const cv = usualConversion(context, expression.left, expression.right);
  const unsigned = cv.unsigned;
  const li = promoteInfo(context, expression.left);
  const wrapL = (count: watIr.WatNode, active: boolean) =>
    active ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff")) : count;
  const wrapS = (count: watIr.WatNode, active: boolean) => (active ? watIr.operation("i64.extend32_s", count) : count);
  const wrap32 = unsigned && cv.width === 4;
  const swrap32 = !unsigned && cv.width === 4;
  const shiftCount = (count: watIr.WatNode) => (li.width === 4 ? watIr.operation("i64.and", count, watIr.i64Constant(31)) : count);

  // Signed-to-unsigned 32-bit converts by sign extension rules, so / and % follow unsigned arithmetic semantics.
  const toU32 = (count: watIr.WatNode, expression: Expression) => {
    if (!wrap32) {
      return count;
    }
    const pi = promoteInfo(context, expression);
    return pi.width === 4 && !pi.unsigned ? watIr.operation("i64.and", count, watIr.i64Constant("0xffffffff")) : count;
  };
  const lc = toU32(valueNode, expression.left);
  const rc = toU32(valueNodeCandidate, expression.right);
  const cmp = (operator: string) => watIr.operation("i64.extend_i32_u", watIr.operation(operator, lc, rc));

  switch (expression.operator) {
    case "+":
      return wrapS(wrapL(watIr.operation("i64.add", valueNode, valueNodeCandidate), wrap32), swrap32);
    case "-":
      return wrapS(wrapL(watIr.operation("i64.sub", valueNode, valueNodeCandidate), wrap32), swrap32);
    case "*":
      return wrapS(wrapL(watIr.operation("i64.mul", valueNode, valueNodeCandidate), wrap32), swrap32);
    case "/":
      return watIr.operation(unsigned ? "i64.div_u" : "i64.div_s", lc, rc);
    case "%":
      return watIr.operation(unsigned ? "i64.rem_u" : "i64.rem_s", lc, rc);
    case "<<": {
      const sh = watIr.operation("i64.shl", valueNode, shiftCount(valueNodeCandidate));
      return li.width === 4 ? (li.unsigned ? wrapL(sh, true) : wrapS(sh, true)) : sh;
    }
    // Signed right-shift is arithmetic in C++ — zero-filling a negative sint64 silently corrupts it.
    case ">>":
      return watIr.operation(li.unsigned ? "i64.shr_u" : "i64.shr_s", valueNode, shiftCount(valueNodeCandidate));
    case "&":
      return watIr.operation("i64.and", valueNode, valueNodeCandidate);
    case "|":
      return wrapL(watIr.operation("i64.or", valueNode, valueNodeCandidate), wrap32);
    case "^":
      return wrapL(watIr.operation("i64.xor", valueNode, valueNodeCandidate), wrap32);
    case "==":
      return cmp("i64.eq");
    case "!=":
      return cmp("i64.ne");
    case "<":
      return cmp(unsigned ? "i64.lt_u" : "i64.lt_s");
    case ">":
      return cmp(unsigned ? "i64.gt_u" : "i64.gt_s");
    case "<=":
      return cmp(unsigned ? "i64.le_u" : "i64.le_s");
    case ">=":
      return cmp(unsigned ? "i64.ge_u" : "i64.ge_s");
    default:
      return watIr.i64Constant(0);
  }
}
