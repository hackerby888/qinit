import { AstKind } from "../shared/enums";
import {
    ClassTemplate,
    CompiledMethod,
    CompiledHelperMetadata,
    PrivateFunctionMetadata,
    ResolvedCalleeIdl,
    StructLayout,
    CodeGenerationWarning,
    EMPTY_TEMPLATE_BINDINGS,
    TemplateBindings,
    FieldLayout,
    NamespaceLookupContext,
    ResolvedSourceMethod,
} from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, Span } from "../ast";
import type { SemanticAnalyzer } from "./semantic-analysis";
import type { PlatformCapability } from "../shared/enums";
import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import * as declarationIndex from "./declaration-index";
import * as constantEvaluator from "./constant-evaluator";
import * as typeResolver from "./type-resolver";
import * as templateResolver from "./template-resolver";
import * as structLayout from "./struct-layout";
import * as typeLayout from "./type-layout";
import * as structIndex from "./struct-index";
import * as functionIndex from "./function-index";
import * as containerLayout from "./container-layout";
import * as analysisDiagnostics from "./analysis-diagnostics";

export class ProgramAnalysis {
    assetEnumerationRecord: {
        size: number;
        capacity: number;
        fields: Record<
            string,
            {
                offset: number;
                size: number;
            }
        >;
    } = ASSET_ENUMERATION_RECORD;
    sema: SemanticAnalyzer;
    nested: Map<string, StructDecl> = new Map(); // contract-local nested structs
    nestedTemplates: Map<string, ClassTemplate> = new Map(); // contract-local nested class templates
    templates: Map<string, ClassTemplate> = new Map(); // qpi.h templates (HashMap, Array, ...)
    specializations: Map<
        string,
        {
            specArgs: TypeSpec[];
            templateDeclaration: ClassTemplate;
        }[]
    > = new Map(); // partial/explicit specializations keyed by template name
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
    methodsByDeclaration: Map<StructDecl, Map<string, FunctionTemplateDecl>> = new Map(); // the same methods, under the class that declared them, so two classes sharing a name do not share a table
    declarationIds: Map<StructDecl, number> = new Map(); // stable per-declaration id, so an instantiation cache key names one class and not every class spelled alike
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
        return declarationIndex.registerTopLevelDeclarations(this, declarations, nsPrefix, inheritedUsing);
    }
    captureMemberNamespaceContexts(members: Declaration[], context: NamespaceLookupContext): void {
        return declarationIndex.captureMemberNamespaceContexts(this, members, context);
    }
    namespaceContextOf(declaration?: object | null): NamespaceLookupContext {
        return declarationIndex.namespaceContextOf(this, declaration);
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
        return declarationIndex.namespaceCandidates(name, sourceNamespace, usingNamespaces);
    }
    // Collect named constexpr/const-with-initializer values and enum constants from a member list.
    collectConstants(members: Declaration[]): void {
        return declarationIndex.collectConstants(this, members);
    }
    registerLibFnTemplate(key: string, fn: FunctionTemplateDecl): void {
        return declarationIndex.registerLibFnTemplate(this, key, fn);
    }
    collectConstant(variableDeclaration: VariableDecl): void {
        return declarationIndex.collectConstant(this, variableDeclaration);
    }
    collectEnum(type: {
        name?: string;
        underlyingType?: TypeSpec;
        members: {
            name: string;
            value?: Expression;
        }[];
    }): void {
        return declarationIndex.collectEnum(this, type);
    }
    typeOfConstant(name: string): TypeSpec | null {
        return constantEvaluator.typeOfConstant(this, name);
    }
    scalarStorageType(type: TypeSpec): TypeSpec {
        return constantEvaluator.scalarStorageType(this, type);
    }
    normalizeConst(value: bigint, type: TypeSpec): bigint {
        return constantEvaluator.normalizeConst(this, value, type);
    }
    // Resolve a named constant (enum constant or constexpr) to its integer value, or null if unknown.
    resolveConst(name: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint | null {
        return constantEvaluator.resolveConst(this, name, templateBindings);
    }
    // ---- struct sizing (binding-aware: template params resolve through `b`) ----
    sizeDepth = 0;
    sizeOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return typeResolver.sizeOfType(this, type, templateBindings);
    }
    sizeOfTypeInner(type: TypeSpec, templateBindings: TemplateBindings): number {
        return typeResolver.sizeOfTypeInner(this, type, templateBindings);
    }
    // Resolve a dependent member type such as `Selector<args>::member`.
    resolveDependentMember(
        type: Extract<
            TypeSpec,
            {
                kind: AstKind.DEPENDENT_MEMBER;
            }
        >,
        templateBindings: TemplateBindings,
    ): {
        type: TypeSpec;
        bindings: TemplateBindings;
    } | null {
        return typeResolver.resolveDependentMember(this, type, templateBindings);
    }
    // Select the matching template definition and bind its parameters.
    instantiateTemplate(
        name: string,
        callArguments: TypeSpec[],
        parent: TemplateBindings,
    ): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return templateResolver.instantiateTemplate(this, name, callArguments, parent);
    }
    matchTemplateSpecialization(
        name: string,
        resolvedArguments: TypeSpec[],
        parent: TemplateBindings,
    ): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return templateResolver.matchTemplateSpecialization(this, name, resolvedArguments, parent);
    }
    instantiateTemplateBindings(templateDeclaration: ClassTemplate, resolvedArguments: TypeSpec[], parent: TemplateBindings): TemplateBindings {
        return templateResolver.instantiateTemplateBindings(this, templateDeclaration, resolvedArguments, parent);
    }
    // Add a template's static constexpr members to its bindings.
    withStaticConsts(templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
        return templateResolver.withStaticConsts(this, templateDeclaration, templateBindings);
    }
    // Instantiate a template and compute its layout from concrete arguments.
    layoutOfTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
        return templateResolver.layoutOfTemplate(this, name, callArguments, parent);
    }
    // Add member structs to a child scope for sibling type references.
    withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
        return templateResolver.withLocalStructs(members, templateBindings);
    }
    // Carry sibling nested structs and unions as inline types.
    inlineNestedStruct(type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
        return templateResolver.inlineNestedStruct(this, type, templateBindings);
    }
    fallbackTemplateLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout {
        return templateResolver.fallbackTemplateLayout(this, name, callArguments, templateBindings);
    }
    // Resolve template bindings and contract or QPI typedefs to concrete types.
    resolveType(type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
        return typeResolver.resolveType(this, type, templateBindings, depth);
    }
    // Resolve member types against their parent template instance.
    concreteMemberType(
        type: TypeSpec,
        parent: TypeSpec & {
            kind: AstKind.TEMPLATE_INSTANCE;
        },
        depth = 0,
    ): TypeSpec {
        return typeResolver.concreteMemberType(this, type, parent, depth);
    }
    resolveInScope(type: TypeSpec, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
        return typeResolver.resolveInScope(this, type, scope, nested, depth);
    }
    resolveNamedTypeInScope(
        type: Extract<
            TypeSpec,
            {
                kind: AstKind.NAME;
            }
        >,
        scope: TemplateBindings,
        nested: Map<string, TypeSpec>,
        depth: number,
    ): TypeSpec {
        return typeResolver.resolveNamedTypeInScope(this, type, scope, nested, depth);
    }
    resolveTemplateInstanceArguments(
        type: Extract<
            TypeSpec,
            {
                kind: AstKind.TEMPLATE_INSTANCE;
            }
        >,
        scope: TemplateBindings,
        nested: Map<string, TypeSpec>,
        depth: number,
    ): TypeSpec[] {
        return typeResolver.resolveTemplateInstanceArguments(this, type, scope, nested, depth);
    }
    // Substitute concrete type and value bindings into a type.
    substInBindings(type: TypeSpec, bind: TemplateBindings): TypeSpec {
        return typeResolver.substInBindings(this, type, bind);
    }
    // Public: recover the integer value of a (possibly value-) template arg, e.g. the `4` of Array<sint64,4>.
    valueOfTypeArg(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
        return typeResolver.valueOfTypeArg(this, type, templateBindings);
    }
    evalConstFromType(type: TypeSpec, templateBindings: TemplateBindings): bigint {
        return typeResolver.evalConstFromType(this, type, templateBindings);
    }
    layoutOf(struct: StructDecl): StructLayout {
        return structLayout.layoutOf(this, struct);
    }
    // Collect a base class's leading fields and static constants.
    baseContribution(
        baseType: TypeSpec,
        parentB: TemplateBindings,
    ): {
        layout: StructLayout;
        consts: Map<string, bigint>;
    } | null {
        return structLayout.baseContribution(this, baseType, parentB);
    }
    // Evaluate a qualified static constexpr under the current bindings.
    evalQualifiedConst(typeName: string, member: string, templateBindings: TemplateBindings): bigint | null {
        return structLayout.evalQualifiedConst(this, typeName, member, templateBindings);
    }
    // Key layout caches by declaration identity, not a possibly shared name.
    structKeys = new WeakMap<StructDecl, string>();
    structKeyCounter = 0;
    structCacheKey(struct: StructDecl): string {
        return structLayout.structCacheKey(this, struct);
    }
    layoutOfStruct(struct: StructDecl, templateBindings: TemplateBindings): StructLayout {
        return structLayout.layoutOfStruct(this, struct, templateBindings);
    }
    inProgress = new Set<string>();
    bindingSig(templateBindings: TemplateBindings): string {
        return structLayout.bindingSig(this, templateBindings);
    }
    layoutOfMembers(members: Declaration[], bIn: TemplateBindings, cacheKey: string, isUnion = false, bases: TypeSpec[] = []): StructLayout {
        return structLayout.layoutOfMembers(this, members, bIn, cacheKey, isUnion, bases);
    }
    alignOfTypeB(type: TypeSpec, templateBindings: TemplateBindings): number {
        return typeLayout.alignOfTypeB(this, type, templateBindings);
    }
    alignOfNameType(typeName: string, templateBindings: TemplateBindings): number {
        return typeLayout.alignOfNameType(this, typeName, templateBindings);
    }
    typeKey(type: TypeSpec): string {
        return typeResolver.typeKey(this, type);
    }
    alignDepth = 0;
    structAlign(members: Declaration[], templateBindings: TemplateBindings): number {
        return typeLayout.structAlign(this, members, templateBindings);
    }
    // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
    evalConst(expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return constantEvaluator.evalConst(this, expression, templateBindings);
    }
    // Parse an integer literal token (hex/bin/octal/dec, with optional u/l/ull suffixes) to a bigint.
    tryParseIntLiteral(value: string): bigint {
        return constantEvaluator.tryParseIntLiteral(value);
    }
    evalConstBig(expression: Expression, templateBindings: TemplateBindings): bigint {
        return constantEvaluator.evalConstBig(this, expression, templateBindings);
    }
    alignUp(count: number, argument: number): number {
        return typeLayout.alignUp(this, count, argument);
    }
    // ---- collect nested structs ----
    collectNested(contract: StructDecl): void {
        return structIndex.collectNested(this, contract);
    }
    // Register nested declarations from a callee contract translation unit under `${name}::`.
    registerCalleeContractDeclarations(name: string, declarations: Declaration[]): void {
        return structIndex.registerCalleeContractDeclarations(this, name, declarations);
    }
    // Register nested-struct methods in the shared method table.
    captureStructMethods(structDeclaration: StructDecl, names: string[]): void {
        return structIndex.captureStructMethods(this, structDeclaration, names);
    }
    collectNestedStructs(parent: StructDecl, prefix: string): void {
        return structIndex.collectNestedStructs(this, parent, prefix);
    }
    // ---- type → layout / field resolution (used by body codegen for address computation) ----
    alignOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return typeLayout.alignOfType(this, type, templateBindings);
    }
    // Resolve structs through binding, nested, and global tables.
    /**
     * The class template a name resolves to, contract-local declarations first.
     *
     * A contract nesting `Array` or `HashMap` shadows core's whole declaration, parameter list
     * included, the same way a nested struct shadows a global one.
     */
    templateByName(name: string): ClassTemplate | undefined {
        const hit = this.nestedTemplates.get(name) ?? this.templates.get(name);
        if (hit) return hit;

        const index = name.lastIndexOf("::");
        if (index >= 0) {
            const unqualifiedName = name.slice(index + 2);
            return this.nestedTemplates.get(unqualifiedName) ?? this.templates.get(unqualifiedName);
        }

        return undefined;
    }
    structByName(name: string, templateBindings: TemplateBindings): StructDecl | undefined {
        return structIndex.structByName(this, name, templateBindings);
    }
    /** A stable id for a class declaration, assigned on first use. */
    declarationId(structDeclaration: StructDecl): number {
        let id = this.declarationIds.get(structDeclaration);

        if (id === undefined) {
            id = this.declarationIds.size + 1;
            this.declarationIds.set(structDeclaration, id);
        }

        return id;
    }
    // Resolve qualified nested types through bindings, typedefs, and structs.
    qualifiedNestedType(name: string, templateBindings: TemplateBindings): TypeSpec | null {
        return structIndex.qualifiedNestedType(this, name, templateBindings);
    }
    walkNestedSegments(sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null {
        return structIndex.walkNestedSegments(this, sd, segs, templateBindings);
    }
    // Strip const and reference wrappers to the underlying type.
    derefType(type: TypeSpec): TypeSpec {
        return typeResolver.derefType(this, type);
    }
    // True for a void return type. The parser spells void with both {kind:"void"} nodes and dedicated tokens.
    isVoidType(type: TypeSpec): boolean {
        return typeResolver.isVoidType(this, type);
    }
    // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address rather than as an i64 value.
    isAggregateType(type: TypeSpec): boolean {
        return typeResolver.isAggregateType(this, type);
    }
    // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
    layoutOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout | null {
        return typeLayout.layoutOfType(this, type, templateBindings);
    }
    // Resolve a type to its StructDecl (for inline member-method lookup), following typedefs/bindings.
    structOf(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
        return structIndex.structOf(this, type, templateBindings);
    }
    // Look up a field within a struct-ish type, returning its offset/size/type.
    fieldOf(type: TypeSpec, member: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): FieldLayout | null {
        return typeLayout.fieldOf(this, type, member, templateBindings);
    }
    // ---- public helpers for compiling instantiated container methods ----
    typeKeyOf(type: TypeSpec): string {
        return typeResolver.typeKeyOf(this, type);
    }
    // The full layout of a container instantiation (HashMap<id,uint64,1024> → _elements/_occupationFlags/...).
    containerLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
        return containerLayout.containerLayout(this, name, callArguments, templateBindings);
    }
    // template params → concrete args (KeyT→id, L→1024), including authoritative defaults such as
    // HashFunc = HashFunction<KeyT>.
    bindContainer(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): TemplateBindings {
        return templateResolver.bindContainer(this, name, callArguments, templateBindings);
    }
    // Evaluate the container's static constexpr members (e.g. _nEncodedFlags = L>32?32:L) under bindings.
    staticConstsOf(name: string, templateBindings: TemplateBindings): Map<string, bigint> {
        return templateResolver.staticConstsOf(this, name, templateBindings);
    }
    evalConstNum(expression: Expression, templateBindings: TemplateBindings): number {
        return constantEvaluator.evalConstNum(this, expression, templateBindings);
    }
    methodOwnerNames(name: string, seen = new Set<string>()): string[] {
        return functionIndex.methodOwnerNames(this, name, seen);
    }
    baseTemplateName(type: TypeSpec): string | null {
        return functionIndex.baseTemplateName(type);
    }
    hasInstanceMethod(name: string, methodName: string): boolean {
        return functionIndex.hasInstanceMethod(this, name, methodName);
    }
    resolveSourceMethodDefinition(
        ownerTypeName: string,
        ownerTemplateArguments: TypeSpec[],
        methodName: string,
        methodArgumentCount?: number,
        parameterTypeDiscriminator?: string,
    ): ResolvedSourceMethod | null {
        return functionIndex.resolveSourceMethodDefinition(
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
        return functionIndex.buildMethodSpecializationKey(this, methodName, methodArgumentCount, ownerTemplateArguments, ownerBindings);
    }
    buildMethodOverloadKey(methodName: string, methodArgumentCount: number | undefined, parameterTypeDiscriminator: string | undefined): string | undefined {
        return functionIndex.buildMethodOverloadKey(methodName, methodArgumentCount, parameterTypeDiscriminator);
    }
    warn(message: string, at: number | Span): void {
        return analysisDiagnostics.warn(this, message, at);
    }
    // Survives strict mode: the construct compiles correctly, the note is about style or portability.
    advise(message: string, at: number | Span): void {
        return analysisDiagnostics.advise(this, message, at);
    }
    // Deduplicate hard semantic errors raised during speculative emission.
    error(message: string, at: number | Span): void {
        return analysisDiagnostics.error(this, message, at);
    }
}
