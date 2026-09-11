import { AssetSelectTypeName, AstKind, ContainerEmissionMode, WatNodeType, type WatValueType } from "../../../shared/enums";
import { getFunctionLoweringServices } from "../functions/function-lowering-registry";
import { emitScalarLoad, addrIr, isSignedScalarType } from "../memory/memory-operations";
import { TemplateBindings, CompiledMethod, FieldLayout, FunctionEmissionContext, EMPTY_TEMPLATE_BINDINGS } from "../types";
import { ProgramAnalysis } from "../../../semantics/program-analysis";
import { firstInfidelitySince } from "../../../semantics/analysis-diagnostics";
import type { TypeSpec, Expression, FunctionTemplateDecl, ParamDecl } from "../../../ast";
import * as watIr from "../wat-ir";
import { CONVERSION_RANK, conversionRank, integerLiteralType } from "./overload-ranking";
import { parsedAggregateLayout } from "./qpi";
// Compiling instantiated container methods from the real qpi.h bodies: references and aggregates pass by address (i32), scalars by value (i64).
export function classifyMethodParam(
    programAnalysis: ProgramAnalysis,
    parameter: ParamDecl,
    bind: TemplateBindings,
): {
    name: string;
    wasmType: WatValueType;
    isAddr: boolean;
    type: TypeSpec;
    concreteType: TypeSpec;
    defaultValue?: Expression;
    readOnlyRef?: boolean;
} {
    const type = parameter.type;
    const isPtrOrRef = type.kind === AstKind.REFERENCE || type.kind === AstKind.POINTER;
    const readOnlyRef = type.kind === AstKind.REFERENCE && type.referentType.kind === AstKind.CONST;
    const deref = programAnalysis.derefType(type);
    const concrete = programAnalysis.substInBindings(deref, bind);
    const isAddr = isPtrOrRef || programAnalysis.isAggregateType(concrete);
    return {
        name: parameter.name,
        wasmType: isAddr ? WatNodeType.I32 : WatNodeType.I64,
        isAddr,
        type: type,
        concreteType: concrete,
        defaultValue: parameter.defaultValue,
        readOnlyRef,
    };
}
// Compile or reuse a source-backed container method.
export function compileContainerMethod(
    programAnalysis: ProgramAnalysis,
    type: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    methodName: string,
    methodArgumentCount?: number,
    parameterTypeDiscriminator?: string,
    resolveMethodArgumentTypes?: () => Array<TypeSpec | null>,
    explicitTemplateArgs: TypeSpec[] = [],
): CompiledMethod | null {
    const explicitTemplateKey = explicitTemplateArgs.map((argument) => programAnalysis.typeKeyOf(argument)).join(",");
    const baseInstanceKey = methodTypeKey(type, programAnalysis);
    const explicitTemplateSuffix = explicitTemplateKey ? `<${explicitTemplateKey}>` : "";
    const baseCacheKey = `${baseInstanceKey}::${methodName}/${methodArgumentCount ?? "?"}${parameterTypeDiscriminator ? `@${parameterTypeDiscriminator}` : ""}${explicitTemplateSuffix}`;
    const cachedTemplateMethod = programAnalysis.compiledMethods.get(baseCacheKey);
    if (cachedTemplateMethod) return cachedTemplateMethod;
    // Specialization-aware: body + bindings come from matched template instance (primary or partial specialization)
    const resolvedMethod = programAnalysis.resolveSourceMethodDefinition(
        type.name,
        type.callArguments,
        methodName,
        methodArgumentCount,
        parameterTypeDiscriminator,
    );
    if (!resolvedMethod || !resolvedMethod.definition.body) return null;
    const definition = resolvedMethod.definition;
    const resolvedMethodArgumentTypes = resolvedMethod.requiresMethodTemplateInference ? (resolveMethodArgumentTypes?.() ?? []) : [];
    const methodTemplateTypeKey = resolvedMethod.requiresMethodTemplateInference
        ? resolvedMethodArgumentTypes.map((argumentType) => (argumentType ? programAnalysis.typeKeyOf(argumentType) : "?")).join(",")
        : "";
    const cacheKey = `${baseCacheKey}${methodTemplateTypeKey ? `#${methodTemplateTypeKey}` : ""}`;
    const cached = programAnalysis.compiledMethods.get(cacheKey);
    if (cached) return cached;
    let ownerBindings = resolvedMethod.ownerBindings;
    // Type parameters the call spelled out. By name rather than `types.has`, which is also true for the
    // enclosing class's bindings — a method parameter shadowing one would then never deduce.
    const explicitlyBoundTypeParams = new Set<string>();
    if (explicitTemplateArgs.length) {
        const types = new Map(ownerBindings.types);
        const values = new Map(ownerBindings.values);
        definition.params.forEach((parameter, index) => {
            const argument = explicitTemplateArgs[index];
            if (!argument) return;
            if (parameter.kind === AstKind.TYPE) {
                types.set(parameter.name, argument);
                explicitlyBoundTypeParams.add(parameter.name);
            } else values.set(parameter.name, programAnalysis.valueOfTypeArg(argument, ownerBindings));
        });
        ownerBindings = { ...ownerBindings, types, values };
    }
    // Infer member-template types structurally from concrete call arguments instead of assigning semantics to specific method names.
    if (resolvedMethod.requiresMethodTemplateInference && definition.params.some((param) => param.kind === AstKind.TYPE)) {
        const types = new Map(ownerBindings.types);
        const templateTypeNames = new Set(definition.params.filter((param) => param.kind === AstKind.TYPE).map((param) => param.name));
        for (let index = 0; index < (definition.functionParameters ?? []).length; index++) {
            const declared = programAnalysis.derefType(definition.functionParameters![index].type);
            const actual = resolvedMethodArgumentTypes[index];
            // An explicitly supplied template argument is not a deduction candidate: `twice<uint8>(200)`
            // means uint8 whatever the literal's own type is.
            if (declared.kind === AstKind.NAME && templateTypeNames.has(declared.name) && actual && !explicitlyBoundTypeParams.has(declared.name)) {
                types.set(declared.name, actual);
            }
        }
        ownerBindings = { ...ownerBindings, types };
    }
    const functionParameters = (definition.functionParameters ?? []).map((parameter) => classifyMethodParam(programAnalysis, parameter, ownerBindings));
    const retType = programAnalysis.substInBindings(programAnalysis.derefType(definition.returnType), ownerBindings);
    const returnsAddr = definition.returnType.kind === AstKind.REFERENCE || definition.returnType.kind === AstKind.POINTER;
    const returnsAggregate = !returnsAddr && !programAnalysis.isVoidType(definition.returnType) && programAnalysis.isAggregateType(retType);
    const retKind: WatNodeType = returnsAddr
        ? WatNodeType.I32
        : programAnalysis.isVoidType(definition.returnType) || returnsAggregate
          ? WatNodeType.VOID
          : WatNodeType.I64;
    const retAgg = returnsAggregate ? programAnalysis.sizeOfType(retType, ownerBindings) : undefined;
    const safeMethodName = methodName.replace(/[^a-zA-Z0-9_]/g, "_");
    const cm: CompiledMethod = {
        label: `$T${programAnalysis.compiledMethods.size}_${type.name}_${safeMethodName}`,
        functionParameters,
        retKind,
        retAgg,
        retType,
    };
    programAnalysis.compiledMethods.set(cacheKey, cm); // register before emitting so recursive/sibling calls resolve
    try {
        const warningBase = programAnalysis.warnings.length;
        const errorBase = programAnalysis.errors.length;
        const wat = emitTemplateMethod(programAnalysis, cm, definition, type, ownerBindings);
        const diagnostic = firstInfidelitySince(programAnalysis, warningBase, errorBase);
        if (diagnostic) {
            throw new Error(`authoritative body emitted a diagnostic: ${diagnostic}`);
        }
        programAnalysis.emittedMethodOrder.push(wat);
    } catch (entry: any) {
        programAnalysis.warn(`failed to compile ${cacheKey}: ${entry.message}`, definition.span?.line ?? 0);
        programAnalysis.compiledMethods.delete(cacheKey);
        // A selected authoritative body must compile; never fall back to handwritten lowering.
        throw entry;
    }
    return cm;
}
function methodTypeKey(
    type: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    context: ProgramAnalysis,
): string {
    const argumentKeys = type.callArguments.map((argument) => context.typeKeyOf(argument)).join(",");
    // A plain class carries its declaration's id: without it two classes spelled alike share one instantiation, and whichever compiled first answers for both.
    const declaration = type.callArguments.length === 0 ? context.structByName(type.name, EMPTY_TEMPLATE_BINDINGS) : undefined;
    const identity = declaration ? `#${context.declarationId(declaration)}` : "";
    return `${type.name}${identity}<${argumentKeys}>`;
}
// Emit an instantiated method with `$this`, concrete parameters, and its body.
export function emitTemplateMethod(
    programAnalysis: ProgramAnalysis,
    cm: CompiledMethod,
    def: FunctionTemplateDecl,
    type: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    bind: TemplateBindings,
): string {
    const thisLayout = programAnalysis.containerLayout(type.name, type.callArguments);
    const empty = { size: 0, align: 1, fields: new Map<string, FieldLayout>() };
    const lookup = programAnalysis.namespaceContextOf(def);
    const context: FunctionEmissionContext = {
        programAnalysis,
        state: empty,
        in: empty,
        out: empty,
        locals: empty,
        localVars: new Map(),
        lines: [],
        tmpCount: 0,
        loops: [],
        loopCount: 0,
        params: new Map(),
        retIsValue: cm.retKind === WatNodeType.I64,
        retIsAddr: cm.retKind === WatNodeType.I32,
        // `return e` converts e to the declared return type, which is the instantiated one, so a method returning T narrows to whatever T became.
        retTypeName: cm.retType?.kind === AstKind.NAME ? cm.retType.name : undefined,
        thisLayout,
        thisType: type,
        thisBind: bind,
        staticConsts: programAnalysis.staticConstsOf(type.name, bind),
        sourceNamespace: lookup.sourceNamespace,
        usingNamespaces: lookup.usingNamespaces,
        lowering: getFunctionLoweringServices(),
    };
    if (cm.retAgg) {
        context.retAddr = "(local.get $__qinit_ret)";
        context.retAggSize = cm.retAgg;
        context.retType = cm.retType;
    }
    // Register concrete parameter types so scalar references load at the right width.
    for (const fnParam of cm.functionParameters)
        context.params!.set(fnParam.name, {
            wasmType: fnParam.wasmType,
            isAddr: fnParam.isAddr,
            type: fnParam.concreteType ?? programAnalysis.substInBindings(programAnalysis.derefType(fnParam.type), bind),
        });
    if (def.body) context.lowering.collectFunctionLocals(def.body, context);
    if (def.body) context.lowering.emitStatement(context, def.body);
    const retParam = cm.retAgg ? "(param $__qinit_ret i32) " : "";
    const paramDecls = cm.functionParameters.map((fnParam) => `(param $${fnParam.name} ${fnParam.wasmType})`).join(" ");
    const result = cm.retKind === WatNodeType.I64 ? " (result i64)" : cm.retKind === WatNodeType.I32 ? " (result i32)" : "";
    const header = `  (func ${cm.label} ${retParam}(param $this i32) ${paramDecls}${result}`.replace(/\s+\)/, ")");
    const localDecls = [...context.localVars.entries()].map(([localName, localMetadata]) => `    (local $${localName} ${localMetadata.wasmType})`);
    const tail = cm.retKind === WatNodeType.I64 ? ["    (i64.const 0)"] : cm.retKind === WatNodeType.I32 ? ["    (i32.const 0)"] : [];
    return [header, ...localDecls, ...context.lines, ...tail, "  )"].join("\n");
}
// The class an argument names in the source: `Type{...}` and `Type(args)` say what they build without being lowered, so an overload is picked before emission.
function syntacticArgumentType(context: FunctionEmissionContext, argument: Expression): TypeSpec | null {
    if (argument.kind === AstKind.CONSTRUCT) {
        return context.programAnalysis.derefType(argument.type);
    }

    if (argument.kind === AstKind.CALL && argument.callee.kind === AstKind.IDENTIFIER) {
        const named: TypeSpec = { kind: AstKind.NAME, name: argument.callee.name };
        if (context.programAnalysis.isAggregateType(named)) return named;
    }

    return null;
}

/** Tell same-arity overloads apart by their first parameter's type, as C++ does; only a class with more than one candidate pays to resolve the argument. */
function overloadDiscriminator(
    context: FunctionEmissionContext,
    type: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    method: string,
    callArguments: Expression[],
    bind: TemplateBindings,
): string | undefined {
    const declaration = context.programAnalysis.structByName(type.name, bind);
    const methods = declaration ? context.programAnalysis.methodsByDeclaration.get(declaration) : undefined;

    if (!methods || !callArguments[0]) {
        return undefined;
    }

    const prefix = `${method}/${callArguments.length}@`;
    const candidates = [...methods.keys()].filter((key) => key.startsWith(prefix));

    if (candidates.length < 2) {
        return undefined;
    }

    const argumentType = syntacticArgumentType(context, callArguments[0]) ?? context.lowering.resolveExpressionAddress(context, callArguments[0])?.type;

    if (argumentType) {
        const key = `${prefix}${context.programAnalysis.typeKey(context.programAnalysis.derefType(argumentType))}`;
        return methods.has(key) ? key.slice(prefix.length) : undefined;
    }

    // A literal has a type of its own, so the candidates can be ranked the way C++ ranks them.
    const literalType = integerLiteralType(callArguments[0]);

    if (!literalType) {
        return undefined;
    }

    const ranked = candidates
        .map((key) => {
            const parameter = methods.get(key)?.functionParameters?.[0];

            return {
                key,
                rank: parameter ? conversionRank(context.programAnalysis, literalType, parameter.type) : CONVERSION_RANK.none,
            };
        })
        .filter((candidate) => candidate.rank < CONVERSION_RANK.none)
        .sort((left, right) => left.rank - right.rank);

    if (!ranked.length) {
        return undefined;
    }

    if (ranked.length > 1 && ranked[0].rank === ranked[1].rank) {
        context.programAnalysis.error(`ambiguous call to ${type.name}::${method}`, callArguments[0].span);
        return undefined;
    }

    return ranked[0].key.slice(prefix.length);
}

/** The scalar type name for a width and signedness, as the usual arithmetic conversions give it. */
const SCALAR_TYPE_BY_SHAPE: Record<string, string> = {
    "1s": "sint8",
    "1u": "uint8",
    "2s": "sint16",
    "2u": "uint16",
    "4s": "sint32",
    "4u": "uint32",
    "8s": "sint64",
    "8u": "uint64",
    "16s": "uint128",
    "16u": "uint128",
};

/** The type a member template deduces `T` from for one argument. An rvalue has a type too, so a
 *  computed expression asks scalarTypeInfo rather than going unbound and making sizeof(T) 1. */
export function deduceMethodArgumentType(context: FunctionEmissionContext, argument: Expression): TypeSpec | null {
    const node = context.lowering.resolveExpressionAddress(context, argument);
    if (node?.type) return context.programAnalysis.derefType(node.type);
    if (argument.kind === AstKind.CONSTRUCT) return context.programAnalysis.derefType(argument.type);
    if (argument.kind === AstKind.CALL && argument.callee.kind === AstKind.IDENTIFIER) {
        const type: TypeSpec = { kind: AstKind.NAME, name: argument.callee.name };
        if (context.programAnalysis.isAggregateType(type)) return type;
    }
    // A call's declared return type is authoritative and has no width ceiling, where scalarTypeInfo
    // discards anything wider than 8 bytes and would leave `uint128` or `id` deducing nothing.
    if (argument.kind === AstKind.CALL) {
        const helper = context.lowering.lookupHelper(context, argument);
        if (helper?.retType) return context.programAnalysis.derefType(helper.retType);
    }
    const scalar = context.lowering.scalarTypeInfo(context, argument);
    const name = scalar ? SCALAR_TYPE_BY_SHAPE[`${scalar.width}${scalar.unsigned ? "u" : "s"}`] : undefined;
    return name ? { kind: AstKind.NAME, name } : null;
}

// Build a call using the compiled method's concrete parameter types.
export function callCompiled(
    context: FunctionEmissionContext,
    type: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    },
    method: string,
    self: string,
    callArguments: Expression[],
    parameterTypeDiscriminator?: string,
    explicitTemplateArgs: TypeSpec[] = [],
): {
    call: string;
    cm: CompiledMethod;
    retDest?: string;
} | null {
    const methodArgTypes = () => callArguments.map((argument) => deduceMethodArgumentType(context, argument));
    const bind = context.programAnalysis.bindContainer(type.name, type.callArguments);
    const discriminator = parameterTypeDiscriminator ?? overloadDiscriminator(context, type, method, callArguments, bind);
    const cm = compileContainerMethod(context.programAnalysis, type, method, callArguments.length, discriminator, methodArgTypes, explicitTemplateArgs);
    if (!cm) return null;
    const minimumArgs = cm.functionParameters.findIndex((parameter) => parameter.defaultValue !== undefined);
    const minimum = minimumArgs < 0 ? cm.functionParameters.length : minimumArgs;
    if (callArguments.length < minimum || callArguments.length > cm.functionParameters.length) {
        const expected = minimum === cm.functionParameters.length ? `${minimum}` : `${minimum}..${cm.functionParameters.length}`;
        throw new Error(`${type.name}::${method} expects ${expected} argument(s), got ${callArguments.length}`);
    }
    const methodArgumentOperands = cm.functionParameters.map((methodParameter, methodParameterIndex) => {
        const callArgument = callArguments[methodParameterIndex] ?? methodParameter.defaultValue;
        if (!callArgument) {
            throw new Error(`${type.name}::${method} is missing required argument ${methodParameterIndex + 1}`);
        }
        if (callArgument.kind === AstKind.NULLPTR_LITERAL) {
            return methodParameter.isAddr ? "(i32.const 0)" : "(i64.const 0)";
        }
        const paramType =
            methodParameter.concreteType ?? context.programAnalysis.substInBindings(context.programAnalysis.derefType(methodParameter.type), bind);
        if (!methodParameter.isAddr) return context.lowering.emitValue(context, callArgument);
        if (
            methodParameter.type.kind === AstKind.POINTER &&
            context.programAnalysis.isVoidType(methodParameter.type.pointee) &&
            !context.lowering.resolveExpressionAddress(context, callArgument)
        ) {
            return "(i32.const 0)";
        }
        if (context.programAnalysis.isAggregateType(paramType)) {
            if (callArgument.kind === AstKind.INITIALIZER_LIST) {
                return context.lowering.argAddr(
                    context,
                    callArgument,
                    context.programAnalysis.sizeOfType(paramType, bind),
                    paramType,
                    methodParameter.readOnlyRef === true,
                );
            }
            const direct = context.lowering.emitAddress(context, callArgument);
            if (direct) return direct;
            // An argument with no address converts through the parameter class's one-argument constructor; a class declaring none has no conversion in C++.
            const resolvedParam = context.programAnalysis.resolveType(paramType, bind);
            const paramOwner = resolvedParam.kind === AstKind.NAME || resolvedParam.kind === AstKind.TEMPLATE_INSTANCE ? resolvedParam.name : null;
            const singleArgument = paramOwner ? context.programAnalysis.templateMethods.get(paramOwner)?.get(`${paramOwner}/1`) : undefined;
            // A copy constructor takes one argument too and converts nothing: feeding it a scalar would send the same argument back for its own `const T&`.
            const convertsFromScalar =
                !!singleArgument &&
                !context.programAnalysis.isAggregateType(context.programAnalysis.derefType(singleArgument.functionParameters?.[0]?.type ?? paramType));
            if (convertsFromScalar) {
                return context.lowering.argAddr(
                    context,
                    callArgument,
                    context.programAnalysis.sizeOfType(paramType, bind),
                    paramType,
                    methodParameter.readOnlyRef === true,
                    true,
                );
            }
            throw new Error(`${type.name}::${method} aggregate argument ${methodParameterIndex + 1} is not addressable`);
        }
        return context.lowering.argAddr(
            context,
            callArgument,
            context.programAnalysis.sizeOfType(paramType, bind),
            paramType,
            methodParameter.readOnlyRef === true,
        );
    });
    let retDest = "";
    if (cm.retAgg) retDest = watIr.serializeWatNode(context.lowering.allocateScratchSlotNode(context, cm.retAgg));
    return {
        call: `(call ${cm.label}${retDest ? " " + retDest : ""} ${self}${methodArgumentOperands.length ? " " + methodArgumentOperands.join(" ") : ""})`,
        cm,
        ...(retDest ? { retDest } : {}),
    };
}
export function emitTemplateContainerCall(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.TEMPLATE_CALL;
    },
    valueWanted: boolean,
): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!node?.type) return null;
    let type: TypeSpec = node.type;
    if (type.kind === AstKind.NAME && (context.programAnalysis.globalStructs.has(type.name) || context.programAnalysis.templateMethods.has(type.name))) {
        type = { kind: AstKind.TEMPLATE_INSTANCE, name: type.name, callArguments: [] };
    }
    if (type.kind !== AstKind.TEMPLATE_INSTANCE) return null;
    const compiled = callCompiled(context, type, expression.callee.member, node.addr, expression.callArguments, undefined, expression.templateArguments ?? []);
    if (!compiled) return null;
    if (valueWanted) {
        if (compiled.retDest || compiled.cm.retKind === WatNodeType.VOID)
            throw new Error(`aggregate or void method ${type.name}::${expression.callee.member} used as a scalar`);
        if (compiled.cm.retKind === WatNodeType.I32)
            return emitScalarLoad(
                compiled.call,
                context.programAnalysis.sizeOfType(compiled.cm.retType!),
                isSignedScalarType(compiled.cm.retType!, context.programAnalysis),
            );
        return compiled.call;
    }
    context.lines.push(compiled.cm.retKind === WatNodeType.VOID ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
    return "";
}
// Lower a source-backed instance call and return its scalar value when requested.
export function emitContainerCall(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
    valueWanted: boolean,
): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    if (!node || !node.type) return null;
    // Resolve typedefs and bindings to the concrete container instance.
    let ct: TypeSpec | null = node.type;
    for (let index = 0; index < 8 && ct?.kind === AstKind.NAME; index++) {
        const next: TypeSpec | undefined = context.thisBind?.types.get(ct.name) ?? context.programAnalysis.typedefs.get(ct.name);
        if (!next) break;
        ct = next;
    }
    // Normalize plain inline structs to zero-argument instances.
    if (ct?.kind === AstKind.INLINE_STRUCT && ct.struct.name && context.programAnalysis.templateMethods.get(ct.struct.name)?.has(expression.callee.member)) {
        ct = {
            kind: AstKind.TEMPLATE_INSTANCE,
            name: ct.struct.name,
            callArguments: [],
        } as TypeSpec;
    }
    // A class is a class whether or not it declares methods: one inheriting all of them has no table entry, and the scoped resolver finds nested declarations.
    if (
        ct?.kind === AstKind.NAME &&
        (context.programAnalysis.globalStructs.has(ct.name) ||
            context.programAnalysis.templateMethods.has(ct.name) ||
            context.programAnalysis.structByName(ct.name, context.thisBind ?? EMPTY_TEMPLATE_BINDINGS))
    ) {
        ct = { kind: AstKind.TEMPLATE_INSTANCE, name: ct.name, callArguments: [] } as TypeSpec;
    }
    if (!ct || ct.kind !== AstKind.TEMPLATE_INSTANCE) return null;
    // Dispatch namespace-qualified container types by their base name.
    if (ct.name.includes("::") && !context.programAnalysis.templates.has(ct.name)) {
        ct = { ...ct, name: ct.name.slice(ct.name.lastIndexOf("::") + 2) };
    }
    node.type = ct;
    const map = node.addr;
    const member = expression.callee.member;
    // Route every captured instance method through source-backed instantiation.
    const compiled = callCompiled(context, node.type, member, map, expression.callArguments);
    if (!compiled) return null;
    if (valueWanted) {
        if (compiled.retDest) {
            context.lines.push(`    ${compiled.call}`);
            return `(i64.load ${compiled.retDest})`;
        }
        if (compiled.cm.retKind === WatNodeType.VOID) throw new Error(`void method ${node.type.name}::${member} used as a scalar`);
        if (compiled.cm.retKind === WatNodeType.I32) {
            if (!compiled.cm.retType || context.programAnalysis.isAggregateType(compiled.cm.retType)) {
                throw new Error(`aggregate reference ${node.type.name}::${member} used as a scalar`);
            }
            return emitScalarLoad(
                compiled.call,
                context.programAnalysis.sizeOfType(compiled.cm.retType, context.thisBind),
                isSignedScalarType(compiled.cm.retType, context.programAnalysis),
            );
        }
        return compiled.call;
    }
    context.lines.push(compiled.cm.retKind === WatNodeType.VOID ? `    ${compiled.call}` : `    (drop ${compiled.call})`);
    return "";
}
// The iterator's record accessors and the AssetEntry field each reads.
const ASSET_ITERATOR_RECORD_FIELDS: Record<string, string> = {
    owner: "owner",
    possessor: "possessor",
    numberOfOwnedShares: "shares",
    numberOfPossessedShares: "shares",
    ownershipManagingContract: "ownershipManagingContract",
    possessionManagingContract: "possessionManagingContract",
};

// Lower asset-iterator methods in statement, value, or address context. The object holds qpi.h's fields: begin()
// copies the asset and selects into it, and the host advances the universe indices in place, as the node's iterator does.
export function emitAssetIter(
    context: FunctionEmissionContext,
    expression: Expression & {
        kind: AstKind.CALL;
    },
    mode: ContainerEmissionMode,
): string | null {
    if (expression.callee.kind !== AstKind.MEMBER_ACCESS) return null;
    const node = context.lowering.resolveExpressionAddress(context, expression.callee.object);
    const tn = node?.type?.kind === AstKind.NAME ? (node.type as any).name : null;
    if (!node || (tn !== "AssetOwnershipIterator" && tn !== "AssetPossessionIterator")) return null;
    const method = expression.callee.member;
    const isPossession = tn === "AssetPossessionIterator";
    const kind = watIr.i32Constant(isPossession ? 1 : 0);
    const iterator = parsedAggregateLayout(context, tn);
    const asset = parsedAggregateLayout(context, "Asset");
    const it = context.lowering.allocateTemporaryLocalName(context);
    context.lines.push(`    ${context.lowering.setLocal(context, it, addrIr(node.addr))}`);
    const itN = watIr.localGet(it, WatNodeType.I32);
    const field = (name: string) => watIr.addressWithOffset(itN, iterator.field(name));
    const indexValue = (name: string) => watIr.rawLoad("i32.load", null, field(name));
    // The ownership iterator has no possession select or index: the host reads the ownership select twice and skips the index.
    const possessionSelect = isPossession ? field("_possession") : field("_ownership");
    const possessionIndex = isPossession ? field("_possessionIdx") : watIr.i32Constant(0);
    const walkArguments = [kind, field("_issuance"), field("_ownership"), possessionSelect, field("_issuanceIdx"), field("_ownershipIdx"), possessionIndex];
    if (method === "begin") {
        // begin(asset, ownershipSelect [, possessionSelect]); an absent select is `undefined`, which materializeSelect renders as any().
        const copyInto = (destination: watIr.WatNode, source: watIr.WatNode, size: number) =>
            context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$copyMem", destination, source, watIr.i32Constant(size)))}`);
        const assetAddress = context.lowering.materializeAssetAddress(context, expression.callArguments[0], `${tn}.begin`);
        copyInto(field("_issuance"), addrIr(assetAddress), asset.layout.size);
        const ownershipSelect = context.lowering.materializeSelect(context, expression.callArguments[1], AssetSelectTypeName.OWNERSHIP);
        copyInto(field("_ownership"), ownershipSelect, parsedAggregateLayout(context, AssetSelectTypeName.OWNERSHIP).layout.size);
        if (isPossession) {
            const possessionSelectValue = context.lowering.materializeSelect(context, expression.callArguments[2], AssetSelectTypeName.POSSESSION);
            copyInto(field("_possession"), possessionSelectValue, parsedAggregateLayout(context, AssetSelectTypeName.POSSESSION).layout.size);
        }
        context.lines.push(`    ${watIr.serializeWatNode(watIr.functionCall("$lh_assetIterBegin", ...walkArguments))}`);
        return "";
    }
    if (method === "next") {
        const step = watIr.functionCall("$lh_assetIterNext", ...walkArguments);
        if (mode === ContainerEmissionMode.VALUE) return `(i64.extend_i32_u ${watIr.serializeWatNode(step)})`;
        context.lines.push(`    (drop ${watIr.serializeWatNode(step)})`);
        return "";
    }
    if (method === "reachedEnd") {
        const endIndex = indexValue(isPossession ? "_possessionIdx" : "_ownershipIdx");
        return `(i64.extend_i32_u (i32.eq ${watIr.serializeWatNode(endIndex)} (i32.const -1)))`;
    }
    if (method === "issuer") {
        const issuer = watIr.serializeWatNode(watIr.addressWithOffset(itN, iterator.field("_issuance") + asset.field("issuer")));
        return mode === ContainerEmissionMode.ADDRESS ? issuer : `(i64.load ${issuer})`;
    }
    if (method === "assetName") {
        return `(i64.load ${watIr.serializeWatNode(watIr.addressWithOffset(itN, iterator.field("_issuance") + asset.field("assetName")))})`;
    }
    const recordField = ASSET_ITERATOR_RECORD_FIELDS[method];
    if (!recordField) return null;
    // The host writes the current record into the one-record scratch; the accessor reads its field straight after.
    const record = context.programAnalysis.assetEnumerationRecord;
    const scratch = watIr.rawWatNode("(global.get $assetRecordBuf)", WatNodeType.I32);
    const currentPossession = isPossession ? indexValue("_possessionIdx") : watIr.i32Constant(-1);
    context.lines.push(
        `    ${watIr.serializeWatNode(watIr.functionCall("$lh_assetIterRecord", kind, indexValue("_ownershipIdx"), currentPossession, scratch))}`,
    );
    const at = `(i32.add (global.get $assetRecordBuf) (i32.const ${record.fields[recordField].offset}))`;
    if (recordField === "owner" || recordField === "possessor") return mode === ContainerEmissionMode.ADDRESS ? at : `(i64.load ${at})`;
    if (recordField === "shares") return `(i64.load ${at})`;
    return `(i64.extend_i32_u (i32.load16_u ${at}))`;
}
