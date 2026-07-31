import {
    AstKind,
    QpiContextKind,
    WatNodeType,
    type WatValueType,
} from "../../../enums";
import { getFunctionLoweringServices } from "./function-lowering-registry";
import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { FunctionEmissionContext, StructLayout, CompiledHelperMetadata, TemplateBindings, EMPTY_TEMPLATE_BINDINGS } from "../types";
import type { TypeSpec, Expression, Statement, FunctionDecl } from "../../../ast";
import * as watIr from "../../../wat-ir";
export function emitArrayInitializer(context: FunctionEmissionContext, base: watIr.WatNode, type: TypeSpec & {
    kind: AstKind.ARRAY;
}, initializer: Expression & {
    kind: AstKind.INITIALIZER_LIST;
}): void {
    const templateBindings = context.thisBind ?? EMPTY_TEMPLATE_BINDINGS;
    const elemSize = context.programAnalysis.sizeOfType(type.element, templateBindings);
    initializer.expressions.forEach((expression, index) => {
        const dst = watIr.addressWithOffset(base, index * elemSize);
        if (type.element.kind === AstKind.ARRAY && expression.kind === AstKind.INITIALIZER_LIST) {
            emitArrayInitializer(context, dst, type.element, expression);
        }
        else if (context.programAnalysis.isAggregateType(type.element) &&
            (expression.kind === AstKind.INITIALIZER_LIST || expression.kind === AstKind.CONSTRUCT)) {
            const callArguments = expression.kind === AstKind.INITIALIZER_LIST ? expression.expressions : expression.callArguments;
            context.lowering.emitConstruct(context, watIr.serializeWatNode(dst), type.element, callArguments);
        }
        else {
            context.lines.push(`    ${watIr.serializeWatNode(watIr.storeScalar(dst, elemSize, context.lowering.lowerValueExpression(context, expression)))}`);
        }
    });
}
// ---- function body codegen ----
// A scratch i32 local (holds an address). Declared lazily; emitted in the function's local list.
export function allocateTemporaryLocalName(context: FunctionEmissionContext): string {
    let temporaryName: string;
    do
        temporaryName = `__qinit_tmp${context.tmpCount++}`;
    while (context.localVars.has(temporaryName) || context.params?.has(temporaryName));
    context.localVars.set(temporaryName, { wasmType: WatNodeType.I32 });
    return temporaryName;
}
export function emitFunction(programAnalysis: ProgramAnalysis, label: string, fn: FunctionDecl | null, state: StructLayout, inL: StructLayout, outL: StructLayout, localsL: StructLayout, paramAliases?: Map<string, {
    wasmType: WatValueType;
    isAddr: boolean;
    type: TypeSpec;
    local?: string;
}>): string {
    const contextType = fn?.params[0] ? programAnalysis.derefType(fn.params[0].type) : null;
    const qpiContext = contextType?.kind === AstKind.NAME && contextType.name === "QpiContextProcedureCall"
        ? QpiContextKind.PROCEDURE
        : contextType?.kind === AstKind.NAME && contextType.name === "QpiContextFunctionCall"
            ? QpiContextKind.FUNCTION
            : undefined;
    const params = new Map(paramAliases ?? []);
    if (fn?.params[0]?.name === "qpi" && contextType && qpiContext) {
        params.set("qpi", { wasmType: WatNodeType.I32, isAddr: true, type: contextType, local: "__qinit_ctx" });
    }
    const lookup = programAnalysis.namespaceContextOf(fn);
    const context: FunctionEmissionContext = {
        programAnalysis,
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
        lowering: getFunctionLoweringServices()
    };
    // Pre-scan for local variable declarations (must be declared at function top in WAT)
    if (fn?.body)
        context.lowering.collectFunctionLocals(fn.body, context);
    const header = `  (func ${label} (param $__qinit_ctx i32) (param $__qinit_state i32) (param $__qinit_in i32) (param $__qinit_out i32) (param $__qinit_locals i32)`;
    if (fn?.body) {
        context.lowering.emitStatement(context, fn.body);
    }
    // Build local decls AFTER emit so scratch temps created during lowering are included.
    const localDecls = [...context.localVars.entries()].map(([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`);
    return [header, ...localDecls, ...context.lines, "  )"].join("\n");
}
// Emit a helper with its own scalar and address parameters.
export function emitHelperFunction(programAnalysis: ProgramAnalysis, info: CompiledHelperMetadata, fn: {
    body?: Statement;
}, stateLayout: StructLayout, bind?: TemplateBindings): string {
    const empty = { size: 0, align: 1, fields: new Map() };
    const context: FunctionEmissionContext = {
        programAnalysis,
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
        retTypeName: info.retType?.kind === AstKind.NAME ? info.retType.name : undefined,
        // For an instantiated template free fn the body resolves T/L through these bindings (e.g. `L`→4).
        thisBind: bind,
        sourceNamespace: info.sourceNamespace,
        usingNamespaces: info.usingNamespaces,
        lowering: getFunctionLoweringServices()
    };
    // An aggregate-returning helper (`id liquidityPov(...)`) gets a leading $ret destination-address param; `return e` copies the 32/N-byte value there.
    if (info.retAgg) {
        context.retAddr = "(local.get $__qinit_ret)";
        context.retAggSize = info.retAgg;
        context.retType = info.retType;
    }
    for (const parameter of info.params)
        context.params!.set(parameter.name, { wasmType: parameter.wasmType, isAddr: parameter.isAddr, type: parameter.type });
    if (fn.body)
        context.lowering.collectFunctionLocals(fn.body, context);
    // By-value aggregate params: bind the name to a private copy, so callee writes stay local (C++ value semantics).
    for (const parameterCandidate of info.params) {
        if (!parameterCandidate.byValAgg)
            continue;
        const size = programAnalysis.sizeOfType(parameterCandidate.type, bind ?? EMPTY_TEMPLATE_BINDINGS);
        if (!(size > 0))
            continue;
        let cp = `__qinit_bv_${parameterCandidate.name}`;
        while (context.localVars.has(cp) || context.params?.has(cp))
            cp += "_";
        context.localVars.set(cp, { wasmType: WatNodeType.I32 });
        context.lines.push(`    ${context.lowering.setLocal(context, cp, watIr.functionCall("$qpiAllocLocals", watIr.i32Constant(size)))}`);
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", watIr.localGet(cp, WatNodeType.I32), watIr.localGet(parameterCandidate.name, WatNodeType.I32), watIr.i32Constant(size)))}`);
        context.params!.get(parameterCandidate.name)!.local = cp;
    }
    const retParam = info.retAgg ? "(param $__qinit_ret i32) " : "";
    const paramDecls = info.params.map((parameter) => `(param $${parameter.name} ${parameter.wasmType})`).join(" ");
    const result = info.retIsValue ? " (result i64)" : "";
    const header = `  (func ${info.label} ${retParam}${paramDecls}${result}`.replace(/\s+\)/, ")");
    if (fn.body)
        context.lowering.emitStatement(context, fn.body);
    const localDecls = [...context.localVars.entries()].map(([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`);
    // A value helper needs a fallthrough result for control paths that do not hit a return.
    const tail = info.retIsValue ? ["    (i64.const 0)"] : [];
    return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}
