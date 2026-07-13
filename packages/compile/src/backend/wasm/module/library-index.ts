import { ProgramAnalysis } from "../../../analysis/program-analysis";
import { ClassTemplate, CompiledHelperMetadata, NamespaceLookupContext } from "../types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl } from "../../../ast";
import type { Sema } from "../../../sema";
import { type QpiContextLayout } from "../../../framework";
import type { LhostAbiSpec } from "../../../lhost";
import { registerCallSig } from "../../../wat-ir";
import type { LiteAbiSource } from "@qinit/core/lite-abi-source";
// ---- entry point ----
export interface LibrarySymbolIndex {
    templates: Map<string, ClassTemplate>;
    specializations: Map<string, {
        specArgs: TypeSpec[];
        templateDeclaration: ClassTemplate;
    }[]>;
    libFns: Map<string, FunctionDecl>;
    libFnOverloads: Map<string, FunctionDecl[]>;
    libFnTemplates: Map<string, FunctionTemplateDecl[]>;
    globalStructs: Map<string, StructDecl>;
    typedefs: Map<string, TypeSpec>;
    constexprInit: Map<string, Expression>;
    constexprType: Map<string, TypeSpec>;
    enumConst: Map<string, bigint>;
    enumSize: Map<string, number>;
    enumUnderlying: Map<string, TypeSpec>;
    enumConstType: Map<string, TypeSpec>;
    enumNames: Set<string>;
    templateMethods: Map<string, Map<string, FunctionTemplateDecl>>;
    namespaceUsings: Map<string, string[]>;
    namespaceContexts: Map<object, NamespaceLookupContext>;
    importedFunctions: Map<string, FunctionDecl>;
    liteAbi?: LiteAbiSource;
}
export interface GeneratedContractMetadata {
    stateSize: number;
    entries: Array<{
        name: string;
        inputType: number;
        kind: number;
        inSize: number;
        outSize: number;
    }>;
    sysprocMask: number;
    lhostAbi?: LhostAbiSpec;
}
export function registerLibraryMetadata(programAnalysis: ProgramAnalysis, libraryTypes: LibrarySymbolIndex): LhostAbiSpec {
    if (libraryTypes.liteAbi)
        programAnalysis.assetEnumerationRecord = libraryTypes.liteAbi.records.LiteAssetEntry;
    for (const [templateName, templateDeclaration] of libraryTypes.templates)
        programAnalysis.templates.set(templateName, templateDeclaration);
    for (const [templateName, templateSpecializations] of libraryTypes.specializations)
        programAnalysis.specializations.set(templateName, [...templateSpecializations]);
    for (const [functionName, functionDeclaration] of libraryTypes.libFns)
        programAnalysis.libFns.set(functionName, functionDeclaration);
    for (const [functionName, overloads] of libraryTypes.libFnOverloads)
        programAnalysis.libFnOverloads.set(functionName, [...overloads]);
    for (const [templateName, templateDecl] of libraryTypes.libFnTemplates)
        programAnalysis.libFnTemplates.set(templateName, templateDecl);
    for (const [structName, structDeclaration] of libraryTypes.globalStructs)
        programAnalysis.globalStructs.set(structName, structDeclaration);
    for (const [typeName, typeDeclaration] of libraryTypes.typedefs)
        programAnalysis.typedefs.set(typeName, typeDeclaration);
    for (const [typeName, expression] of libraryTypes.constexprInit)
        programAnalysis.constexprInit.set(typeName, expression);
    for (const [typeName, typeSpec] of libraryTypes.constexprType)
        programAnalysis.constexprType.set(typeName, typeSpec);
    for (const [enumName, enumValue] of libraryTypes.enumConst)
        programAnalysis.enumConst.set(enumName, enumValue);
    for (const [typeName, enumStorageSize] of libraryTypes.enumSize)
        programAnalysis.enumSize.set(typeName, enumStorageSize);
    for (const [typeName, enumUnderlyingType] of libraryTypes.enumUnderlying)
        programAnalysis.enumUnderlying.set(typeName, enumUnderlyingType);
    for (const [typeName, enumValueType] of libraryTypes.enumConstType)
        programAnalysis.enumConstType.set(typeName, enumValueType);
    for (const enumName of libraryTypes.enumNames)
        programAnalysis.enumNames.add(enumName);
    for (const [className, methodsByName] of libraryTypes.templateMethods)
        programAnalysis.templateMethods.set(className, new Map(methodsByName));
    for (const [scope, namespaces] of libraryTypes.namespaceUsings)
        programAnalysis.namespaceUsings.set(scope, [...namespaces]);
    for (const [declaration, namespaceContext] of libraryTypes.namespaceContexts)
        programAnalysis.namespaceContexts.set(declaration, namespaceContext);
    const lhostAbi: Record<string, {
        params: readonly ("i32" | "i64")[];
        results: readonly ("i32" | "i64")[];
    }> = {};
    for (const [name, fn] of libraryTypes.importedFunctions) {
        const params = fn.params.map((param) => {
            const declared = programAnalysis.derefType(param.type);
            const isAddr = param.type.kind === "reference" ||
                param.type.kind === "pointer" ||
                programAnalysis.isAggregateType(declared);
            const width = isAddr ? 4 : programAnalysis.sizeOfType(declared);
            if (!isAddr && width !== 1 && width !== 2 && width !== 4 && width !== 8) {
                throw new Error(`unsupported imported parameter '${name}.${param.name}' width ${width}`);
            }
            return {
                name: param.name,
                wasmType: (isAddr || width < 8 ? "i32" : "i64") as "i32" | "i64",
                isAddr,
                type: declared,
            };
        });
        const returnType = programAnalysis.derefType(fn.returnType);
        const returnAggregate = !programAnalysis.isVoidType(returnType) && programAnalysis.isAggregateType(returnType);
        if (returnAggregate)
            throw new Error(`imported function '${name}' has an aggregate return; declare its hidden output address explicitly`);
        const returnWidth = programAnalysis.isVoidType(returnType) ? 0 : programAnalysis.sizeOfType(returnType);
        if (returnWidth !== 0 &&
            returnWidth !== 1 &&
            returnWidth !== 2 &&
            returnWidth !== 4 &&
            returnWidth !== 8) {
            throw new Error(`unsupported imported return '${name}' width ${returnWidth}`);
        }
        const helper: CompiledHelperMetadata = {
            label: `$lh_${name.slice("__lhost_".length)}`,
            params,
            retIsValue: returnWidth !== 0,
            retWasmType: returnWidth === 0 ? undefined : returnWidth < 8 ? "i32" : "i64",
            retType: returnType,
        };
        programAnalysis.helpers.set(name, helper);
        const importName = name.slice("__lhost_".length);
        const abiParams = params.map((param) => param.wasmType);
        const results = helper.retWasmType ? [helper.retWasmType] : [];
        lhostAbi[importName] = { params: abiParams, results };
        registerCallSig(helper.label, { params: abiParams, res: helper.retWasmType ?? "void" });
    }
    for (const row of libraryTypes.liteAbi?.lhost ?? []) {
        const derived = lhostAbi[row.name];
        if (!derived ||
            derived.params.join(",") !== row.params.join(",") ||
            derived.results.join(",") !== row.results.join(",")) {
            throw new Error(`LH_IMPORT declaration for '${row.name}' does not match canonical core ABI metadata`);
        }
    }
    return lhostAbi;
}
export function contextLayoutFromCodegen(programAnalysis: ProgramAnalysis): QpiContextLayout {
    const context = programAnalysis.globalStructs.get("QpiContext");
    if (!context)
        throw new Error("qpi.h is missing QpiContext");
    const bufferSize = programAnalysis.constexprInit.get("__qinit_qpi_context_buffer_size");
    if (!bufferSize)
        throw new Error("assembled core headers are missing the Wasm QpiContext buffer capacity");
    const layout = programAnalysis.layoutOf(context);
    const offset = (name: string): number => {
        const field = layout.fields.get(name);
        if (!field)
            throw new Error(`QpiContext is missing field '${name}'`);
        return field.offset;
    };
    return {
        size: programAnalysis.evalConst(bufferSize),
        contractIndex: offset("_currentContractIndex"),
        originator: offset("_originator"),
        invocator: offset("_invocator"),
        invocationReward: offset("_invocationReward"),
    };
}
export function deriveQpiContextLayout(libraryTypes: LibrarySymbolIndex): QpiContextLayout {
    const programAnalysis = new ProgramAnalysis({} as Sema);
    registerLibraryMetadata(programAnalysis, libraryTypes);
    return contextLayoutFromCodegen(programAnalysis);
}
// Parse-once: collect the qpi.h library type table (templates/structs/typedefs/constants/methods).
export function indexLibraryDeclarations(declarations: Declaration[], inheritedNamespaceUsings?: Map<string, string[]>): LibrarySymbolIndex {
    const programAnalysis = new ProgramAnalysis({} as Sema);
    if (inheritedNamespaceUsings) {
        for (const [scope, namespaces] of inheritedNamespaceUsings)
            programAnalysis.namespaceUsings.set(scope, [...namespaces]);
    }
    programAnalysis.registerTopLevelDeclarations(declarations);
    const importedFunctions = new Map<string, FunctionDecl>();
    const collectHostImportDeclarations = (items: Declaration[]): void => {
        for (const declaration of items) {
            if (declaration.kind === "extern_block" || declaration.kind === "namespace") {
                collectHostImportDeclarations((declaration as any).body);
            }
            else if (declaration.kind === "function" &&
                declaration.name.startsWith("__lhost_") &&
                !declaration.body) {
                importedFunctions.set(declaration.name, declaration);
            }
        }
    };
    collectHostImportDeclarations(declarations);
    return {
        templates: programAnalysis.templates,
        specializations: programAnalysis.specializations,
        libFns: programAnalysis.libFns,
        libFnOverloads: programAnalysis.libFnOverloads,
        libFnTemplates: programAnalysis.libFnTemplates,
        globalStructs: programAnalysis.globalStructs,
        typedefs: programAnalysis.typedefs,
        constexprInit: programAnalysis.constexprInit,
        constexprType: programAnalysis.constexprType,
        enumConst: programAnalysis.enumConst,
        enumSize: programAnalysis.enumSize,
        enumUnderlying: programAnalysis.enumUnderlying,
        enumConstType: programAnalysis.enumConstType,
        enumNames: programAnalysis.enumNames,
        templateMethods: programAnalysis.templateMethods,
        namespaceUsings: programAnalysis.namespaceUsings,
        namespaceContexts: programAnalysis.namespaceContexts,
        importedFunctions,
        liteAbi: undefined,
    };
}
