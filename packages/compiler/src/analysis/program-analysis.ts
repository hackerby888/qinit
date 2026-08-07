import { AstKind } from "../enums";
import { ClassTemplate, CompiledMethod, CompiledHelperMetadata, PrivateFunctionMetadata, ResolvedCalleeIdl, StructLayout, CodeGenerationWarning, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout, NamespaceLookupContext, ResolvedSourceMethod } from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, Span } from "../ast";
import type { SemanticAnalyzer } from "../semantic-analyzer";
import type { PlatformCapability } from "../shared/platform-capabilities";
import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import * as analysisPart0 from "./declaration-index";
import * as analysisPart1 from "./constant-evaluator";
import * as analysisPart2 from "./type-resolver";
import * as analysisPart3 from "./template-resolver";
import * as analysisPart4 from "./struct-layout";
import * as analysisPart5 from "./type-layout";
import * as analysisPart6 from "./struct-index";
import * as analysisPart7 from "./function-index";
import * as analysisPart8 from "./container-layout";
import * as analysisPart9 from "./analysis-diagnostics";

export class ProgramAnalysis {
    assetEnumerationRecord: {
        size: number;
        capacity: number;
        fields: Record<string, {
            offset: number;
            size: number;
        }>;
    } = ASSET_ENUMERATION_RECORD;
    sema: SemanticAnalyzer;
    nested: Map<string, StructDecl> = new Map(); // contract-local nested structs
    templates: Map<string, ClassTemplate> = new Map(); // qpi.h templates (HashMap, Array, ...)
    specializations: Map<string, {
        specArgs: TypeSpec[];
        templateDeclaration: ClassTemplate;
    }[]> = new Map(); // partial/explicit specializations keyed by template name
    globalStructs: Map<string, StructDecl> = new Map(); // qpi.h global/namespace structs
    typedefs: Map<string, TypeSpec> = new Map(); // typedef aliases
    constexprInit: Map<string, Expression> = new Map(); // named constexpr → its init expression
    constexprType: Map<string, TypeSpec> = new Map(); // named constexpr → declared scalar type
    enumConst: Map<string, bigint> = new Map(); // enum constant (NAME and Type::NAME) → value
    enumSize: Map<string, number> = new Map(); // enum type name → storage size from its underlying type (enum class X : uint8 → 1)
    enumUnderlying: Map<string, TypeSpec> = new Map(); // enum type name → declared underlying scalar type
    enumConstType: Map<string, TypeSpec> = new Map(); // enumerator name → its enum/underlying scalar type
    enumNames: Set<string> = new Set(); // every named enum type, for type-name resolution checks
    templateMethods: Map<string, Map<string, FunctionTemplateDecl>> = new Map(); // Class → method → out-of-class def
    compiledMethods: Map<string, CompiledMethod> = new Map(); // instantiation cache key → compiled method
    emittedMethodOrder: string[] = []; // emitted WAT, in emission order (appended to module)
    constCache: Map<string, bigint> = new Map();
    constInProgress = new Set<string>();
    helpers: Map<string, CompiledHelperMetadata> = new Map(); // value helpers: toReturnCode(...) etc.
    helperOverloads: Map<string, CompiledHelperMetadata[]> = new Map(); // member value helpers, ALL overloads per name in declaration order; call sites rank by argument signature
    libFns: Map<string, FunctionDecl> = new Map(); // qpi.h namespace free functions (ProposalTypes::cls), keyed by qualified name; compiled lazily
    libFnOverloads: Map<string, FunctionDecl[]> = new Map(); // all non-template overloads, in source order
    libFnTemplates: Map<string, FunctionTemplateDecl[]> = new Map(); // qpi.h namespace free function TEMPLATES (isArraySortedWithoutDuplicates<T,L>), all overloads kept, instantiated per call-site arg types
    namespaceUsings: Map<string, string[]> = new Map(); // namespace scope -> directives visible to later declarations in that scope
    namespaceContexts: Map<object, NamespaceLookupContext> = new Map(); // declaration -> namespace lookup state at its definition
    privates: Map<string, PrivateFunctionMetadata> = new Map(); // PRIVATE_FUNCTION/PROCEDURE called via CALL()
    registered: Map<string, PrivateFunctionMetadata> = new Map(); // REGISTER_USER_* function/procedure, also reachable via CALL() (same entry shape)
    callees: Map<string, ResolvedCalleeIdl> = new Map(); // other contracts callable via CALL_OTHER/INVOKE_OTHER (by state-type name)
    layoutCache: Map<string, StructLayout> = new Map();
    contractStateLayout: StructLayout = { size: 0, align: 1, fields: new Map() }; // the contract's StateData (a ContractState& param in any function resolves through it)
    slot = 0; // contract slot; oracle notification ids embed it ((slot << 22) | defLine)
    gtestMode = false; // test-runner module: enable qtest host intrinsics
    memberFnLine: Map<string, number> = new Map(); // contract member function name → raw-source definition line (__id_<proc> resolution)
    procedureDeclLines: Map<string, number> = new Map(); // procedure name → raw-source line of its PUBLIC/PRIVATE_PROCEDURE macro
    warnings: CodeGenerationWarning[] = [];
    errors: CodeGenerationWarning[] = [];
    capabilities: Set<PlatformCapability> = new Set();
    constructor(sema: SemanticAnalyzer) {
        this.sema = sema;
    }
    // ---- register declarations from the parsed TU into codegen lookup tables ----
    registerTopLevelDeclarations(declarations: Declaration[], nsPrefix = "", inheritedUsing: string[] = []): void {
        return analysisPart0.registerTopLevelDeclarations(this, declarations, nsPrefix, inheritedUsing);
    }
    captureMemberNamespaceContexts(members: Declaration[], context: NamespaceLookupContext): void {
        return analysisPart0.captureMemberNamespaceContexts(this, members, context);
    }
    namespaceContextOf(declaration?: object | null): NamespaceLookupContext {
        return analysisPart0.namespaceContextOf(this, declaration);
    }
    /**
     * Ordered lookup keys for a free helper / lib-fn call.
     * 1. exact qualified name
     * 2. lexical sourceNamespace variant (if available)
     * 3. active `using namespace` directives (declaration order)
     * 4. bare/unqualified name (global), only when name is unqualified
     * First hit wins; no hardcoded QPI:: fallback.
     */
    namespaceCandidates(name: string, sourceNamespace?: string, usingNamespaces: string[] = []): string[] {
        return analysisPart0.namespaceCandidates(this, name, sourceNamespace, usingNamespaces);
    }
    // Collect named constexpr/const-with-initializer values and enum constants from a member list.
    collectConstants(members: Declaration[]): void {
        return analysisPart0.collectConstants(this, members);
    }
    registerLibFnTemplate(key: string, fn: FunctionTemplateDecl): void {
        return analysisPart0.registerLibFnTemplate(this, key, fn);
    }
    collectConstant(variableDeclaration: VariableDecl): void {
        return analysisPart0.collectConstant(this, variableDeclaration);
    }
    collectEnum(type: {
        name?: string;
        underlyingType?: TypeSpec;
        members: {
            name: string;
            value?: Expression;
        }[];
    }): void {
        return analysisPart0.collectEnum(this, type);
    }
    typeOfConstant(name: string): TypeSpec | null {
        return analysisPart1.typeOfConstant(this, name);
    }
    scalarStorageType(type: TypeSpec): TypeSpec {
        return analysisPart1.scalarStorageType(this, type);
    }
    normalizeConst(value: bigint, type: TypeSpec): bigint {
        return analysisPart1.normalizeConst(this, value, type);
    }
    // Resolve a named constant (enum constant or constexpr) to its integer value, or null if unknown.
    resolveConst(name: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint | null {
        return analysisPart1.resolveConst(this, name, templateBindings);
    }
    // ---- struct sizing (binding-aware: template params resolve through `b`) ----
    sizeDepth = 0;
    sizeOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart2.sizeOfType(this, type, templateBindings);
    }
    sizeOfTypeInner(type: TypeSpec, templateBindings: TemplateBindings): number {
        return analysisPart2.sizeOfTypeInner(this, type, templateBindings);
    }
    // Resolve a dependent member type such as `Selector<args>::member`.
    resolveDependentMember(type: Extract<TypeSpec, {
        kind: AstKind.DEPENDENT_MEMBER;
    }>, templateBindings: TemplateBindings): {
        type: TypeSpec;
        bindings: TemplateBindings;
    } | null {
        return analysisPart2.resolveDependentMember(this, type, templateBindings);
    }
    // Select the matching template definition and bind its parameters.
    instantiateTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return analysisPart3.instantiateTemplate(this, name, callArguments, parent);
    }
    matchTemplateSpecialization(name: string, resolvedArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return analysisPart3.matchTemplateSpecialization(this, name, resolvedArguments, parent);
    }
    instantiateTemplateBindings(templateDeclaration: ClassTemplate, resolvedArguments: TypeSpec[], parent: TemplateBindings): TemplateBindings {
        return analysisPart3.instantiateTemplateBindings(this, templateDeclaration, resolvedArguments, parent);
    }
    // Add a template's static constexpr members to its bindings.
    withStaticConsts(templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
        return analysisPart3.withStaticConsts(this, templateDeclaration, templateBindings);
    }
    // Instantiate a template and compute its layout from concrete arguments.
    layoutOfTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
        return analysisPart3.layoutOfTemplate(this, name, callArguments, parent);
    }
    // Add member structs to a child scope for sibling type references.
    withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
        return analysisPart3.withLocalStructs(this, members, templateBindings);
    }
    // Carry sibling nested structs and unions as inline types.
    inlineNestedStruct(type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
        return analysisPart3.inlineNestedStruct(this, type, templateBindings);
    }
    fallbackTemplateLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout {
        return analysisPart3.fallbackTemplateLayout(this, name, callArguments, templateBindings);
    }
    // Resolve template bindings and contract or QPI typedefs to concrete types.
    resolveType(type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
        return analysisPart2.resolveType(this, type, templateBindings, depth);
    }
    // Resolve member types against their parent template instance.
    concreteMemberType(type: TypeSpec, parent: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    }, depth = 0): TypeSpec {
        return analysisPart2.concreteMemberType(this, type, parent, depth);
    }
    resolveInScope(type: TypeSpec, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
        return analysisPart2.resolveInScope(this, type, scope, nested, depth);
    }
    resolveNamedTypeInScope(type: Extract<TypeSpec, {
        kind: AstKind.NAME;
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
        return analysisPart2.resolveNamedTypeInScope(this, type, scope, nested, depth);
    }
    resolveTemplateInstanceArguments(type: Extract<TypeSpec, {
        kind: AstKind.TEMPLATE_INSTANCE;
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec[] {
        return analysisPart2.resolveTemplateInstanceArguments(this, type, scope, nested, depth);
    }
    // Substitute concrete type and value bindings into a type.
    substInBindings(type: TypeSpec, bind: TemplateBindings): TypeSpec {
        return analysisPart2.substInBindings(this, type, bind);
    }
    // Public: recover the integer value of a (possibly value-) template arg, e.g. the `4` of Array<sint64,4>.
    valueOfTypeArg(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
        return analysisPart2.valueOfTypeArg(this, type, templateBindings);
    }
    evalConstFromType(type: TypeSpec, templateBindings: TemplateBindings): bigint {
        return analysisPart2.evalConstFromType(this, type, templateBindings);
    }
    layoutOf(struct: StructDecl): StructLayout {
        return analysisPart4.layoutOf(this, struct);
    }
    // Collect a base class's leading fields and static constants.
    baseContribution(baseType: TypeSpec, parentB: TemplateBindings): {
        layout: StructLayout;
        consts: Map<string, bigint>;
    } | null {
        return analysisPart4.baseContribution(this, baseType, parentB);
    }
    // Evaluate a qualified static constexpr under the current bindings.
    evalQualifiedConst(typeName: string, member: string, templateBindings: TemplateBindings): bigint | null {
        return analysisPart4.evalQualifiedConst(this, typeName, member, templateBindings);
    }
    // Key layout caches by declaration identity, not a possibly shared name.
    structKeys = new WeakMap<StructDecl, string>();
    structKeyCounter = 0;
    structCacheKey(struct: StructDecl): string {
        return analysisPart4.structCacheKey(this, struct);
    }
    layoutOfStruct(struct: StructDecl, templateBindings: TemplateBindings): StructLayout {
        return analysisPart4.layoutOfStruct(this, struct, templateBindings);
    }
    inProgress = new Set<string>();
    bindingSig(templateBindings: TemplateBindings): string {
        return analysisPart4.bindingSig(this, templateBindings);
    }
    layoutOfMembers(members: Declaration[], bIn: TemplateBindings, cacheKey: string, isUnion = false, bases: TypeSpec[] = []): StructLayout {
        return analysisPart4.layoutOfMembers(this, members, bIn, cacheKey, isUnion, bases);
    }
    alignOfTypeB(type: TypeSpec, templateBindings: TemplateBindings): number {
        return analysisPart5.alignOfTypeB(this, type, templateBindings);
    }
    alignOfNameType(typeName: string, templateBindings: TemplateBindings): number {
        return analysisPart5.alignOfNameType(this, typeName, templateBindings);
    }
    typeKey(type: TypeSpec): string {
        return analysisPart2.typeKey(this, type);
    }
    alignDepth = 0;
    structAlign(members: Declaration[], templateBindings: TemplateBindings): number {
        return analysisPart5.structAlign(this, members, templateBindings);
    }
    // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
    evalConst(expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart1.evalConst(this, expression, templateBindings);
    }
    // Parse an integer literal token (hex/bin/octal/dec, with optional u/l/ull suffixes) to a bigint.
    parseIntLiteral(value: string): bigint {
        return analysisPart1.parseIntLiteral(this, value);
    }
    evalConstBig(expression: Expression, templateBindings: TemplateBindings): bigint {
        return analysisPart1.evalConstBig(this, expression, templateBindings);
    }
    alignUp(count: number, argument: number): number {
        return analysisPart5.alignUp(this, count, argument);
    }
    // ---- collect nested structs ----
    collectNested(contract: StructDecl): void {
        return analysisPart6.collectNested(this, contract);
    }
    // Register nested declarations from a callee contract translation unit under `${name}::`.
    registerCalleeContractDeclarations(name: string, declarations: Declaration[]): void {
        return analysisPart6.registerCalleeContractDeclarations(this, name, declarations);
    }
    // Register nested-struct methods in the shared method table.
    captureStructMethods(structDeclaration: StructDecl, names: string[]): void {
        return analysisPart6.captureStructMethods(this, structDeclaration, names);
    }
    collectNestedStructs(parent: StructDecl, prefix: string): void {
        return analysisPart6.collectNestedStructs(this, parent, prefix);
    }
    // ---- type → layout / field resolution (used by body codegen for address computation) ----
    alignOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart5.alignOfType(this, type, templateBindings);
    }
    // Resolve structs through binding, nested, and global tables.
    structByName(name: string, templateBindings: TemplateBindings): StructDecl | undefined {
        return analysisPart6.structByName(this, name, templateBindings);
    }
    // Resolve qualified nested types through bindings, typedefs, and structs.
    qualifiedNestedType(name: string, templateBindings: TemplateBindings): TypeSpec | null {
        return analysisPart6.qualifiedNestedType(this, name, templateBindings);
    }
    walkNestedSegments(sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null {
        return analysisPart6.walkNestedSegments(this, sd, segs, templateBindings);
    }
    // Strip const and reference wrappers to the underlying type.
    derefType(type: TypeSpec): TypeSpec {
        return analysisPart2.derefType(this, type);
    }
    // True for a void return type. The parser spells void with both {kind:"void"} nodes and dedicated tokens.
    isVoidType(type: TypeSpec): boolean {
        return analysisPart2.isVoidType(this, type);
    }
    // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address rather than as an i64 value.
    isAggregateType(type: TypeSpec): boolean {
        return analysisPart2.isAggregateType(this, type);
    }
    // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
    layoutOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout | null {
        return analysisPart5.layoutOfType(this, type, templateBindings);
    }
    // Resolve a type to its StructDecl (for inline member-method lookup), following typedefs/bindings.
    structOf(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
        return analysisPart6.structOf(this, type, templateBindings);
    }
    // Look up a field within a struct-ish type, returning its offset/size/type.
    fieldOf(type: TypeSpec, member: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): FieldLayout | null {
        return analysisPart5.fieldOf(this, type, member, templateBindings);
    }
    // ---- public helpers for compiling instantiated container methods ----
    typeKeyOf(type: TypeSpec): string {
        return analysisPart2.typeKeyOf(this, type);
    }
    // The full layout of a container instantiation (HashMap<id,uint64,1024> → _elements/_occupationFlags/...).
    containerLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
        return analysisPart8.containerLayout(this, name, callArguments, templateBindings);
    }
    // template params → concrete args (KeyT→id, L→1024), including authoritative defaults such as
    // HashFunc = HashFunction<KeyT>.
    bindContainer(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): TemplateBindings {
        return analysisPart3.bindContainer(this, name, callArguments, templateBindings);
    }
    // Evaluate the container's static constexpr members (e.g. _nEncodedFlags = L>32?32:L) under bindings.
    staticConstsOf(name: string, templateBindings: TemplateBindings): Map<string, bigint> {
        return analysisPart3.staticConstsOf(this, name, templateBindings);
    }
    evalConstNum(expression: Expression, templateBindings: TemplateBindings): number {
        return analysisPart1.evalConstNum(this, expression, templateBindings);
    }
    methodOwnerNames(name: string, seen = new Set<string>()): string[] {
        return analysisPart7.methodOwnerNames(this, name, seen);
    }
    baseTemplateName(type: TypeSpec): string | null {
        return analysisPart7.baseTemplateName(this, type);
    }
    hasInstanceMethod(name: string, methodName: string): boolean {
        return analysisPart7.hasInstanceMethod(this, name, methodName);
    }
    resolveSourceMethodDefinition(
        ownerTypeName: string,
        ownerTemplateArguments: TypeSpec[],
        methodName: string,
        methodArgumentCount?: number,
        parameterTypeDiscriminator?: string,
    ): ResolvedSourceMethod | null {
        return analysisPart7.resolveSourceMethodDefinition(
            this,
            ownerTypeName,
            ownerTemplateArguments,
            methodName,
            methodArgumentCount,
            parameterTypeDiscriminator,
        );
    }
    buildMethodSpecializationKey(
        methodName: string,
        methodArgumentCount: number | undefined,
        ownerTemplateArguments: TypeSpec[],
        ownerBindings: TemplateBindings,
    ): string | undefined {
        return analysisPart7.buildMethodSpecializationKey(
            this,
            methodName,
            methodArgumentCount,
            ownerTemplateArguments,
            ownerBindings,
        );
    }
    buildMethodOverloadKey(
        methodName: string,
        methodArgumentCount: number | undefined,
        parameterTypeDiscriminator: string | undefined,
    ): string | undefined {
        return analysisPart7.buildMethodOverloadKey(
            this,
            methodName,
            methodArgumentCount,
            parameterTypeDiscriminator,
        );
    }
    warn(message: string, at: number | Span): void {
        return analysisPart9.warn(this, message, at);
    }
    // Deduplicate hard semantic errors raised during speculative emission.
    error(message: string, at: number | Span): void {
        return analysisPart9.error(this, message, at);
    }
}
