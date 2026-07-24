import { AstKind } from "../enums";
import { ClassTemplate, CompiledMethod, CompiledHelperMetadata, PrivateFunctionMetadata, ResolvedCalleeIdl, StructLayout, CodeGenerationWarning, EMPTY_TEMPLATE_BINDINGS, TemplateBindings, FieldLayout, ContainerLayoutMetadata, NamespaceLookupContext, ResolvedSourceMethod } from "./types";
import type { TypeSpec, Expression, Declaration, StructDecl, FunctionDecl, FunctionTemplateDecl, VariableDecl, Span } from "../ast";
import type { Sema } from "../sema";
import type { PlatformCapability } from "../shared/platform-capabilities";


export interface ProgramAnalysisInternals {
  assetEnumerationRecord: {
        size: number;
        capacity: number;
        fields: Record<string, {
            offset: number;
            size: number;
        }>;
    };
  sema: Sema;
  nested: Map<string, StructDecl>;
  templates: Map<string, ClassTemplate>;
  specializations: Map<string, {
        specArgs: TypeSpec[];
        templateDeclaration: ClassTemplate;
    }[]>;
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
  compiledMethods: Map<string, CompiledMethod>;
  emittedMethodOrder: string[];
  constCache: Map<string, bigint>;
  constInProgress: Set<string>;
  helpers: Map<string, CompiledHelperMetadata>;
  helperOverloads: Map<string, CompiledHelperMetadata[]>;
  libFns: Map<string, FunctionDecl>;
  libFnOverloads: Map<string, FunctionDecl[]>;
  libFnTemplates: Map<string, FunctionTemplateDecl[]>;
  namespaceUsings: Map<string, string[]>;
  namespaceContexts: Map<object, NamespaceLookupContext>;
  privates: Map<string, PrivateFunctionMetadata>;
  registered: Map<string, PrivateFunctionMetadata>;
  callees: Map<string, ResolvedCalleeIdl>;
  layoutCache: Map<string, StructLayout>;
  contractStateLayout: StructLayout;
  slot: number;
  gtestMode: boolean;
  memberFnLine: Map<string, number>;
  warnings: CodeGenerationWarning[];
  errors: CodeGenerationWarning[];
  capabilities: Set<PlatformCapability>;
  sizeDepth: number;
  structKeys: WeakMap<StructDecl, string>;
  structKeyCounter: number;
  inProgress: Set<string>;
  alignDepth: number;
  registerTopLevelDeclarations(declarations: Declaration[], nsPrefix?: string, inheritedUsing?: string[]): void;
  captureMemberNamespaceContexts(members: Declaration[], context: NamespaceLookupContext): void;
  namespaceContextOf(declaration?: object | null): NamespaceLookupContext;
  namespaceCandidates(name: string, sourceNamespace?: string, usingNamespaces?: string[]): string[];
  collectConstants(members: Declaration[]): void;
  registerLibFnTemplate(key: string, fn: FunctionTemplateDecl): void;
  collectConstant(variableDeclaration: VariableDecl): void;
  collectEnum(type: {
        name?: string;
        underlyingType?: TypeSpec;
        members: {
            name: string;
            value?: Expression;
        }[];
    }): void;
  typeOfConstant(name: string): TypeSpec | null;
  scalarStorageType(type: TypeSpec): TypeSpec;
  normalizeConst(value: bigint, type: TypeSpec): bigint;
  resolveConst(name: string, templateBindings?: TemplateBindings): bigint | null;
  sizeOfType(type: TypeSpec, templateBindings?: TemplateBindings): number;
  sizeOfTypeInner(type: TypeSpec, templateBindings: TemplateBindings): number;
  resolveDependentMember(type: Extract<TypeSpec, {
        kind: AstKind.DEPENDENT_MEMBER;
    }>, templateBindings: TemplateBindings): {
        type: TypeSpec;
        bindings: TemplateBindings;
    } | null;
  instantiateTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null;
  matchTemplateSpecialization(name: string, resolvedArguments: TypeSpec[], parent: TemplateBindings): {
        templateDeclaration: ClassTemplate;
        b: TemplateBindings;
    } | null;
  instantiateTemplateBindings(templateDeclaration: ClassTemplate, resolvedArguments: TypeSpec[], parent: TemplateBindings): TemplateBindings;
  withStaticConsts(templateDeclaration: ClassTemplate, templateBindings: TemplateBindings): TemplateBindings;
  layoutOfTemplate(name: string, callArguments: TypeSpec[], parent: TemplateBindings): StructLayout;
  withLocalStructs(members: Declaration[], templateBindings: TemplateBindings): TemplateBindings;
  inlineNestedStruct(type: TypeSpec, templateBindings: TemplateBindings): TypeSpec;
  fallbackTemplateLayout(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings): StructLayout;
  resolveType(type: TypeSpec, templateBindings: TemplateBindings, depth?: number): TypeSpec;
  concreteMemberType(type: TypeSpec, parent: TypeSpec & {
        kind: AstKind.TEMPLATE_INSTANCE;
    }, depth?: number): TypeSpec;
  resolveInScope(type: TypeSpec, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec;
  resolveNamedTypeInScope(type: Extract<TypeSpec, {
        kind: AstKind.NAME;
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec;
  resolveTemplateInstanceArguments(type: Extract<TypeSpec, {
        kind: AstKind.TEMPLATE_INSTANCE;
    }>, scope: TemplateBindings, nested: Map<string, TypeSpec>, depth: number): TypeSpec[];
  substInBindings(type: TypeSpec, bind: TemplateBindings): TypeSpec;
  valueOfTypeArg(type: TypeSpec, templateBindings?: TemplateBindings): bigint;
  evalConstFromType(type: TypeSpec, templateBindings: TemplateBindings): bigint;
  layoutOf(struct: StructDecl): StructLayout;
  baseContribution(baseType: TypeSpec, parentB: TemplateBindings): {
        layout: StructLayout;
        consts: Map<string, bigint>;
    } | null;
  evalQualifiedConst(typeName: string, member: string, templateBindings: TemplateBindings): bigint | null;
  structCacheKey(struct: StructDecl): string;
  layoutOfStruct(struct: StructDecl, templateBindings: TemplateBindings): StructLayout;
  bindingSig(templateBindings: TemplateBindings): string;
  layoutOfMembers(members: Declaration[], bIn: TemplateBindings, cacheKey: string, isUnion?: boolean, bases?: TypeSpec[]): StructLayout;
  alignOfTypeB(type: TypeSpec, templateBindings: TemplateBindings): number;
  alignOfNameType(typeName: string, templateBindings: TemplateBindings): number;
  typeKey(type: TypeSpec): string;
  structAlign(members: Declaration[], templateBindings: TemplateBindings): number;
  evalConst(expression: Expression, templateBindings?: TemplateBindings): number;
  parseIntLiteral(value: string): bigint;
  evalConstBig(expression: Expression, templateBindings: TemplateBindings): bigint;
  alignUp(count: number, argument: number): number;
  collectNested(contract: StructDecl): void;
  registerCalleeContractDeclarations(name: string, declarations: Declaration[]): void;
  captureStructMethods(structDeclaration: StructDecl, names: string[]): void;
  collectNestedStructs(parent: StructDecl, prefix: string): void;
  alignOfType(type: TypeSpec, templateBindings?: TemplateBindings): number;
  structByName(name: string, templateBindings: TemplateBindings): StructDecl | undefined;
  qualifiedNestedType(name: string, templateBindings: TemplateBindings): TypeSpec | null;
  walkNestedSegments(sd: StructDecl | null, segs: string[], templateBindings: TemplateBindings): TypeSpec | null;
  derefType(type: TypeSpec): TypeSpec;
  isVoidType(type: TypeSpec): boolean;
  isAggregateType(type: TypeSpec): boolean;
  layoutOfType(type: TypeSpec, templateBindings?: TemplateBindings): StructLayout | null;
  structOf(type: TypeSpec, templateBindings?: TemplateBindings): StructDecl | null;
  fieldOf(type: TypeSpec, member: string, templateBindings?: TemplateBindings): FieldLayout | null;
  typeKeyOf(type: TypeSpec): string;
  containerLayout(name: string, callArguments: TypeSpec[], templateBindings?: TemplateBindings): StructLayout;
  bindContainer(name: string, callArguments: TypeSpec[], templateBindings?: TemplateBindings): TemplateBindings;
  staticConstsOf(name: string, templateBindings: TemplateBindings): Map<string, bigint>;
  evalConstNum(expression: Expression, templateBindings: TemplateBindings): number;
  methodOwnerNames(name: string, seen?: Set<string>): string[];
  baseTemplateName(type: TypeSpec): string | null;
  hasInstanceMethod(name: string, methodName: string): boolean;
  resolveSourceMethodDefinition(ownerTypeName: string, ownerTemplateArguments: TypeSpec[], methodName: string, methodArgumentCount?: number, parameterTypeDiscriminator?: string): ResolvedSourceMethod | null;
  buildMethodSpecializationKey(methodName: string, methodArgumentCount: number | undefined, ownerTemplateArguments: TypeSpec[], ownerBindings: TemplateBindings): string | undefined;
  buildMethodOverloadKey(methodName: string, methodArgumentCount: number | undefined, parameterTypeDiscriminator: string | undefined): string | undefined;
  hashContainerOffsets(name: string, callArguments: TypeSpec[], templateBindings: TemplateBindings, capacity: number): {
        elemSize: number;
        occBase: number;
        popOff: number;
        totalSize: number;
    } | null;
  hashmapInfo(callArguments: TypeSpec[], templateBindings?: TemplateBindings): ContainerLayoutMetadata | null;
  hashsetInfo(callArguments: TypeSpec[], templateBindings?: TemplateBindings): ContainerLayoutMetadata | null;
  arrayInfo(callArguments: TypeSpec[], templateBindings?: TemplateBindings): ContainerLayoutMetadata | null;
  collectionInfo(callArguments: TypeSpec[], templateBindings?: TemplateBindings): {
        L: number;
        elementsOff: number;
        stride: number;
        valueOff: number;
        elemType: TypeSpec;
    } | null;
  linkedListInfo(callArguments: TypeSpec[], templateBindings?: TemplateBindings): {
        L: number;
        nodesOff: number;
        stride: number;
        valueOff: number;
        elemType: TypeSpec;
    } | null;
  warn(message: string, at: number | Span): void;
  error(message: string, at: number | Span): void;
}
