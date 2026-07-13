import { ClassTemplate, CompiledMethod, CompiledHelperMetadata, PrivateFunctionMetadata, CalleeIdl, StructLayout, CodeGenerationWarning, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout, ContainerLayoutMetadata, NamespaceLookupContext } from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, Span } from "../ast";
import type { Sema } from "../sema";
import type { PlatformCapability } from "../shared/platform-capabilities";
import { ASSET_ENUMERATION_RECORD } from "@qinit/core";
import type { ProgramAnalysisInternals } from "./program-analysis-context";
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
    private sema: Sema;
    private nested: Map<string, StructDecl> = new Map(); // contract-local nested structs
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
    private constCache: Map<string, bigint> = new Map();
    private constInProgress = new Set<string>();
    helpers: Map<string, CompiledHelperMetadata> = new Map(); // value helpers: toReturnCode(...) etc.
    helperOverloads: Map<string, CompiledHelperMetadata[]> = new Map(); // member value helpers, ALL overloads per name in declaration order; call sites rank by argument signature
    libFns: Map<string, FunctionDecl> = new Map(); // qpi.h namespace free functions (ProposalTypes::cls), keyed by qualified name; compiled lazily
    libFnOverloads: Map<string, FunctionDecl[]> = new Map(); // all non-template overloads, in source order
    libFnTemplates: Map<string, FunctionTemplateDecl[]> = new Map(); // qpi.h namespace free function TEMPLATES (isArraySortedWithoutDuplicates<T,L>), all overloads kept, instantiated per call-site arg types
    namespaceUsings: Map<string, string[]> = new Map(); // namespace scope -> directives visible to later declarations in that scope
    namespaceContexts: Map<object, NamespaceLookupContext> = new Map(); // declaration -> namespace lookup state at its definition
    privates: Map<string, PrivateFunctionMetadata> = new Map(); // PRIVATE_FUNCTION/PROCEDURE called via CALL()
    registered: Map<string, PrivateFunctionMetadata> = new Map(); // REGISTER_USER_* function/procedure, also reachable via CALL() (same entry shape)
    callees: Map<string, CalleeIdl> = new Map(); // other contracts callable via CALL_OTHER/INVOKE_OTHER (by state-type name)
    private layoutCache: Map<string, StructLayout> = new Map();
    contractStateLayout: StructLayout = { size: 0, align: 1, fields: new Map() }; // the contract's StateData (a ContractState& param in any function resolves through it)
    slot = 0; // contract slot; oracle notification ids embed it ((slot << 22) | defLine)
    gtestMode = false; // test-runner module: enable qtest host intrinsics
    memberFnLine: Map<string, number> = new Map(); // contract member function name → definition line (__id_<proc> resolution)
    warnings: CodeGenerationWarning[] = [];
    errors: CodeGenerationWarning[] = [];
    capabilities: Set<PlatformCapability> = new Set();
    constructor(sema: Sema) {
        this.sema = sema;
    }
    // ---- register declarations from the parsed TU into codegen lookup tables ----
    registerTopLevelDeclarations(declarations: Declaration[], nsPrefix = "", inheritedUsing: string[] = []): void {
        return analysisPart0.registerTopLevelDeclarations(this as unknown as ProgramAnalysisInternals, declarations, nsPrefix, inheritedUsing);
    }
    private captureMemberNamespaceContexts(members: Declaration[], context: NamespaceLookupContext): void {
        return analysisPart0.captureMemberNamespaceContexts(this as unknown as ProgramAnalysisInternals, members, context);
    }
    namespaceContextOf(declaration?: object | null): NamespaceLookupContext {
        return analysisPart0.namespaceContextOf(this as unknown as ProgramAnalysisInternals, declaration);
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
        return analysisPart0.namespaceCandidates(this as unknown as ProgramAnalysisInternals, name, sourceNamespace, usingNamespaces);
    }
    // Collect named constexpr/const-with-initializer values and enum constants from a member list.
    private collectConstants(members: Declaration[]): void {
        return analysisPart0.collectConstants(this as unknown as ProgramAnalysisInternals, members);
    }
    private registerLibFnTemplate(key: string, fn: FunctionTemplateDecl): void {
        return analysisPart0.registerLibFnTemplate(this as unknown as ProgramAnalysisInternals, key, fn);
    }
    private collectConstant(variableDeclaration: VariableDecl): void {
        return analysisPart0.collectConstant(this as unknown as ProgramAnalysisInternals, variableDeclaration);
    }
    private collectEnum(type: {
        name?: string;
        underlyingType?: TypeSpec;
        members: {
            name: string;
            value?: Expression;
        }[];
    }): void {
        return analysisPart0.collectEnum(this as unknown as ProgramAnalysisInternals, type);
    }
    typeOfConstant(name: string): TypeSpec | null {
        return analysisPart1.typeOfConstant(this as unknown as ProgramAnalysisInternals, name);
    }
    scalarStorageType(type: TypeSpec): TypeSpec {
        return analysisPart1.scalarStorageType(this as unknown as ProgramAnalysisInternals, type);
    }
    private normalizeConst(value: bigint, type: TypeSpec): bigint {
        return analysisPart1.normalizeConst(this as unknown as ProgramAnalysisInternals, value, type);
    }
    // Resolve a named constant (enum constant or constexpr) to its integer value, or null if unknown.
    resolveConst(name: string): bigint | null {
        return analysisPart1.resolveConst(this as unknown as ProgramAnalysisInternals, name);
    }
    // ---- struct sizing (binding-aware: template params resolve through `b`) ----
    private sizeDepth = 0;
    sizeOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart2.sizeOfType(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    private sizeOfTypeInner(type: TypeSpec, templateBindings: TemplateBindings): number {
        return analysisPart2.sizeOfTypeInner(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    // Resolve a dependent member type `Selector<args>::member` (e.g. ProposalVoting's
    private resolveDependentMember(type: Extract<TypeSpec, {
        kind: "dependent_member";
    }>, templateBindings: TemplateBindings): {
        type: TypeSpec;
        bindings: TemplateBindings;
    } | null {
        return analysisPart2.resolveDependentMember(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    // Select the template definition for `name<args>` and build its parameter bindings. A partial/explicit
    private instantiateTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return analysisPart3.instantiateTemplate(this as unknown as ProgramAnalysisInternals, name, callArguments, parent);
    }
    private matchTemplateSpecialization(name: string, resolvedArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null {
        return analysisPart3.matchTemplateSpecialization(this as unknown as ProgramAnalysisInternals, name, resolvedArguments, parent);
    }
    private instantiateTemplateBindings(templateDeclaration: ClassTemplate, resolvedArguments: TypeSpec[], parent: TemplateBindings): TemplateBindings {
        return analysisPart3.instantiateTemplateBindings(this as unknown as ProgramAnalysisInternals, templateDeclaration, resolvedArguments, parent);
    }
    // Evaluate a template's own static constexpr members into the bindings (BitArray::_elements = (L+63)/64, ProposalWithAllVoteData::supportScalarVotes), so a member array
    private withStaticConsts(templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings {
        return analysisPart3.withStaticConsts(this as unknown as ProgramAnalysisInternals, templateDeclaration, templateBindings);
    }
    // Instantiate a template (HashMap<id,uint64,1024>, Array<T,L>, ...) and compute its exact layout by substituting type args + non-type args
    private layoutOfTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout {
        return analysisPart3.layoutOfTemplate(this as unknown as ProgramAnalysisInternals, name, callArguments, parent);
    }
    // Add the struct declarations among `members` to a child binding scope so field types that reference a sibling
    private withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings {
        return analysisPart3.withLocalStructs(this as unknown as ProgramAnalysisInternals, members, templateBindings);
    }
    // If a field's type names a sibling nested struct/union (registered in the local-struct scope), return it as an
    private inlineNestedStruct(type: TypeSpec, templateBindings: TemplateBindings): TypeSpec {
        return analysisPart3.inlineNestedStruct(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    private fallbackTemplateLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout {
        return analysisPart3.fallbackTemplateLayout(this as unknown as ProgramAnalysisInternals, name, callArguments, templateBindings);
    }
    // Resolve a type name to its concrete type, chasing both template-parameter bindings and contract/qpi typedefs (e.g. ProposalVotingT ->
    resolveType(type: TypeSpec, templateBindings: TemplateBindings, depth = 0): TypeSpec {
        return analysisPart2.resolveType(this as unknown as ProgramAnalysisInternals, type, templateBindings, depth);
    }
    // Resolve a member/element type that is written in terms of a parent template instance's own parameters and nested
    concreteMemberType(type: TypeSpec, parent: TypeSpec & {
        kind: "template_instance";
    }, depth = 0): TypeSpec {
        return analysisPart2.concreteMemberType(this as unknown as ProgramAnalysisInternals, type, parent, depth);
    }
    private resolveInScope(type: TypeSpec, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
        return analysisPart2.resolveInScope(this as unknown as ProgramAnalysisInternals, type, scope, nested, depth);
    }
    private resolveNamedTypeInScope(type: Extract<TypeSpec, {
        kind: "name";
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec {
        return analysisPart2.resolveNamedTypeInScope(this as unknown as ProgramAnalysisInternals, type, scope, nested, depth);
    }
    private resolveTemplateInstanceArguments(type: Extract<TypeSpec, {
        kind: "template_instance";
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec[] {
        return analysisPart2.resolveTemplateInstanceArguments(this as unknown as ProgramAnalysisInternals, type, scope, nested, depth);
    }
    // Public: substitute a type through bindings (T→sint64, L→4) — turns a template free fn's param type `Array<T,L>` into
    substInBindings(type: TypeSpec, bind: TemplateBindings): TypeSpec {
        return analysisPart2.substInBindings(this as unknown as ProgramAnalysisInternals, type, bind);
    }
    // Public: recover the integer value of a (possibly value-) template arg, e.g. the `4` of Array<sint64,4>.
    valueOfTypeArg(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): bigint {
        return analysisPart2.valueOfTypeArg(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    private evalConstFromType(type: TypeSpec, templateBindings: TemplateBindings): bigint {
        return analysisPart2.evalConstFromType(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    layoutOf(struct: StructDecl): StructLayout {
        return analysisPart4.layoutOf(this as unknown as ProgramAnalysisInternals, struct);
    }
    // A base class contributes its fields (laid out at the start of the derived object) and its static
    private baseContribution(baseType: TypeSpec, parentB: TemplateBindings): {
        layout: StructLayout;
        consts: Map<string, bigint>;
    } | null {
        return analysisPart4.baseContribution(this as unknown as ProgramAnalysisInternals, baseType, parentB);
    }
    // Evaluate a `TypeName::member` static constexpr. Resolves TypeName through the current bindings and
    private evalQualifiedConst(typeName: string, member: string, templateBindings: TemplateBindings): bigint | null {
        return analysisPart4.evalQualifiedConst(this as unknown as ProgramAnalysisInternals, typeName, member, templateBindings);
    }
    // A layout cache key unique to each struct DECLARATION, not its (possibly shared) name. Two distinct structs
    private structKeys = new WeakMap<StructDecl, string>();
    private structKeyCounter = 0;
    private structCacheKey(struct: StructDecl): string {
        return analysisPart4.structCacheKey(this as unknown as ProgramAnalysisInternals, struct);
    }
    private layoutOfStruct(struct: StructDecl, templateBindings: TemplateBindings): StructLayout {
        return analysisPart4.layoutOfStruct(this as unknown as ProgramAnalysisInternals, struct, templateBindings);
    }
    private inProgress = new Set<string>();
    private bindingSig(templateBindings: TemplateBindings): string {
        return analysisPart4.bindingSig(this as unknown as ProgramAnalysisInternals, templateBindings);
    }
    private layoutOfMembers(members: Declaration[], bIn: TemplateBindings, cacheKey: string, isUnion = false, bases: TypeSpec[] = []): StructLayout {
        return analysisPart4.layoutOfMembers(this as unknown as ProgramAnalysisInternals, members, bIn, cacheKey, isUnion, bases);
    }
    private alignOfTypeB(type: TypeSpec, templateBindings: TemplateBindings): number {
        return analysisPart5.alignOfTypeB(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    private alignOfNameType(typeName: string, templateBindings: TemplateBindings): number {
        return analysisPart5.alignOfNameType(this as unknown as ProgramAnalysisInternals, typeName, templateBindings);
    }
    private typeKey(type: TypeSpec): string {
        return analysisPart2.typeKey(this as unknown as ProgramAnalysisInternals, type);
    }
    private alignDepth = 0;
    private structAlign(members: Declaration[], templateBindings: TemplateBindings): number {
        return analysisPart5.structAlign(this as unknown as ProgramAnalysisInternals, members, templateBindings);
    }
    // Evaluate a constant expression, resolving template non-type params (e.g. L) through `b.values`.
    evalConst(expression: Expression, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart1.evalConst(this as unknown as ProgramAnalysisInternals, expression, templateBindings);
    }
    // Parse an integer literal token (hex/bin/octal/dec, with optional u/l/ull suffixes) to a bigint.
    private parseIntLiteral(value: string): bigint {
        return analysisPart1.parseIntLiteral(this as unknown as ProgramAnalysisInternals, value);
    }
    evalConstBig(expression: Expression, templateBindings: TemplateBindings): bigint {
        return analysisPart1.evalConstBig(this as unknown as ProgramAnalysisInternals, expression, templateBindings);
    }
    private alignUp(count: number, argument: number): number {
        return analysisPart5.alignUp(this as unknown as ProgramAnalysisInternals, count, argument);
    }
    // ---- collect nested structs ----
    collectNested(contract: StructDecl): void {
        return analysisPart6.collectNested(this as unknown as ProgramAnalysisInternals, contract);
    }
    // Register nested declarations from a callee contract translation unit under `${name}::`.
    registerCalleeContractDeclarations(name: string, declarations: Declaration[]): void {
        return analysisPart6.registerCalleeContractDeclarations(this as unknown as ProgramAnalysisInternals, name, declarations);
    }
    // Inline methods of a nested struct (WinnerData::isValid, EscrowAsset::setFrom) dispatch through templateMethods like any plain-struct method — capture them
    private captureStructMethods(structDeclaration: StructDecl, names: string[]): void {
        return analysisPart6.captureStructMethods(this as unknown as ProgramAnalysisInternals, structDeclaration, names);
    }
    private collectNestedStructs(parent: StructDecl, prefix: string): void {
        return analysisPart6.collectNestedStructs(this as unknown as ProgramAnalysisInternals, parent, prefix);
    }
    // ---- type → layout / field resolution (used by body codegen for address computation) ----
    alignOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): number {
        return analysisPart5.alignOfType(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    // Resolve a struct by name across the binding / nested / global tables. Falls back to the unqualified
    structByName(name: string, templateBindings: TemplateBindings): StructDecl | undefined {
        return analysisPart6.structByName(this as unknown as ProgramAnalysisInternals, name, templateBindings);
    }
    // `Head::Nested[::Deeper]` where Head is a template-parameter binding, a typedef, or a (possibly namespace-qualified) struct name (`typename OracleInterface::OracleReply` with
    qualifiedNestedType(name: string, templateBindings: TemplateBindings): TypeSpec | null {
        return analysisPart6.qualifiedNestedType(this as unknown as ProgramAnalysisInternals, name, templateBindings);
    }
    private walkNestedSegments(sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null {
        return analysisPart6.walkNestedSegments(this as unknown as ProgramAnalysisInternals, sd, segs, templateBindings);
    }
    // Strip const/reference wrappers to the underlying type (a by-ref aggregate param holds an address to this type, and
    derefType(type: TypeSpec): TypeSpec {
        return analysisPart2.derefType(this as unknown as ProgramAnalysisInternals, type);
    }
    // True for a void return type. The parser spells void with both {kind:"void"} nodes and dedicated tokens.
    isVoidType(type: TypeSpec): boolean {
        return analysisPart2.isVoidType(this as unknown as ProgramAnalysisInternals, type);
    }
    // True if a type is an aggregate (id/m256i/struct/array/container) — passed/returned by address rather than as an i64 value.
    isAggregateType(type: TypeSpec): boolean {
        return analysisPart2.isAggregateType(this as unknown as ProgramAnalysisInternals, type);
    }
    // Resolve a struct-ish type to its (cached) field layout, or null for scalars/containers.
    layoutOfType(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout | null {
        return analysisPart5.layoutOfType(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    // Resolve a type to its StructDecl (for inline member-method lookup), following typedefs/bindings.
    structOf(type: TypeSpec, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructDecl | null {
        return analysisPart6.structOf(this as unknown as ProgramAnalysisInternals, type, templateBindings);
    }
    // Look up a field within a struct-ish type, returning its offset/size/type.
    fieldOf(type: TypeSpec, member: string, templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): FieldLayout | null {
        return analysisPart5.fieldOf(this as unknown as ProgramAnalysisInternals, type, member, templateBindings);
    }
    // ---- public helpers for compiling instantiated container methods ----
    typeKeyOf(type: TypeSpec): string {
        return analysisPart2.typeKeyOf(this as unknown as ProgramAnalysisInternals, type);
    }
    // The full layout of a container instantiation (HashMap<id,uint64,1024> → _elements/_occupationFlags/...).
    containerLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): StructLayout {
        return analysisPart8.containerLayout(this as unknown as ProgramAnalysisInternals, name, callArguments, templateBindings);
    }
    // template params → concrete args (KeyT→id, L→1024), including authoritative defaults such as
    // HashFunc = HashFunction<KeyT>.
    bindContainer(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): TemplateBindings {
        return analysisPart3.bindContainer(this as unknown as ProgramAnalysisInternals, name, callArguments, templateBindings);
    }
    // Evaluate the container's static constexpr members (e.g. _nEncodedFlags = L>32?32:L) under bindings.
    staticConstsOf(name: string, templateBindings: TemplateBindings): Map<string, bigint> {
        return analysisPart3.staticConstsOf(this as unknown as ProgramAnalysisInternals, name, templateBindings);
    }
    evalConstNum(expression: Expression, templateBindings: TemplateBindings): number {
        return analysisPart1.evalConstNum(this as unknown as ProgramAnalysisInternals, expression, templateBindings);
    }
    private methodOwnerNames(name: string, seen = new Set<string>()): string[] {
        return analysisPart7.methodOwnerNames(this as unknown as ProgramAnalysisInternals, name, seen);
    }
    private baseTemplateName(type: TypeSpec): string | null {
        return analysisPart7.baseTemplateName(this as unknown as ProgramAnalysisInternals, type);
    }
    hasInstanceMethod(name: string, methodName: string): boolean {
        return analysisPart7.hasInstanceMethod(this as unknown as ProgramAnalysisInternals, name, methodName);
    }
    // Public: resolve a container/struct method to its body + the binding for the matched template instance, HONORING PARTIAL
    methodTemplate(name: string, callArguments: TypeSpec[], methodName: string, argCount?: number, paramTypeKey?: string): {
        def: FunctionTemplateDecl;
        bind: TemplateBindings;
        memberTemplate?: boolean;
    } | null {
        return analysisPart7.methodTemplate(this as unknown as ProgramAnalysisInternals, name, callArguments, methodName, argCount, paramTypeKey);
    }
    private buildMethodSpecializationKey(methodName: string, argCount: number | undefined, callArguments: TypeSpec[], bind: TemplateBindings): string | undefined {
        return analysisPart7.buildMethodSpecializationKey(this as unknown as ProgramAnalysisInternals, methodName, argCount, callArguments, bind);
    }
    private buildMethodOverloadKey(methodName: string, argCount: number | undefined, paramTypeKey: string | undefined): string | undefined {
        return analysisPart7.buildMethodOverloadKey(this as unknown as ProgramAnalysisInternals, methodName, argCount, paramTypeKey);
    }
    // The hash-container's internal byte offsets, read from the PARSED qpi.h template layout (so they track the real field
    private hashContainerOffsets(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings, capacity: number): {
        elemSize: number;
        occBase: number;
        popOff: number;
        totalSize: number;
    } | null {
        return analysisPart8.hashContainerOffsets(this as unknown as ProgramAnalysisInternals, name, callArguments, templateBindings, capacity);
    }
    // Concrete offsets/sizes for HashMap<K,V,L>. Key/value sizing follows standard C struct layout of
    hashmapInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
        return analysisPart8.hashmapInfo(this as unknown as ProgramAnalysisInternals, callArguments, templateBindings);
    }
    // HashSet<K,L>: keys-only — same probing/occupancy as HashMap with a zero-width value.
    hashsetInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
        return analysisPart8.hashsetInfo(this as unknown as ProgramAnalysisInternals, callArguments, templateBindings);
    }
    arrayInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): ContainerLayoutMetadata | null {
        return analysisPart8.arrayInfo(this as unknown as ProgramAnalysisInternals, callArguments, templateBindings);
    }
    // Backing-store geometry for Collection<T, L>.element(i) = _elements[i & (L-1)].value — all offsets read from the parsed layout (the
    collectionInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): {
        L: number;
        elementsOff: number;
        stride: number;
        valueOff: number;
        elemType: TypeSpec;
    } | null {
        return analysisPart8.collectionInfo(this as unknown as ProgramAnalysisInternals, callArguments, templateBindings);
    }
    // Backing-store geometry for LinkedList<T, L>.element(i) = _nodes[i & (L-1)].value — offsets from the parsed layout (the Node record
    linkedListInfo(callArguments: TypeSpec[], templateBindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): {
        L: number;
        nodesOff: number;
        stride: number;
        valueOff: number;
        elemType: TypeSpec;
    } | null {
        return analysisPart8.linkedListInfo(this as unknown as ProgramAnalysisInternals, callArguments, templateBindings);
    }
    warn(message: string, at: number | Span): void {
        return analysisPart9.warn(this as unknown as ProgramAnalysisInternals, message, at);
    }
    // Hard semantic errors (not fidelity warnings): these abort the build regardless of strict mode. Deduplicated because speculative emission
    error(message: string, at: number | Span): void {
        return analysisPart9.error(this as unknown as ProgramAnalysisInternals, message, at);
    }
}
