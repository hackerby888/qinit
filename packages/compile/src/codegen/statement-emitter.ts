import { emitCall } from "./calls/dispatch";
import { callCompiled, emitAssetIter } from "./calls/containers";
import { SCALAR_SIZE, C_SCALAR_NAMES } from "./tables";
import {
  isAutoType,
  resolveAliasType,
  lowerValueExpression,
  narrowLocalValue,
  emitValue,
  emitAssign,
  lowerUint128Expression,
} from "./expression-lowering";
import {
  setLocal,
  castInfo,
  resolveExpressionAddress,
  emitAddress,
  addrIr,
  emitConstruct,
  emitInlineStructMethod,
  resolveLvalue,
  isUint128,
  allocateScratchSlotNode,
  emitScalarLoad,
  isSignedScalarType,
  emitScalarStore,
  narrowCast,
} from "./address-resolution";
import { CodeGenerationContext } from "./code-generation-context";
import { FunctionEmissionContext, StructLayout, CompiledHelperMetadata, TemplateBindings, EMPTY_TEMPLATE_BINDINGS } from "./types";
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

function emitArrayInitializer(
  context: FunctionEmissionContext,
  base: watIr.WatNode,
  type: TypeSpec & { kind: "array" },
  initializer: Expression & { kind: "initializer_list" },
): void {
  const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
  const elemSize = context.codeGenerationContext.sizeOfType(type.element, templateBindings);
  initializer.expressions.forEach((expression, index) => {
    const dst = watIr.addressWithOffset(base, index * elemSize);
    if (type.element.kind === "array" && expression.kind === "initializer_list") {
      emitArrayInitializer(context, dst, type.element, expression);
    } else if (
      context.codeGenerationContext.isAggregateType(type.element) &&
      (expression.kind === "initializer_list" || expression.kind === "construct")
    ) {
      const callArguments = expression.kind === "initializer_list" ? expression.expressions : expression.callArguments;
      emitConstruct(context, watIr.serializeWatNode(dst), type.element, callArguments);
    } else {
      context.lines.push(`    ${watIr.serializeWatNode(watIr.storeScalar(dst, elemSize, lowerValueExpression(context, expression)))}`);
    }
  });
}

// ---- function body codegen ----

// A scratch i32 local (holds an address). Declared lazily; emitted in the function's local list.
export function allocateTemporaryLocalName(context: FunctionEmissionContext): string {
  let temporaryName: string;
  do temporaryName = `__qinit_tmp${context.tmpCount++}`;
  while (context.localVars.has(temporaryName) || context.params?.has(temporaryName));
  context.localVars.set(temporaryName, { wasmType: "i32" });
  return temporaryName;
}

export function emitFunction(
  codeGenerationContext: CodeGenerationContext,
  label: string,
  fn: FunctionDecl | null,
  state: StructLayout,
  inL: StructLayout,
  outL: StructLayout,
  localsL: StructLayout,
  paramAliases?: Map<
    string,
    { wasmType: "i32" | "i64"; isAddr: boolean; type: TypeSpec; local?: string }
  >,
): string {
  const contextType = fn?.params[0] ? codeGenerationContext.derefType(fn.params[0].type) : null;
  const qpiContext =
    contextType?.kind === "name" && contextType.name === "QpiContextProcedureCall"
      ? "procedure"
      : contextType?.kind === "name" && contextType.name === "QpiContextFunctionCall"
        ? "function"
        : undefined;
  const params = new Map(paramAliases ?? []);
  if (fn?.params[0]?.name === "qpi" && contextType && qpiContext) {
    params.set("qpi", { wasmType: "i32", isAddr: true, type: contextType, local: "__qinit_ctx" });
  }
  const lookup = codeGenerationContext.namespaceContextOf(fn);
  const context: FunctionEmissionContext = {
    codeGenerationContext,
    state,
    in: inL,
    out: outL,
    locals: localsL,
    localVars: new Map(),
    lines: [],
    tmpCount: 0,
    loops: [],
    loopCount: 0,
    hasStateParam: true,
    params,
    qpiContext,
    sourceNamespace: lookup.sourceNamespace,
    usingNamespaces: lookup.usingNamespaces,
  };

  // Pre-scan for local variable declarations (must be declared at function top in WAT)
  if (fn?.body) collectFunctionLocals(fn.body, context);

  const header = `  (func ${label} (param $__qinit_ctx i32) (param $__qinit_state i32) (param $__qinit_in i32) (param $__qinit_out i32) (param $__qinit_locals i32)`;

  if (fn?.body) {
    emitStatement(context, fn.body);
  }

  // Build local decls AFTER emit so scratch temps created during lowering are included.
  const localDecls = [...context.localVars.entries()].map(
    ([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`,
  );

  return [header, ...localDecls, ...context.lines, "  )"].join("\n");
}

// Emit a value-helper (e.g. toReturnCode) as a wasm function with its own scalar/address parameters
export function emitHelperFunction(
  codeGenerationContext: CodeGenerationContext,
  info: CompiledHelperMetadata,
  fn: { body?: Statement },
  stateLayout: StructLayout,
  bind?: TemplateBindings,
): string {
  const empty = { size: 0, align: 1, fields: new Map() };
  const context: FunctionEmissionContext = {
    codeGenerationContext,
    state: stateLayout,
    in: empty,
    out: empty,
    locals: empty,
    localVars: new Map(),
    lines: [],
    tmpCount: 0,
    loops: [],
    loopCount: 0,
    params: new Map(),
    retIsValue: info.retIsValue,
    retTypeName: info.retType?.kind === "name" ? info.retType.name : undefined,
    // For an instantiated template free fn the body resolves T/L through these bindings (e.g. `L`→4).
    thisBind: bind,
    sourceNamespace: info.sourceNamespace,
    usingNamespaces: info.usingNamespaces,
  };
  // An aggregate-returning helper (`id liquidityPov(...)`) gets a leading $ret destination-address param; `return e` copies the 32/N-byte value there.
  if (info.retAgg) {
    context.retAddr = "(local.get $__qinit_ret)";
    context.retAggSize = info.retAgg;
    context.retType = info.retType;
  }
  for (const parameter of info.params)
    context.params!.set(parameter.name, { wasmType: parameter.wasmType, isAddr: parameter.isAddr, type: parameter.type });

  if (fn.body) collectFunctionLocals(fn.body, context);

  // By-value aggregate params: bind the name to a private copy, so callee writes stay local (C++ value semantics).
  for (const parameterCandidate of info.params) {
    if (!parameterCandidate.byValAgg) continue;
    const size = codeGenerationContext.sizeOfType(parameterCandidate.type, bind ?? EMPTY_TEMPLATE_BINDINGS);
    if (!(size > 0)) continue;
    let cp = `__qinit_bv_${parameterCandidate.name}`;
    while (context.localVars.has(cp) || context.params?.has(cp)) cp += "_";
    context.localVars.set(cp, { wasmType: "i32" });
    context.lines.push(`    ${setLocal(context, cp, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(size)))}`);
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(cp, "i32"), watIr.localGet(parameterCandidate.name, "i32"), watIr.i32Constant(size)))}`,
    );
    context.params!.get(parameterCandidate.name)!.local = cp;
  }

  const retParam = info.retAgg ? "(param $__qinit_ret i32) " : "";
  const paramDecls = info.params.map((parameter) => `(param $${parameter.name} ${parameter.wasmType})`).join(" ");
  const result = info.retIsValue ? " (result i64)" : "";
  const header = `  (func ${info.label} ${retParam}${paramDecls}${result}`.replace(/\s+\)/, ")");

  if (fn.body) emitStatement(context, fn.body);

  const localDecls = [...context.localVars.entries()].map(
    ([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`,
  );
  // A value helper needs a fallthrough result for control paths that do not hit a return.
  const tail = info.retIsValue ? ["    (i64.const 0)"] : [];
  return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}

export function collectFunctionLocals(statement: Statement, context: FunctionEmissionContext): void {
  switch (statement.kind) {
    case "compound":
      for (const bodyItem of statement.body) collectFunctionLocals(bodyItem, context);
      break;
    case "if":
      collectFunctionLocals(statement.then, context);
      if (statement.else_) collectFunctionLocals(statement.else_, context);
      break;
    case "for":
      if (statement.initializer) collectFunctionLocals(statement.initializer, context);
      collectFunctionLocals(statement.body, context);
      break;
    case "while":
      collectFunctionLocals(statement.body, context);
      break;
    case "do_while":
      collectFunctionLocals(statement.body, context);
      break;
    case "switch":
      collectFunctionLocals(statement.body, context);
      break;
    case "declaration": {
      // A struct declared inside a function body (QUTIL setupNewProposal's `struct Shareholder {...}`) isn't in globalStructs, so sizeof(Shareholder) and
      if (statement.declaration.kind === "struct") {
        const structDeclaration = statement.declaration as StructDecl;
        if (structDeclaration.name && !context.codeGenerationContext.globalStructs.has(structDeclaration.name)) context.codeGenerationContext.globalStructs.set(structDeclaration.name, structDeclaration);
        break;
      }
      // Function-scope alias (`using Local = sint64;`): record it so locals declared with the alias name resolve as known
      if (statement.declaration.kind === "typedef_decl") {
        const td = statement.declaration as { name: string; type: TypeSpec };
        if (!context.codeGenerationContext.typedefs.has(td.name)) context.codeGenerationContext.typedefs.set(td.name, td.type);
        break;
      }
      if (statement.declaration.kind === "variable") {
        const variableDeclaration = statement.declaration as VariableDecl;
        // reference/pointer locals hold an address (i32); scalars use the i64 value model. A __ScopedScratchpad
        const holdsAddr =
          variableDeclaration.type.kind === "name" && /(ScopedScratchpad|Iterator)$/.test(variableDeclaration.type.name);
        const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;

        // `auto` locals take their shape from the initializer; casts supply full type (e.g., auto* queue = reinterpret_cast<sint64_4*>(...)).
        let dType = variableDeclaration.type;
        if (isAutoType(dType) && variableDeclaration.initializer) {
          const ci = castInfo(variableDeclaration.initializer);
          if (ci) {
            dType = ci.type;
          } else if (variableDeclaration.initializer.kind === "identifier") {
            dType =
              context.localVars.get(variableDeclaration.initializer.name)?.type ?? context.params?.get(variableDeclaration.initializer.name)?.type ?? dType;
          } else if (variableDeclaration.initializer.kind === "call" && variableDeclaration.initializer.callee.kind === "identifier") {
            dType = context.codeGenerationContext.helpers.get(variableDeclaration.initializer.callee.name)?.retType ?? dType;
          } else if (
            variableDeclaration.initializer.kind === "call" &&
            variableDeclaration.initializer.callee.kind === "member_access" &&
            variableDeclaration.initializer.callee.object.kind === "identifier"
          ) {
            const callee = variableDeclaration.initializer.callee;
            const objectName = variableDeclaration.initializer.callee.object.name;
            const objectType =
              context.localVars.get(objectName)?.type ?? context.params?.get(objectName)?.type;
            const objectStruct = objectType ? context.codeGenerationContext.structOf(objectType, templateBindings) : null;
            const named = objectStruct?.members.find(
              (member) =>
                member.kind === "function" && (member as FunctionDecl).name === callee.member,
            ) as FunctionDecl | undefined;
            dType = named?.returnType ?? dType;
          } else if (variableDeclaration.initializer.kind === "subscript" && variableDeclaration.initializer.object.kind === "identifier") {
            const ot = context.localVars.get(variableDeclaration.initializer.object.name)?.type;
            const operator = ot ? resolveAliasType(context.codeGenerationContext, ot) : null;
            if (operator?.kind === "pointer") {
              dType = operator.pointee;
            }
          }
        }

        // A local of an unresolvable named type would silently corrupt the locals layout (size 0, scalar fallback) —
        if (
          dType.kind === "name" &&
          !isAutoType(dType) &&
          SCALAR_SIZE[dType.name] === undefined &&
          !C_SCALAR_NAMES.has(dType.name) &&
          !dType.name.includes("::") &&
          !templateBindings.types.has(dType.name) &&
          !context.codeGenerationContext.typedefs.has(dType.name) &&
          !context.codeGenerationContext.enumNames.has(dType.name) &&
          !context.codeGenerationContext.structByName(dType.name, templateBindings)
        ) {
          context.codeGenerationContext.error(
            `unknown type '${dType.name}' in declaration of '${variableDeclaration.name}'`,
            statement.span.line,
          );
        }

        // A struct-typed local (DateAndTime begin = *this) lives in an allocated slot; its wasm local holds the slot
        const concrete =
          dType.kind === "name" && templateBindings.types.has(dType.name) ? templateBindings.types.get(dType.name)! : dType;
        const isAgg =
          !holdsAddr &&
          dType.kind !== "reference" &&
          dType.kind !== "pointer" &&
          context.codeGenerationContext.isAggregateType(concrete);
        const isRef = dType.kind === "reference" || dType.kind === "pointer" || holdsAddr || isAgg;
        // In a ProposalVoting proxy method the `pv`/`qpi` aliases (`ProposalVotingType& pv = this->pv`) are bound as the function's own
        if (context.proxyClass && isRef && (variableDeclaration.name === "pv" || variableDeclaration.name === "qpi")) break;
        const wasmType: "i32" | "i64" = isRef ? "i32" : "i64";
        if (!context.localVars.has(variableDeclaration.name)) {
          context.localVars.set(variableDeclaration.name, { wasmType, type: resolveAliasType(context.codeGenerationContext, concrete) });
        }
      }
      break;
    }
  }
}

// Collect goto-target label names appearing anywhere in a statement subtree.
export function collectGotosIn(statement: Statement, out: Set<string>): void {
  switch (statement.kind) {
    case "goto":
      out.add(statement.label);
      break;
    case "compound":
      for (const bodyItem of statement.body) collectGotosIn(bodyItem, out);
      break;
    case "if":
      collectGotosIn(statement.then, out);
      if (statement.else_) collectGotosIn(statement.else_, out);
      break;
    case "for":
    case "while":
    case "do_while":
    case "switch":
      collectGotosIn(statement.body, out);
      break;
  }
}

// Collect label names defined anywhere in a statement subtree.
export function collectLabelsIn(statement: Statement, out: Set<string>): void {
  switch (statement.kind) {
    case "label":
      out.add(statement.name);
      break;
    case "compound":
      for (const bodyItem of statement.body) collectLabelsIn(bodyItem, out);
      break;
    case "if":
      collectLabelsIn(statement.then, out);
      if (statement.else_) collectLabelsIn(statement.else_, out);
      break;
    case "for":
    case "while":
    case "do_while":
    case "switch":
      collectLabelsIn(statement.body, out);
      break;
  }
}

function emitScratchpadReleases(context: FunctionEmissionContext, from: number, consume: boolean): void {
  if (!context.scratchpadScope || context.scratchpadScope.length <= from) return;
  for (let index = context.scratchpadScope.length - 1; index >= from; index--) {
    context.lines.push(
      `    ${watIr.serializeWatNode(watIr.functionCall("$releaseScratchpad", watIr.localGet(context.scratchpadScope[index], "i32")))}`,
    );
  }
  if (consume) context.scratchpadScope.length = from;
}

// Emit a brace block, lowering forward gotos (relooper-lite). A `goto L` that jumps forward to a label
export function emitCompound(context: FunctionEmissionContext, body: Statement[]): void {
  const spBase = context.scratchpadScope?.length ?? 0;
  const scratchDepthAt = (child: number): number => {
    let depth = spBase;
    for (let index = 0; index < child; index++) {
      const statement = body[index];
      if (statement.kind !== "declaration" || statement.declaration.kind !== "variable") continue;
      const type = (statement.declaration as VariableDecl).type;
      if (type.kind === "name" && /ScopedScratchpad$/.test(type.name)) depth++;
    }
    return depth;
  };
  // child index where each goto-targeted label is rooted
  const labelChild = new Map<string, number>();
  for (let bodyItemIndex = 0; bodyItemIndex < body.length; bodyItemIndex++) {
    const labels = new Set<string>();
    collectLabelsIn(body[bodyItemIndex], labels);
    for (const label of labels) if (!labelChild.has(label)) labelChild.set(label, bodyItemIndex);
  }

  // forward gotos only: a label rooted in a later sibling than the goto. Each gets a block that
  const wasmLabel = new Map<string, string>();
  const blocks: { wl: string; firstGoto: number; closeAt: number }[] = [];
  for (let bodyItemIndexInner = 0; bodyItemIndexInner < body.length; bodyItemIndexInner++) {
    const gotos = new Set<string>();
    collectGotosIn(body[bodyItemIndexInner], gotos);
    for (const goto of gotos) {
      const lc = labelChild.get(goto);
      if (lc === undefined || lc <= bodyItemIndexInner || wasmLabel.has(goto)) continue;
      const wl = `$goto_${goto}_${context.loopCount++}`;
      wasmLabel.set(goto, wl);
      blocks.push({ wl, firstGoto: bodyItemIndexInner, closeAt: lc });
    }
  }

  if (wasmLabel.size === 0) {
    for (const bodyItem of body) emitStatement(context, bodyItem);
  } else {
    if (!context.gotoLabels) context.gotoLabels = new Map();
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
      emitStatement(context, body[bodyItemIndex]);
    }
    while (closeStack.length) {
      context.lines.push(`    )`);
      closeStack.pop();
    }

    for (const labelName of wasmLabel.keys()) context.gotoLabels!.delete(labelName);
  }

  // Scope exit: run __ScopedScratchpad destructors declared in this compound (RAII, LIFO). Without the
  emitScratchpadReleases(context, spBase, true);
}

export function emitStatement(context: FunctionEmissionContext, statement: Statement): void {
  switch (statement.kind) {
    case "compound":
      emitCompound(context, statement.body);
      break;

    case "expression": {
      const discardedText = emitDiscardedExpression(context, statement.expression);
      if (discardedText) context.lines.push(`    ${discardedText}`);
      break;
    }

    case "declaration": {
      if (statement.declaration.kind === "variable") {
        const variableDeclaration = statement.declaration as VariableDecl;
        // The collect pass stored the declared type with `auto` resolved from the initializer; classification here must agree with
        const declared = context.localVars.get(variableDeclaration.name)?.type ?? variableDeclaration.type;
        // __ScopedScratchpad scratchpad(size, initZero): bump a scratch buffer off the arena; the local holds its base address, read back
        if (variableDeclaration.type.kind === "name" && /ScopedScratchpad$/.test(variableDeclaration.type.name)) {
          const callArguments =
            variableDeclaration.initializer && (variableDeclaration.initializer.kind === "construct" || variableDeclaration.initializer.kind === "call") ? variableDeclaration.initializer.callArguments : [];
          const size = callArguments[0] ? lowerValueExpression(context, callArguments[0]) : watIr.i64Constant(0);
          const initZero = callArguments[1]
            ? watIr.operation("i64.ne", watIr.i64Constant(0), lowerValueExpression(context, callArguments[1]))
            : watIr.i32Constant(0);
          context.lines.push(
            `    ${setLocal(context, variableDeclaration.name, watIr.functionCall("$acquireScratchpad", size, initZero))}`,
          );
          (context.scratchpadLocals ??= new Set()).add(variableDeclaration.name);
          (context.scratchpadScope ??= []).push(variableDeclaration.name);
          break;
        }
        // AssetOwnership/PossessionIterator iter(asset): an 8-byte iterator buffer (count@0, cursor@4); the constructor runs the enumerate. Track its type so iter.possessor()/reachedEnd()/next()
        if (variableDeclaration.type.kind === "name" && /Asset(Ownership|Possession)Iterator$/.test(variableDeclaration.type.name)) {
          context.lines.push(`    ${setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(8)))}`);
          (context.refLocals ??= new Map()).set(variableDeclaration.name, variableDeclaration.type);
          const argument =
            variableDeclaration.initializer && (variableDeclaration.initializer.kind === "construct" || variableDeclaration.initializer.kind === "call")
              ? variableDeclaration.initializer.callArguments[0]
              : undefined;
          if (argument) {
            emitAssetIter(
              context,
              {
                kind: "call",
                span: statement.span,
                callArguments: [argument],
                callee: {
                  kind: "member_access",
                  span: statement.span,
                  object: { kind: "identifier", name: variableDeclaration.name, span: statement.span },
                  member: "begin",
                },
              } as Expression & { kind: "call" },
              "stmt",
            );
          }
          break;
        }
        // reference/pointer local: bind to the ADDRESS of its lvalue initializer; member access on it resolves through that address.
        if (declared.kind === "reference" || declared.kind === "pointer") {
          // proxy `pv`/`qpi` aliases are already bound as parameters — drop the alias declaration.
          if (context.proxyClass && (variableDeclaration.name === "pv" || variableDeclaration.name === "qpi")) break;
          if (variableDeclaration.initializer) {
            const node = resolveExpressionAddress(context, variableDeclaration.initializer);
            // Fall back to emitAddr for initializers that aren't plain lvalues but still yield an address — an asset-iterator
            const addr = node?.addr ?? emitAddress(context, variableDeclaration.initializer);
            if (addr) {
              if (!context.refLocals) context.refLocals = new Map();
              // A pointer local keeps its pointer type so resolveAddr's subscript path fires (`shareholders[i]`); a reference binds to its
              const refType =
                declared.kind === "pointer" ? declared : (node?.type ?? declared.referentType);
              context.refLocals.set(variableDeclaration.name, refType);
              context.lines.push(`    ${setLocal(context, variableDeclaration.name, addrIr(addr))}`);
            } else {
              context.codeGenerationContext.warn(`unsupported reference initializer for '${variableDeclaration.name}'`, statement.span.line);
            }
          }
          break;
        }
        // struct-typed local (DateAndTime begin = *this): allocate a slot the wasm local points at, so member reads and
        {
          const db = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
          const concrete =
            declared.kind === "name" && db.types.has(declared.name)
              ? db.types.get(declared.name)!
              : declared;
          if (context.codeGenerationContext.isAggregateType(concrete)) {
            // matches collectLocals' aggregate predicate: the wasm local is i32 (slot address), so this branch must consume the declaration
            let aggSz = context.codeGenerationContext.sizeOfType(concrete, db);
            if (concrete.kind === "array" && aggSz <= 0 && variableDeclaration.initializer?.kind === "initializer_list") {
              aggSz = context.codeGenerationContext.sizeOfType(concrete.element, db) * ((variableDeclaration.initializer as any).expressions ?? []).length;
            }
            const byteSize = Math.max(aggSz, 8);
            context.lines.push(`    ${setLocal(context, variableDeclaration.name, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(byteSize)))}`);
            (context.refLocals ??= new Map()).set(variableDeclaration.name, concrete);
            // uint128_t is a class, not a pair of fields to initialize positionally: its two-argument
            // constructor accepts (high, low), while the resident layout is (low, high). Route every
            if (variableDeclaration.initializer && isUint128(context.codeGenerationContext, concrete)) {
              context.lines.push(
                `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, "i32"), lowerUint128Expression(context, variableDeclaration.initializer), watIr.i32Constant(16)))}`,
              );
              break;
            }
            const ctorArgs =
              variableDeclaration.initializer &&
              (variableDeclaration.initializer.kind === "construct" ||
                (variableDeclaration.initializer.kind === "call" &&
                  variableDeclaration.initializer.callee.kind === "identifier" &&
                  (variableDeclaration.initializer.callee as any).name === (variableDeclaration.type.kind === "name" ? variableDeclaration.type.name : "")))
                ? (variableDeclaration.initializer as any).callArguments
                : null;
            if (ctorArgs && emitConstruct(context, `(local.get $${variableDeclaration.name})`, concrete, ctorArgs)) {
              break;
            }
            // brace-init: array locals (const int daysInMonth[] = {0, 31, ...}) store element-wise; struct locals go field-wise through emitConstruct.
            if (variableDeclaration.initializer?.kind === "initializer_list") {
              if (concrete.kind === "array") {
                context.lines.push(
                  `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, "i32"), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`,
                );
                emitArrayInitializer(context, watIr.localGet(variableDeclaration.name, "i32"), concrete, variableDeclaration.initializer);
                break;
              }
              if (
                emitConstruct(context, `(local.get $${variableDeclaration.name})`, concrete, (variableDeclaration.initializer as any).expressions ?? [])
              ) {
                break;
              }
            }
            if (variableDeclaration.initializer) {
              const src = resolveExpressionAddress(context, variableDeclaration.initializer)?.addr ?? emitAddress(context, variableDeclaration.initializer);
              if (src) {
                context.lines.push(
                  `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(variableDeclaration.name, "i32"), addrIr(src), watIr.i32Constant(byteSize)))}`,
                );
                break;
              }
              context.codeGenerationContext.warn(`unsupported struct-local initializer for '${variableDeclaration.name}'`, statement.span.line);
            }
            context.lines.push(
              `    ${watIr.serializeWatNode(watIr.functionCall("$setMem", watIr.localGet(variableDeclaration.name, "i32"), watIr.i32Constant(byteSize), watIr.i32Constant(0)))}`,
            );
            if (context.codeGenerationContext.gtestMode && !variableDeclaration.initializer && concrete.kind === "name") {
              const struct = context.codeGenerationContext.structOf(concrete, db);
              const constructor = struct?.members.find(
                (member) =>
                  member.kind === "function" &&
                  (member as FunctionDecl).name === concrete.name &&
                  (member as FunctionDecl).body,
              ) as FunctionDecl | undefined;
              const layout = context.codeGenerationContext.layoutOfType(concrete, db);
              if (constructor && layout) {
                emitInlineStructMethod(
                  context,
                  { addr: `(local.get $${variableDeclaration.name})`, type: concrete, size: byteSize, layout },
                  constructor,
                  [],
                );
              }
            }
            break;
          }
        }
        if (variableDeclaration.initializer) {
          context.lines.push(
            `    ${setLocal(context, variableDeclaration.name, narrowLocalValue(context, variableDeclaration.name, lowerValueExpression(context, variableDeclaration.initializer)))}`,
          );
        }
      }
      break;
    }

    case "if": {
      const condition = emitValue(context, statement.condition);
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
      if (statement.initializer) emitStatement(context, statement.initializer);
      const count = context.loopCount++;
      const brk = `$brk${count}`,
        loop = `$loop${count}`,
        cont = `$cont${count}`;
      context.lines.push(`    (block ${brk} (loop ${loop}`);
      if (statement.condition) {
        context.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(context, statement.condition)}))`);
      }
      // continue jumps out of the $cont block to run the update, then loops — matching C semantics.
      context.lines.push(`      (block ${cont}`);
      context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
      emitStatement(context, statement.body);
      context.loops.pop();
      context.lines.push(`      )`);
      if (statement.update) {
        const discardedText = emitDiscardedExpression(context, statement.update);
        if (discardedText) context.lines.push(`      ${discardedText}`);
      }
      context.lines.push(`      (br ${loop})))`);
      break;
    }

    case "while": {
      const count = context.loopCount++;
      const brk = `$brk${count}`,
        loop = `$loop${count}`,
        cont = `$cont${count}`;
      context.lines.push(`    (block ${brk} (loop ${loop}`);
      context.lines.push(`      (br_if ${brk} (i64.eqz ${emitValue(context, statement.condition)}))`);
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
      const brk = `$brk${count}`,
        loop = `$loop${count}`,
        cont = `$cont${count}`;
      context.lines.push(`    (block ${brk} (loop ${loop}`);
      context.lines.push(`      (block ${cont}`);
      context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
      emitStatement(context, statement.body);
      context.loops.pop();
      context.lines.push(`      )`);
      context.lines.push(`      (br_if ${loop} (i64.ne (i64.const 0) ${emitValue(context, statement.condition)}))))`);
      break;
    }

    case "switch": {
      const count = context.loopCount++;
      const brk = `$swbrk${count}`;
      let sw = `__qinit_sw${count}`;
      while (context.localVars.has(sw) || context.params?.has(sw)) sw += "_";
      context.localVars.set(sw, { wasmType: "i64" });
      context.lines.push(`    ${setLocal(context, sw, lowerValueExpression(context, statement.condition))}`);
      context.lines.push(`    (block ${brk}`);
      // break targets the switch; continue still targets the enclosing loop (if any).
      const cont = context.loops.length ? context.loops[context.loops.length - 1].cont : brk;
      context.loops.push({ brk, cont, scratchDepth: context.scratchpadScope?.length ?? 0 });
      const body = statement.body.kind === "compound" ? statement.body.body : [statement.body];

      // Group statements by case/default markers. Each group gets a block label so
      const groups: { test: string | null; statements: Statement[]; label: string }[] = [];
      let caseIdx = 0;
      for (const bodyItem of body) {
        if (bodyItem.kind === "case") {
          groups.push({
            test: `(i64.eq (local.get $${sw}) ${emitValue(context, bodyItem.value)})`,
            statements: [],
            label: `$swcase${count}_${caseIdx++}`,
          });
        } else if (bodyItem.kind === "default") {
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

    case "break":
      if (context.loops.length) {
        const loop = context.loops[context.loops.length - 1];
        emitScratchpadReleases(context, loop.scratchDepth, false);
        context.lines.push(`    (br ${loop.brk})`);
      } else context.codeGenerationContext.warn(`break outside loop`, statement.span.line);
      break;

    case "continue":
      if (context.loops.length) {
        const loop = context.loops[context.loops.length - 1];
        emitScratchpadReleases(context, loop.scratchDepth, false);
        context.lines.push(`    (br ${loop.cont})`);
      } else context.codeGenerationContext.warn(`continue outside loop`, statement.span.line);
      break;

    case "return":
      if (context.inlineReturnLabel) {
        if (statement.value && context.retAddr) {
          const src = emitAddress(context, statement.value);
          if (src) {
            context.lines.push(
              `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr), addrIr(src), watIr.i32Constant(context.retAggSize ?? 0)))}`,
            );
          } else if (
            context.retType &&
            (statement.value.kind === "initializer_list" || statement.value.kind === "construct")
          ) {
            const callArguments =
              statement.value.kind === "initializer_list" ? statement.value.expressions : statement.value.callArguments;
            if (!emitConstruct(context, context.retAddr, context.retType, callArguments)) {
              throw new Error("aggregate return initializer could not be constructed");
            }
          } else {
            throw new Error("aggregate return expression from inline method is not addressable");
          }
        } else if (statement.value && context.inlineValueLocal) {
          context.lines.push(
            `    ${setLocal(context, context.inlineValueLocal, narrowLocalValue(context, context.inlineValueLocal, lowerValueExpression(context, statement.value)))}`,
          );
        }
        context.lines.push(`    (br ${context.inlineReturnLabel})`);
        break;
      }
      // an inlined struct method's `return *this` carries no value out (the object flows via thisAddr); emitting a wasm
      if (context.inlineMethod) break;
      if (statement.value && context.retAddr) {
        // aggregate-returning helper: copy the returned value into the caller-supplied dest, then return
        const src = emitAddress(context, statement.value);
        if (src) {
          context.lines.push(
            `    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(context.retAddr!), addrIr(src), watIr.i32Constant(context.retAggSize!)))}`,
          );
        } else if (
          context.retType &&
          (statement.value.kind === "initializer_list" || statement.value.kind === "construct")
        ) {
          const callArguments = statement.value.kind === "initializer_list" ? statement.value.expressions : statement.value.callArguments;
          if (!emitConstruct(context, context.retAddr, context.retType, callArguments)) {
            throw new Error("aggregate return initializer could not be constructed");
          }
        } else {
          throw new Error("aggregate return expression is not addressable");
        }
        emitScratchpadReleases(context, 0, false);
        context.lines.push(`    (return)`);
      } else if (statement.value && context.retIsAddr) {
        // Reference-returning compound operators commonly return their assignment
        // expression (`return *this += rhs`). Perform the write, then return the
        let addr: string | null;
        if (statement.value.kind === "assign") {
          emitAssign(context, statement.value);
          addr = emitAddress(context, statement.value.left);
        } else {
          addr = emitAddress(context, statement.value);
        }
        if (!addr) {
          context.codeGenerationContext.warn("reference return expression is not addressable", statement.span.line);
          context.lines.push("    (return (i32.const 0))");
          break;
        }
        const result = allocateTemporaryLocalName(context);
        context.lines.push(`    (local.set $${result} ${addr})`);
        emitScratchpadReleases(context, 0, false);
        context.lines.push(`    (return (local.get $${result}))`);
      } else if (statement.value && context.retIsValue) {
        // `return e` converts e to the declared return type (sub-64-bit returns truncate / sign-extend).
        const value = narrowCast(emitValue(context, statement.value), context.retTypeName);
        if (context.scratchpadScope?.length) {
          const result = allocateTemporaryLocalName(context);
          context.localVars.set(result, { wasmType: "i64" });
          context.lines.push(`    (local.set $${result} ${value})`);
          emitScratchpadReleases(context, 0, false);
          context.lines.push(`    (return (local.get $${result}))`);
        } else {
          context.lines.push(`    (return ${value})`);
        }
      } else {
        emitScratchpadReleases(context, 0, false);
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
        emitScratchpadReleases(context, target.scratchDepth, false);
        context.lines.push(`    (br ${target.label})`);
      } else context.codeGenerationContext.warn(`unsupported goto '${statement.label}'`, statement.span.line);
      break;
    }

    default:
      context.codeGenerationContext.warn(`unsupported statement '${statement.kind}'`, statement.span.line);
      break;
  }
}

// Emit an expression used as a statement (side effects only). Calls/assignments push their own
export function emitDiscardedExpression(context: FunctionEmissionContext, expression: Expression): string {
  if (expression.kind === "assign") return emitAssign(context, expression);
  if (expression.kind === "call") {
    emitCall(context, expression);
    return "";
  }
  if (expression.kind === "postfix_op" || expression.kind === "prefix_op") return emitIncrementOrDecrement(context, expression);
  // comma sequence (for-update `i++, flags >>= 2`): emit each side effect in order.
  if (expression.kind === "sequence") {
    for (const sequenceExpression of expression.expressions) {
      const discardedText = emitDiscardedExpression(context, sequenceExpression);
      if (discardedText) context.lines.push(`    ${discardedText}`);
    }
    return "";
  }
  return "";
}

// A name held in a wasm local slot: a body-declared local OR a scalar (by-value) parameter. Both are
export function isScalarLocal(context: FunctionEmissionContext, name: string): boolean {
  if (context.localVars.has(name)) return true;
  const type = context.params?.get(name);
  return !!type && !type.isAddr;
}

export function emitIncrementOrDecrement(context: FunctionEmissionContext, expression: Expression): string {
  const argument = expression.kind === "postfix_op" || expression.kind === "prefix_op" ? expression.argument : expression;
  const operator = (expression as any).operator === "++" ? "i64.add" : "i64.sub";
  // A scalar local/value-param increments in place via local.set, narrowed back to its declared width so overflow wraps like
  if (argument.kind === "identifier" && isScalarLocal(context, argument.name)) {
    const next = watIr.operation(operator, watIr.localGet(argument.name, "i64"), watIr.i64Constant(1));
    return `(local.set $${argument.name} ${watIr.serializeWatNode(narrowLocalValue(context, argument.name, next))})`;
  }
  // Otherwise a member/element lvalue: load, adjust, store back.
  const addr = resolveLvalue(context, argument);
  if (addr) {
    // uint128 increment/decrement uses the source-compiled arithmetic operator.
    if (isUint128(context.codeGenerationContext, addr.type ?? null)) {
      if ((expression as any).operator === "++") {
        const type = { kind: "template_instance", name: "uint128_t", callArguments: [] } as TypeSpec & {
          kind: "template_instance";
        };
        const compiled = callCompiled(context, type, "operator++", addr.addr, []);
        if (!compiled || compiled.cm.retKind !== "i32") {
          throw new Error("authoritative uint128_t::operator++ could not be lowered");
        }
        return watIr.serializeWatNode(
          watIr.operation(
            "drop",
            watIr.functionCallWithSignature({ params: ["i32"], res: "i32" }, compiled.cm.label, addrIr(addr.addr)),
          ),
        );
      }
      const one: Expression = { kind: "int_literal", value: "1", span: (expression as any).span };
      const res = lowerUint128Expression(context, {
        kind: "binary_op",
        operator: operator === "i64.add" ? "+" : "-",
        left: argument,
        right: one,
        span: (expression as any).span,
      });
      return watIr.serializeWatNode(watIr.functionCall("$copyMem", addrIr(addr.addr), res, watIr.i32Constant(16)));
    }
    const load = emitScalarLoad(addr.addr, addr.size, isSignedScalarType(addr.type, context.codeGenerationContext));
    const stored = `(${operator} ${load} (i64.const 1))`;
    return emitScalarStore(addr.addr, addr.size, stored);
  }
  return "";
}
