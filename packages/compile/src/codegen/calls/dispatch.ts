import { MATH_INTRINSIC_NAMES, SCALAR_SIZE, symbolBaseName } from "../tables";
import { emitQpiCall } from "./qpi";
import { emitHelperCall } from "./library-functions";
import { emitProxySiblingCall, emitProposalProxyCall } from "./proxy";
import { allocateTemporaryLocalName } from "../statement-emitter";
import { compileContainerMethod, emitAssetIter, emitContainerCall } from "./containers";
import { lowerValueExpression, emitValue } from "../expression-lowering";
import {
  emitAddress,
  emitInlineStructStatement,
  addrIr,
  allocateScratchSlotNode,
  setLocal,
  narrowCastIr,
  resolveExpressionAddress,
} from "../address-resolution";
import { FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
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
} from "../../ast";
import * as watIr from "../../wat-ir";
import { platformPrimitive } from "../platform-primitives";

export function emitThisCall(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  valueWanted: boolean,
): string | null {
  if (
    !context.thisType ||
    context.thisType.kind !== "template_instance" ||
    expression.callee.kind !== "identifier"
  )
    return null;
  const methodName = expression.callee.name;

  // memory builtins used by container bodies: reset → setMem(this, ...); removeByIndex → setMem(&elem, ...).
  if ((methodName === "setMem" || methodName === "copyMem") && !valueWanted) {
    const destination = emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)";
    if (methodName === "copyMem") {
      const src = emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)";
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(destination), addrIr(src), watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[2]))))}`,
      );
    } else {
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(destination), watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[1])), watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[2]))))}`,
      );
    }
    return "";
  }

  // Resolve the dependent static call through the actual HashFunc template binding. This is important
  // both for the default HashFunction<KeyT> body and for contract-provided custom hashers.
  if (methodName.endsWith("::hash")) {
    const targetName = methodName.slice(0, methodName.lastIndexOf("::"));
    const bound = context.thisBind?.types.get(targetName);
    const target: (TypeSpec & { kind: "template_instance" }) | null =
      bound?.kind === "template_instance"
        ? bound
        : bound?.kind === "name"
          ? { kind: "template_instance", name: bound.name, callArguments: [] }
          : null;
    if (!target) throw new Error(`dependent hash target '${methodName}' is not bound`);
    const cm = compileContainerMethod(context.codeGenerationContext, target, "hash", expression.callArguments.length);
    if (!cm || cm.retKind !== "i64") {
      throw new Error(`authoritative QPI method ${target.name}::hash could not be lowered`);
    }
    const methodArgumentOperands = cm.functionParameters.map((fp, index) => {
      const methodArgument = expression.callArguments[index] ?? fp.defaultValue;
      if (!methodArgument) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
      if (!fp.isAddr) return emitValue(context, methodArgument);
      const direct = emitAddress(context, methodArgument);
      if (direct) return direct;
      const spill = allocateScratchSlotNode(
        context,
        Math.max(8, context.codeGenerationContext.sizeOfType(context.codeGenerationContext.derefType(fp.type), context.thisBind ?? EMPTY_TEMPLATE_BINDINGS)),
      );
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, spill, lowerValueExpression(context, methodArgument)))}`,
      );
      return watIr.serializeWatNode(spill);
    });
    return `(call ${cm.label} (local.get $this)${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`;
  }

  // a sibling method of this container instance — compile it and call with $this + args. An
  const methodNameOnly = methodName.startsWith(`${context.thisType.name}::`)
    ? methodName.slice(context.thisType.name.length + 2)
    : methodName;
  const cm = compileContainerMethod(context.codeGenerationContext, context.thisType, methodNameOnly, expression.callArguments.length);
  if (!cm) return null;
  // A reference-scalar argument that is a plain wasm local (addAndComputeCarry(newMicrosec, carry, ...)) has no address: spill it to
  const writeBacks: string[] = [];
  const methodArgumentOperands = cm.functionParameters.map((fp, fnParamIndex) => {
    const methodArgument = expression.callArguments[fnParamIndex] ?? fp.defaultValue;
    if (!methodArgument) return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (methodArgument.kind === "nullptr_literal") return fp.isAddr ? "(i32.const 0)" : "(i64.const 0)";
    if (!fp.isAddr) return emitValue(context, methodArgument);
    const emittedAddress = emitAddress(context, methodArgument);
    if (emittedAddress) return emittedAddress;
    // `&x` (pointer out-param) and parens unwrap to the same scalar-local spill as a bare `x`.
    let argSource: Expression = methodArgument;
    while (argSource.kind === "paren" || (argSource.kind === "unary_op" && argSource.operator === "&")) {
      argSource = argSource.kind === "paren" ? argSource.expression : argSource.argument;
    }
    const size = allocateScratchSlotNode(context, 8);
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, size, lowerValueExpression(context, argSource)))}`,
    );
    if (argSource.kind === "identifier" && context.localVars.get(argSource.name)?.wasmType === "i64") {
      writeBacks.push(`    ${setLocal(context, argSource.name, watIr.rawLoad("i64.load", null, size))}`);
    }
    return watIr.serializeWatNode(size);
  });
  const call = `(call ${cm.label} (local.get $this) ${methodArgumentOperands.join(" ")})`;
  if (valueWanted) {
    if (cm.retKind !== "i64") {
      context.lines.push(`    ${call}`);
      context.lines.push(...writeBacks);
      return "(i64.const 0)";
    }
    if (!writeBacks.length) return call;
    const returnScratch = `tmp${context.tmpCount++}`;
    context.localVars.set(returnScratch, { wasmType: "i64" });
    context.lines.push(
      `    ${setLocal(context, returnScratch, watIr.rawWatNode(call, "i64", "unconverted: container method call"))}`,
    );
    context.lines.push(...writeBacks);
    return `(local.get $${returnScratch})`;
  }
  context.lines.push(
    cm.retKind === "i64"
      ? `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.rawWatNode(call, "i64", "unconverted: container method call")))}`
      : `    ${call}`,
  );
  context.lines.push(...writeBacks);
  return "";
}

// rvalue call: a value helper, qpi getter, qpi valued host call, a value-returning container method, or a math
export function emitCallValueIr(context: FunctionEmissionContext, expression: Expression & { kind: "call" }): watIr.WatNode {
  if (context.codeGenerationContext.gtestMode && expression.callee.kind === "identifier" && expression.callee.name === "getBalance") {
    const who = expression.callArguments[0] ? emitAddress(context, expression.callArguments[0]) : null;
    if (!who) throw new Error("gtest getBalance account must be addressable");
    return watIr.functionCall("$qt_balance", addrIr(who));
  }
  const primitive =
    expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name"
      ? platformPrimitive(expression.callee.name)
      : undefined;
  if (primitive) {
    for (const capability of primitive.capabilities ?? []) context.codeGenerationContext.capabilities.add(capability);
    if (expression.callArguments.length !== primitive.operands.length) {
      throw new Error(
        `${primitive.name} expects ${primitive.operands.length} argument(s), got ${expression.callArguments.length}`,
      );
    }
  }

  if (primitive?.kind === "multiply-high") {
    const left = expression.callArguments[0] ? lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0);
    const right = expression.callArguments[1] ? lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
    const high = watIr.functionCall(primitive.signed ? "$intr_mulhi_s" : "$intr_mulhi_u", left, right);
    let output: Expression | undefined = expression.callArguments[2];
    while (output?.kind === "paren" || (output?.kind === "unary_op" && output.operator === "&")) {
      output = output.kind === "paren" ? output.expression : output.argument;
    }
    if (output?.kind === "identifier" && context.localVars.get(output.name)?.wasmType === "i64") {
      context.lines.push(`    ${setLocal(context, output.name, high)}`);
    } else {
      const out = expression.callArguments[2] ? emitAddress(context, expression.callArguments[2]) : null;
      if (!out) throw new Error(`${primitive.name} high-limb output is not addressable`);
      context.lines.push(`    ${watIr.serializeWatNode(watIr.rawStore("i64.store", null, addrIr(out), high))}`);
    }
    return watIr.operation("i64.mul", left, right);
  }

  if (primitive?.kind === "wasm-unary" && primitive.wasmOp) {
    return watIr.operation(primitive.wasmOp, lowerValueExpression(context, expression.callArguments[0]));
  }
  if (primitive?.kind === "chain-rdrand" && primitive.width) {
    const output = emitAddress(context, expression.callArguments[0]);
    if (!output) throw new Error(`${primitive.name} output is not addressable`);
    return watIr.operation("i64.extend_i32_u", watIr.functionCall(`$intr_rdrand${primitive.width}`, addrIr(output)));
  }
  if (primitive?.kind === "mask-extract") {
    const input = emitAddress(context, expression.callArguments[0]);
    if (!input) throw new Error(`${primitive.name} operand must be addressable`);
    let mask: watIr.WatNode = watIr.i64Constant(0);
    for (let byte = 0; byte < 32; byte++) {
      const value = watIr.rawLoad("i64.load8_u", byte, addrIr(input));
      const bit = watIr.operation("i64.and", watIr.operation("i64.shr_u", value, watIr.i64Constant(7)), watIr.i64Constant(1));
      mask = watIr.operation("i64.or", mask, watIr.operation("i64.shl", bit, watIr.i64Constant(byte)));
    }
    return mask;
  }
  if (primitive?.kind === "test-zero") {
    const left = emitAddress(context, expression.callArguments[0]);
    const right = emitAddress(context, expression.callArguments[1]);
    if (!left || !right) throw new Error(`${primitive.name} operands must be addressable`);
    let combined: watIr.WatNode = watIr.i64Constant(0);
    for (let lane = 0; lane < 4; lane++) {
      const argument = watIr.rawLoad("i64.load", lane * 8, addrIr(left));
      const templateBindings = watIr.rawLoad("i64.load", lane * 8, addrIr(right));
      combined = watIr.operation("i64.or", combined, watIr.operation("i64.and", argument, templateBindings));
    }
    return watIr.operation("i64.extend_i32_u", watIr.operation("i64.eqz", combined));
  }

  // ProposalVoting proxy `qpi(state.proposals).method(...)` — compile the real qpi.h proxy method against the wrapped ProposalVoting instance. A sibling proxy
  if (context.proxyClass) {
    const sib = emitProxySiblingCall(context, expression, true);
    if (sib !== null) return watIr.rawWatNode(sib, "i64", "unconverted: proxy sibling call");
  }
  {
  const wrapperMethod = qpiWrapperMethod(expression);
  if (wrapperMethod) {
    const real = emitProposalProxyCall(context, expression, true);
    if (real !== null) return watIr.rawWatNode(real, "i64", "unconverted: proposal proxy call");
    throw new Error(`authoritative proposal method '${wrapperMethod}' could not be lowered`);
    }
  }

  // Inter-contract call in value context — the _E forms capture the InterContractCallError into a variable (`InterContractCallError err =
  if (
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "__qpi_call_other" || expression.callee.name === "__qpi_invoke_other")
  ) {
    const wat = emitInterContract(context, expression, expression.callee.name === "__qpi_invoke_other");
    if (wat)
      return watIr.operation("i64.extend_i32_s", watIr.rawWatNode(wat, "i32", "unconverted: inter-contract call"));
    context.codeGenerationContext.warn(
      `unsupported inter-contract call to '${expression.callArguments[0]?.kind === "identifier" ? expression.callArguments[0].name : "?"}' (no callee IDL)`,
      expression.span.line,
    );
    return watIr.i64Constant(0);
  }

  const ai = emitAssetIter(context, expression, "value");
  if (ai !== null) return watIr.rawWatNode(ai, "i64", "unconverted: asset iterator");

  const tc = emitThisCall(context, expression, true);
  if (tc !== null) return watIr.rawWatNode(tc, "i64", "unconverted: this-call");

  const helperCallText = emitHelperCall(context, expression, true);
  if (helperCallText !== null) return watIr.rawWatNode(helperCallText, "i64", "unconverted: helper call");

  if (expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name") {
    const name = expression.callee.kind === "identifier" ? expression.callee.name : expression.callee.name;
    const base = symbolBaseName(name);
    if (MATH_INTRINSIC_NAMES.has(base)) {
      throw new Error(`authoritative QPI math function '${name}' could not be lowered`);
    }
  }

  const containerCallText = emitContainerCall(context, expression, true);
  if (containerCallText !== null) return watIr.rawWatNode(containerCallText, "i64", "source-compiled instance method");

  emitQpiCall(context, expression);

  // Functional-style scalar cast: uint64(x) / sint64(x) / uint8(x) / bit(x) ... — narrowed to the target
  if (
    expression.callee.kind === "identifier" &&
    SCALAR_SIZE[expression.callee.name] !== undefined &&
    expression.callArguments.length === 1
  ) {
    return narrowCastIr(lowerValueExpression(context, expression.callArguments[0]), expression.callee.name);
  }

  // The same cast through a template parameter: T(x) inside a qpi.h template body where T binds to a
  if (expression.callee.kind === "identifier" && expression.callArguments.length === 1) {
    const bound = context.thisBind?.types.get(expression.callee.name);
    if (bound?.kind === "name" && SCALAR_SIZE[bound.name] !== undefined) {
      return narrowCastIr(lowerValueExpression(context, expression.callArguments[0]), bound.name);
    }
  }

  // uint128(i_high, i_low) two-arg constructor as a scalar value: the i64-collapsed model carries the low 64 bits, so the
  if (
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "uint128" || expression.callee.name === "uint128_t") &&
    expression.callArguments.length === 2
  ) {
    return lowerValueExpression(context, expression.callArguments[1]);
  }

  context.codeGenerationContext.warn(`unsupported call as value [${describeShape(expression)}]`, expression.span.line);
  return watIr.i64Constant(0);
}

export function emitCallValue(context: FunctionEmissionContext, expression: Expression & { kind: "call" }): string {
  return watIr.serializeWatNode(emitCallValueIr(context, expression));
}

// statement call: a container mutation or a side-effecting qpi host call.
export function emitInterContract(
  context: FunctionEmissionContext,
  expression: Expression & { kind: "call" },
  isInvoke: boolean,
): string | null {
  const calleeArg = expression.callArguments[0];
  const functionArg = expression.callArguments[1];
  if (calleeArg?.kind !== "identifier" || functionArg?.kind !== "identifier") return null;
  const callee = context.codeGenerationContext.callees.get(calleeArg.name);
  let idx: number | null = callee?.index ?? null;
  if (idx === null) {
    const resolvedConstant = context.codeGenerationContext.resolveConst(`${calleeArg.name}_CONTRACT_INDEX`);
    if (resolvedConstant !== null) idx = Number(resolvedConstant);
  }
  const entry = isInvoke ? callee?.procedures[functionArg.name] : callee?.functions[functionArg.name];
  if (idx === null || !entry) return null;

  if (!expression.callArguments[2] || !expression.callArguments[3])
    throw new Error(`${isInvoke ? "INVOKE" : "CALL"}_OTHER requires input and output buffers`);
  const inAddr = emitAddress(context, expression.callArguments[2]);
  const outAddr = emitAddress(context, expression.callArguments[3]);
  if (!inAddr || !outAddr)
    throw new Error(`${isInvoke ? "INVOKE" : "CALL"}_OTHER input and output must be addressable`);
  const inSize = (expression.callArguments[2] ? resolveExpressionAddress(context, expression.callArguments[2])?.size : undefined) ?? entry.inSize;
  const outSize =
    (expression.callArguments[3] ? resolveExpressionAddress(context, expression.callArguments[3])?.size : undefined) ?? entry.outSize;
  const dims = `(i32.const ${idx}) (i32.const ${entry.inputType}) ${inAddr} (i32.const ${inSize}) ${outAddr} (i32.const ${outSize})`;
  // Returns the bare i32 call expression (the InterContractCallError). The statement caller drops it; the
  if (isInvoke) {
    const reward = expression.callArguments[4] ? emitValue(context, expression.callArguments[4]) : "(i64.const 0)";
    return `(call $liteInvokeProcedure ${dims} ${reward})`;
  }
  return `(call $liteCallFunction ${dims})`;
}

// The ProposalVoting wrapper call shape: `qpi(<aggregate>).<method>(...)` — a member call whose object is a `qpi(...)` call. Returns the
export function qpiWrapperMethod(expression: Expression & { kind: "call" }): string | null {
  const callee = expression.callee;
  if (callee.kind !== "member_access") return null;
  const object = callee.object;
  if (object.kind === "call" && object.callee.kind === "identifier" && object.callee.name === "qpi")
    return callee.member;
  return null;
}

export function describeShape(expression: Expression): string {
  if (!expression) return "?";
  if (expression.kind === "identifier") return expression.name;
  if (expression.kind === "member_access") return `${describeShape(expression.object)}.${expression.member}`;
  if (expression.kind === "call") return `${describeShape(expression.callee)}(${expression.callArguments.length})`;
  if (expression.kind === "subscript") return `${describeShape(expression.object)}[]`;
  return expression.kind;
}

export function emitCall(context: FunctionEmissionContext, expression: Expression & { kind: "call" }): void {
  if (context.codeGenerationContext.gtestMode && expression.callee.kind === "identifier") {
    const name = expression.callee.name;
    if (name === "__qtest_noop" || name === "initEmptySpectrum" || name === "initEmptyUniverse")
      return;

    if (name === "invokeUserProcedure") {
      const input = expression.callArguments[2] ? resolveExpressionAddress(context, expression.callArguments[2]) : null;
      const output = expression.callArguments[3] ? resolveExpressionAddress(context, expression.callArguments[3]) : null;
      const origin = expression.callArguments[4] ? emitAddress(context, expression.callArguments[4]) : null;
      if (!input || !output || !origin)
        throw new Error("gtest invokeUserProcedure requires addressable input, output, and origin");
      const slot = watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[0]));
      const inputType = watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[1]));
      const amount = expression.callArguments[5] ? lowerValueExpression(context, expression.callArguments[5]) : watIr.i64Constant(0);
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_invoke", slot, inputType, addrIr(input.addr), watIr.i32Constant(input.size), addrIr(output.addr), amount, addrIr(origin))))}`,
      );
      return;
    }
    if (name === "callFunction") {
      let input = expression.callArguments[2] ? resolveExpressionAddress(context, expression.callArguments[2]) : null;
      const output = expression.callArguments[3] ? resolveExpressionAddress(context, expression.callArguments[3]) : null;
      if (!input && expression.callArguments[2]) {
        const addr = emitAddress(context, expression.callArguments[2]);
        const callee =
          expression.callArguments[2].kind === "call" &&
          (expression.callArguments[2].callee.kind === "identifier" ||
            expression.callArguments[2].callee.kind === "qualified_name")
            ? expression.callArguments[2].callee.name
            : null;
        const type: TypeSpec | null = callee ? { kind: "name", name: callee } : null;
        const size = type ? context.codeGenerationContext.sizeOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) : 0;
        if (addr && type)
          input = { addr, type, size, layout: context.codeGenerationContext.layoutOfType(type, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS) };
      }
      if (!input || !output) {
        throw new Error(
          `gtest callFunction requires addressable input and output (${describeShape(expression.callArguments[2])}, ${describeShape(expression.callArguments[3])})`,
        );
      }
      const slot = watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[0]));
      const inputType = watIr.operation("i32.wrap_i64", lowerValueExpression(context, expression.callArguments[1]));
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_query", slot, inputType, addrIr(input.addr), watIr.i32Constant(input.size), addrIr(output.addr), watIr.i32Constant(output.size))))}`,
      );
      return;
    }
    if (name === "increaseEnergy") {
      const who = expression.callArguments[0] ? emitAddress(context, expression.callArguments[0]) : null;
      if (!who) throw new Error("gtest increaseEnergy account must be addressable");
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$qt_fund", addrIr(who), expression.callArguments[1] ? lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0)))}`,
      );
      return;
    }
    if (name === "callSystemProcedure") {
      const slot = watIr.operation(
        "i32.wrap_i64",
        expression.callArguments[0] ? lowerValueExpression(context, expression.callArguments[0]) : watIr.i64Constant(0),
      );
      const procedure = watIr.operation(
        "i32.wrap_i64",
        expression.callArguments[1] ? lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0),
      );
      context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", watIr.functionCall("$qt_system", slot, procedure)))}`);
      return;
    }

    const assertion = name.match(/^__qtest_(expect|assert)_(eq|ne|lt|le|gt|ge|true|false)$/);
    if (assertion) {
      const fatal = assertion[1] === "assert";
      const operation = assertion[2];
      const left =
        expression.callArguments[0] ?? ({ kind: "int_literal", value: "0", span: expression.span } as Expression);
      const right =
        operation === "true" || operation === "false"
          ? ({
              kind: "int_literal",
              value: operation === "true" ? "0" : "0",
              span: expression.span,
            } as Expression)
          : (expression.callArguments[1] ?? ({ kind: "int_literal", value: "0", span: expression.span } as Expression));
      const operator =
        operation === "true"
          ? "!="
          : operation === "false"
            ? "=="
            : ({ eq: "==", ne: "!=", lt: "<", le: "<=", gt: ">", ge: ">=" } as const)[
                operation as "eq" | "ne" | "lt" | "le" | "gt" | "ge"
              ];
      const comparison = lowerValueExpression(context, { kind: "binary_op", operator, left, right, span: expression.span });
      const code = ["eq", "ne", "lt", "le", "gt", "ge", "true", "false"].indexOf(operation);
      context.lines.push(`    (if (i64.eqz ${watIr.serializeWatNode(comparison)}) (then`);
      context.lines.push(
        `      ${watIr.serializeWatNode(watIr.functionCall("$qt_fail", watIr.i32Constant(code), watIr.i32Constant(fatal ? 1 : 0)))}`,
      );
      if (fatal) context.lines.push("      (return)");
      context.lines.push("    ))");
      return;
    }
  }

  // The generic HashFunction<KeyT> source body calls core-lite's KangarooTwelve primitive with an
  // explicit output length. The lite host exposes K12 as a 32-byte producer, so hash into a private
  if (expression.callee.kind === "identifier" && expression.callee.name === "KangarooTwelve") {
    const input = expression.callArguments[0] ? (emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const inputSize = expression.callArguments[1] ? lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
    const digest = allocateScratchSlotNode(context, 32);
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$lh_k12", addrIr(input), watIr.operation("i32.wrap_i64", inputSize), digest))}`,
    );

    let output: Expression | undefined = expression.callArguments[2];
    while (output?.kind === "paren" || (output?.kind === "unary_op" && output.operator === "&")) {
      output = output.kind === "paren" ? output.expression : output.argument;
    }
    if (output?.kind === "identifier" && context.localVars.get(output.name)?.wasmType === "i64") {
      context.lines.push(`    ${setLocal(context, output.name, watIr.rawLoad("i64.load", null, digest))}`);
    } else {
      const outAddr = expression.callArguments[2] ? emitAddress(context, expression.callArguments[2]) : null;
      if (!outAddr) throw new Error("KangarooTwelve output is not addressable");
      const outputSize = expression.callArguments[3] ? lowerValueExpression(context, expression.callArguments[3]) : watIr.i64Constant(32);
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(outAddr), digest, watIr.operation("i32.wrap_i64", outputSize)))}`,
      );
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
      const payload = expression.callArguments[0] ? resolveExpressionAddress(context, expression.callArguments[0]) : null;
      if (!payload) throw new Error(`${expression.callee.name} payload must be an addressable aggregate`);
      if (!payload.layout) throw new Error(`${expression.callee.name} payload must be a struct`);
      const terminator = payload.layout.fields.get("_terminator");
      if (!terminator)
        throw new Error(`${expression.callee.name} payload struct must contain _terminator`);
      if (terminator.offset < 8)
        throw new Error(`${expression.callee.name} payload _terminator offset must be at least 8 bytes`);
      const address = addrIr(payload.addr);
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$qpi_logBytes", watIr.i32Constant(context.codeGenerationContext.slot), watIr.i32Constant(level), address, watIr.i32Constant(terminator.offset)))}`,
      );
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
  if (expression.callee.kind === "identifier" && expression.callee.name === "ASSERT") return;

  const primitive =
    expression.callee.kind === "identifier" || expression.callee.kind === "qualified_name"
      ? platformPrimitive(expression.callee.name)
      : undefined;
  if (primitive?.kind === "memory-store") {
    const destination = emitAddress(context, expression.callArguments[0]);
    const source = emitAddress(context, expression.callArguments[1]);
    if (!destination || !source) throw new Error(`${primitive.name} operands must be addressable`);
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(destination), addrIr(source), watIr.i32Constant(32)))}`,
    );
    return;
  }

  if (primitive?.kind === "chain-rdrand") {
    context.lines.push(`    ${watIr.serializeWatNode(watIr.operation("drop", emitCallValueIr(context, expression)))}`);
    return;
  }

  if (expression.callee.kind === "member_access" && emitInlineStructStatement(context, expression)) return;

  // ProposalVoting proxy `qpi(state.proposals).method(...)` as a statement (e.g. getProposal/vote write
  if (context.proxyClass && emitProxySiblingCall(context, expression, false) !== null) return;
  const proxyMethod = qpiWrapperMethod(expression);
  if (proxyMethod) {
    if (emitProposalProxyCall(context, expression, false) === null) {
      throw new Error(`authoritative proposal method '${proxyMethod}' could not be lowered`);
    }
    return;
  }

  // AssetOwnership/PossessionIterator.begin()/next() — statement forms.
  if (emitAssetIter(context, expression, "stmt") !== null) return;

  // CALL(fn, in, out) → __qpi_call_self(fn, in, out): invoke a PRIVATE_ function of this contract, passing the caller's in/out
  if (expression.callee.kind === "identifier" && expression.callee.name === "__qpi_call_self") {
    const fnArg = expression.callArguments[0];
    const info =
      fnArg?.kind === "identifier"
        ? (context.codeGenerationContext.privates.get(fnArg.name) ?? context.codeGenerationContext.registered.get(fnArg.name))
        : undefined;
    if (info) {
      const inAddr = expression.callArguments[1]
        ? (emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)")
        : "(i32.const 0)";
      const outAddr = expression.callArguments[2]
        ? (emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
        : "(i32.const 0)";
      const locals = `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      context.lines.push(
        `    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${locals})`,
      );
      return;
    }
  }

  // Direct PRIVATE_ function call: `priv(qpi, state, in, out, locals)` — QUtil calls its helpers this way (get_voter_balance/get_qubic_balance) instead
  if (
    expression.callee.kind === "identifier" &&
    expression.callArguments[0]?.kind === "identifier" &&
    expression.callArguments[0].name === "qpi"
  ) {
    // Registered PUBLIC entries are callable the same way (MsVault's isShareHolder(qpi, state, ...)).
    const info = context.codeGenerationContext.privates.get(expression.callee.name) ?? context.codeGenerationContext.registered.get(expression.callee.name);
    if (info) {
      const inAddr = expression.callArguments[2]
        ? (emitAddress(context, expression.callArguments[2]) ?? "(i32.const 0)")
        : "(i32.const 0)";
      const outAddr = expression.callArguments[3]
        ? (emitAddress(context, expression.callArguments[3]) ?? "(i32.const 0)")
        : "(i32.const 0)";
      const localsAddr = expression.callArguments[4]
        ? (emitAddress(context, expression.callArguments[4]) ?? `(call $qpiAllocLocals (i32.const ${info.localsSize}))`)
        : `(call $qpiAllocLocals (i32.const ${info.localsSize}))`;
      context.lines.push(
        `    (call ${info.label} (global.get $ctxBase) (global.get $stateBase) ${inAddr} ${outAddr} ${localsAddr})`,
      );
      return;
    }
  }

  // CALL_OTHER_CONTRACT_FUNCTION(C,f,in,out) / INVOKE_OTHER_CONTRACT_PROCEDURE(C,p,in,out,reward) → a host-mediated call into the contract at C's index. Needs C's callee IDL (index
  if (
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "__qpi_call_other" || expression.callee.name === "__qpi_invoke_other")
  ) {
    const wat = emitInterContract(context, expression, expression.callee.name === "__qpi_invoke_other");
    if (wat)
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.operation("drop", watIr.rawWatNode(wat, "i32", "unconverted: inter-contract call")))}`,
      );
    else
      context.codeGenerationContext.warn(
        `unsupported inter-contract call to '${expression.callArguments[0]?.kind === "identifier" ? expression.callArguments[0].name : "?"}' (no callee IDL)`,
        expression.span.line,
      );
    return;
  }

  // QPI memory wrappers: setMemory(dst,val) / copyMemory(dst,src) / copyFromBuffer(dst,src) / copyToBuffer(dst,src,tailZero). Lowered at the call site so the byte
  if (
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "setMemory" ||
      expression.callee.name === "copyMemory" ||
      expression.callee.name === "copyFromBuffer" ||
      expression.callee.name === "copyToBuffer")
  ) {
    const name = expression.callee.name;
    const dstNode = expression.callArguments[0] ? resolveExpressionAddress(context, expression.callArguments[0]) : null;
    const dst =
      dstNode?.addr ??
      (expression.callArguments[0] ? (emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)");
    if (name === "setMemory") {
      const val = expression.callArguments[1] ? lowerValueExpression(context, expression.callArguments[1]) : watIr.i64Constant(0);
      // $setMem is (dst, size, val).
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(dst), watIr.i32Constant(dstNode?.size ?? 0), watIr.operation("i32.wrap_i64", val)))}`,
      );
      return;
    }
    const srcNode = expression.callArguments[1] ? resolveExpressionAddress(context, expression.callArguments[1]) : null;
    const src =
      srcNode?.addr ??
      (expression.callArguments[1] ? (emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)") : "(i32.const 0)");
    // copyToBuffer copies sizeof(src) (the smaller object into a larger buffer); the others copy sizeof(dst).
    const size = name === "copyToBuffer" ? (srcNode?.size ?? 0) : (dstNode?.size ?? 0);
    context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(dst), addrIr(src), watIr.i32Constant(size)))}`);
    return;
  }

  // Low-level memory intrinsics copyMem(dst,src,n) / setMem(dst,val,n). Handled here (not only in
  if (
    expression.callee.kind === "identifier" &&
    (expression.callee.name === "copyMem" || expression.callee.name === "setMem")
  ) {
    const dst = expression.callArguments[0] ? (emitAddress(context, expression.callArguments[0]) ?? "(i32.const 0)") : "(i32.const 0)";
    const wrapArg = (expression: Expression | undefined) =>
      watIr.operation("i32.wrap_i64", expression ? lowerValueExpression(context, expression) : watIr.i64Constant(0));
    if (expression.callee.name === "copyMem") {
      const src = expression.callArguments[1] ? (emitAddress(context, expression.callArguments[1]) ?? "(i32.const 0)") : "(i32.const 0)";
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(dst), addrIr(src), wrapArg(expression.callArguments[2])))}`,
      );
    } else {
      context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", addrIr(dst), wrapArg(expression.callArguments[1]), wrapArg(expression.callArguments[2])))}`,
      );
    }
    return;
  }

  const tc = emitThisCall(context, expression, false);
  if (tc !== null) return;

  const helperCallText = emitHelperCall(context, expression, false);
  if (helperCallText !== null) return;

  const containerCallText = emitContainerCall(context, expression, false);
  if (containerCallText !== null) return;

  emitQpiCall(context, expression);

  context.codeGenerationContext.warn(`unsupported call statement [${describeShape(expression)}]`, expression.span.line);
}
