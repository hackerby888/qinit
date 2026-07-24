import {
  AbiScalarKind,
  AbiTypeKind,
  QINIT_IDL_VERSION,
  formatAbiType,
  type AbiArray,
  type AbiCollection,
  type AbiField,
  type AbiHashMap,
  type AbiHashSet,
  type AbiScalar,
  type AbiStruct,
  type AbiType,
  type ContractEntry,
  type ContractEnum,
  type ContractIdl,
  type ContractLog,
} from "@qinit/proto/contract-idl";
import {
  collectionFmt,
  hashMapFmt,
  hashSetFmt,
} from "@qinit/proto/qpi-layout";
import { AstKind } from "../../../enums";
import type {
  Declaration,
  EnumDecl,
  StructDecl,
  TypeSpec,
  VariableDecl,
} from "../../../ast";
import {
  EMPTY_TEMPLATE_BINDINGS,
  type StructLayout,
  type TemplateBindings,
} from "../../../analysis/types";
import type { ProgramAnalysis } from "../../../analysis/program-analysis";
import type { PreparedContractModule } from "./module-analysis";
import { findMemberFn } from "./contract-discovery";
import { evalIntegralConst } from "../../../frontend/validation/validation-helpers";

export interface BuildContractIdlOptions {
  name: string;
  slot: number;
  dependencies?: readonly string[];
}

export function buildContractIdl(
  prepared: PreparedContractModule,
  options: BuildContractIdlOptions,
): ContractIdl {
  const builder = new AbiTypeBuilder(prepared.programAnalysis);
  const functions: ContractEntry[] = [];
  const procedures: ContractEntry[] = [];

  for (const registration of prepared.registrations) {
    const input = builder.entryType(
      `${registration.fnName}_input`,
      prepared.layouts.resolve(`${registration.fnName}_input`),
      nestedStruct(prepared.contract, `${registration.fnName}_input`),
    );
    const output = builder.entryType(
      `${registration.fnName}_output`,
      prepared.layouts.resolve(`${registration.fnName}_output`),
      nestedStruct(prepared.contract, `${registration.fnName}_output`),
    );
    const entry: ContractEntry = {
      name: registration.fnName,
      inputType: registration.inputType,
      inSize: input.size,
      outSize: output.size,
      input,
      output,
    };

    if (registration.kind === 0) {
      functions.push(entry);
    } else {
      procedures.push(entry);
    }
  }

  const migration = (
    prepared.contract &&
    findMemberFn(prepared.contract, "__impl_migrate")?.body
  )
    ? {
        oldState: builder.namedStruct(
          "OldStateData",
          prepared.layouts.resolve("OldStateData"),
          true,
          nestedStruct(prepared.contract, "OldStateData"),
        ),
      }
    : undefined;

  return {
    version: QINIT_IDL_VERSION,
    name: options.name,
    slot: options.slot,
    functions,
    procedures,
    state: builder.namedStruct(
      "StateData",
      prepared.stateLayout,
      true,
      nestedStruct(prepared.contract, "StateData"),
    ),
    sysprocMask: systemProcedureMask(prepared),
    enums: contractEnums(prepared),
    logs: contractLogs(prepared, builder),
    migration,
    dependencies: uniqueNames(options.dependencies ?? []),
  };
}

class AbiTypeBuilder {
  constructor(private readonly programAnalysis: ProgramAnalysis) {}

  entryType(
    name: string,
    layout: StructLayout,
    declaration?: StructDecl,
  ): AbiType {
    const alias = this.programAnalysis.typedefs.get(name);

    if (!alias) {
      return this.namedStruct(name, layout, true, declaration);
    }

    const type = this.type(alias);
    if (type.kind !== AbiTypeKind.STRUCT) {
      return type;
    }

    return {
      ...type,
      format: type.fields
        .map((field) => formatAbiType(field.type))
        .join(", "),
    };
  }

  namedStruct(
    name: string,
    layout: StructLayout,
    root: boolean,
    declaration?: StructDecl,
  ): AbiStruct {
    return this.struct(
      name,
      layout,
      root,
      EMPTY_TEMPLATE_BINDINGS,
      declaration,
    );
  }

  type(
    sourceType: TypeSpec,
    bindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS,
  ): AbiType {
    const type = this.programAnalysis.derefType(sourceType);

    if (type.kind === AstKind.CONST) {
      return this.type(type.valueType, bindings);
    }

    if (type.kind === AstKind.ARRAY) {
      const count = this.programAnalysis.evalConst(type.size, bindings);
      return this.array(
        type.element,
        count,
        sourceType,
        bindings,
        {
          kind: AstKind.EXPR_VALUE,
          expression: type.size,
          span: type.span,
        },
      );
    }

    if (type.kind === AstKind.INLINE_STRUCT) {
      const layout = this.programAnalysis.layoutOf(type.struct);
      return this.struct(
        type.struct.name,
        layout,
        false,
        bindings,
        type.struct,
      );
    }

    if (type.kind === AstKind.TEMPLATE_INSTANCE) {
      return this.template(type, bindings);
    }

    if (type.kind === AstKind.DEPENDENT_MEMBER) {
      const resolved = this.programAnalysis.resolveDependentMember(
        type,
        bindings,
      );

      if (resolved) {
        return this.type(resolved.type, resolved.bindings);
      }
    }

    if (type.kind === AstKind.NAME) {
      return this.namedType(type, bindings);
    }

    return this.scalar(
      AbiScalarKind.UINT32,
      this.programAnalysis.sizeOfType(type, bindings),
      this.programAnalysis.alignOfType(type, bindings),
    );
  }

  private namedType(
    type: Extract<TypeSpec, { kind: AstKind.NAME }>,
    bindings: TemplateBindings,
  ): AbiType {
    const unqualifiedName = type.name.split("::").pop()!;
    const scalarKind = scalarKindForName(unqualifiedName);

    if (scalarKind) {
      return this.scalar(
        scalarKind,
        this.programAnalysis.sizeOfType(type, bindings),
        this.programAnalysis.alignOfType(type, bindings),
      );
    }

    if (unqualifiedName === "DateAndTime") {
      return this.scalar(AbiScalarKind.UINT64, 8, 8);
    }

    const enumUnderlying = (
      this.programAnalysis.enumUnderlying.get(type.name) ??
      this.programAnalysis.enumUnderlying.get(unqualifiedName)
    );

    if (
      enumUnderlying ||
      this.programAnalysis.enumNames.has(type.name) ||
      this.programAnalysis.enumNames.has(unqualifiedName)
    ) {
      const underlyingName = enumUnderlying?.kind === AstKind.NAME
        ? enumUnderlying.name
        : "sint32";
      const underlying = scalarKindForName(underlyingName) ?? AbiScalarKind.SINT32;
      return this.scalar(
        underlying,
        this.programAnalysis.sizeOfType(type, bindings),
        this.programAnalysis.alignOfType(type, bindings),
      );
    }

    const resolved = this.programAnalysis.resolveType(type, bindings);

    if (
      resolved.kind !== AstKind.NAME ||
      resolved.name !== type.name
    ) {
      return this.type(resolved, bindings);
    }

    const layout = this.programAnalysis.layoutOfType(type, bindings);

    if (layout) {
      return this.struct(
        unqualifiedName,
        layout,
        false,
        bindings,
        this.programAnalysis.structOf(type, bindings) ?? undefined,
      );
    }

    return this.scalar(
      scalarKindForSize(this.programAnalysis.sizeOfType(type, bindings)),
      this.programAnalysis.sizeOfType(type, bindings),
      this.programAnalysis.alignOfType(type, bindings),
    );
  }

  private template(
    type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>,
    bindings: TemplateBindings,
  ): AbiType {
    const name = type.name.split("::").pop()!;

    if (name === "Array" || name === "SlowAnySizeArray") {
      const count = Number(
        this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings),
      );
      return this.array(
        type.callArguments[0],
        count,
        type,
        bindings,
        type.callArguments[1],
      );
    }

    if (name === "BitArray") {
      const bitCount = Number(
        this.programAnalysis.valueOfTypeArg(type.callArguments[0], bindings),
      );
      return this.array(
        { kind: AstKind.NAME, name: "uint64" },
        Math.ceil(bitCount / 64),
        type,
        bindings,
        type.callArguments[0],
      );
    }

    if (name === "HashMap") {
      return this.hashMap(type, bindings);
    }

    if (name === "HashSet") {
      return this.hashSet(type, bindings);
    }

    if (name === "Collection") {
      return this.collection(type, bindings);
    }

    const layout = (
      this.programAnalysis.layoutOfType(type, bindings) ??
      this.programAnalysis.containerLayout(
        type.name,
        type.callArguments,
        bindings,
      )
    );
    const templateBindings = this.programAnalysis.bindContainer(
      type.name,
      type.callArguments,
      bindings,
    );
    return this.struct(name, layout, false, templateBindings);
  }

  private array(
    elementType: TypeSpec,
    count: number,
    sourceType: TypeSpec,
    bindings: TemplateBindings,
    dimensionType: TypeSpec = sourceType,
  ): AbiArray {
    this.validateDimension("array length", count, dimensionType, bindings);
    const element = this.type(elementType, bindings);
    return {
      kind: AbiTypeKind.ARRAY,
      count,
      element,
      size: this.programAnalysis.sizeOfType(sourceType, bindings),
      align: this.programAnalysis.alignOfType(sourceType, bindings),
      format: `[${count};${formatAbiType(element)}]`,
    };
  }

  private hashMap(
    type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>,
    bindings: TemplateBindings,
  ): AbiHashMap {
    const capacity = Number(
      this.programAnalysis.valueOfTypeArg(type.callArguments[2], bindings),
    );
    this.validateDimension(
      "HashMap capacity",
      capacity,
      type.callArguments[2],
      bindings,
    );
    const key = this.type(type.callArguments[0], bindings);
    const value = this.type(type.callArguments[1], bindings);
    return {
      kind: AbiTypeKind.HASH_MAP,
      capacity,
      key,
      value,
      size: this.programAnalysis.sizeOfType(type, bindings),
      align: this.programAnalysis.alignOfType(type, bindings),
      format: hashMapFmt(
        formatAbiType(key),
        formatAbiType(value),
        capacity,
      ),
    };
  }

  private hashSet(
    type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>,
    bindings: TemplateBindings,
  ): AbiHashSet {
    const capacity = Number(
      this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings),
    );
    this.validateDimension(
      "HashSet capacity",
      capacity,
      type.callArguments[1],
      bindings,
    );
    const key = this.type(type.callArguments[0], bindings);
    return {
      kind: AbiTypeKind.HASH_SET,
      capacity,
      key,
      size: this.programAnalysis.sizeOfType(type, bindings),
      align: this.programAnalysis.alignOfType(type, bindings),
      format: hashSetFmt(formatAbiType(key), capacity),
    };
  }

  private collection(
    type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>,
    bindings: TemplateBindings,
  ): AbiCollection {
    const capacity = Number(
      this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings),
    );
    this.validateDimension(
      "Collection capacity",
      capacity,
      type.callArguments[1],
      bindings,
    );
    const value = this.type(type.callArguments[0], bindings);
    return {
      kind: AbiTypeKind.COLLECTION,
      capacity,
      value,
      size: this.programAnalysis.sizeOfType(type, bindings),
      align: this.programAnalysis.alignOfType(type, bindings),
      format: collectionFmt(formatAbiType(value), capacity),
    };
  }

  private struct(
    name: string | undefined,
    layout: StructLayout,
    root: boolean,
    bindings: TemplateBindings,
    declaration?: StructDecl,
  ): AbiStruct {
    const localBindings = declaration
      ? withLocalStructs(declaration, bindings)
      : bindings;
    const fields: AbiField[] = [...layout.fields.values()].map((field) => {
      const type = this.type(field.type, localBindings);
      return {
        name: field.name,
        offset: field.offset,
        size: field.size,
        type: withExactSize(type, field.size),
      };
    });
    const body = fields.map((field) => formatAbiType(field.type)).join(", ");

    return {
      kind: AbiTypeKind.STRUCT,
      ...(name ? { name } : {}),
      fields,
      size: layout.size,
      align: layout.align,
      format: root || body.length === 0
        ? body
        : `{ ${body} }`,
    };
  }

  private scalar(
    scalar: AbiScalarKind,
    size: number,
    align: number,
  ): AbiScalar {
    return {
      kind: AbiTypeKind.SCALAR,
      scalar,
      size,
      align: Math.max(1, align),
      format: scalar,
    };
  }

  private validateDimension(
    label: string,
    value: number,
    sourceType: TypeSpec,
    bindings: TemplateBindings,
  ): void {
    if (
      Number.isSafeInteger(value) &&
      value >= 0 &&
      this.dimensionResolves(sourceType, bindings)
    ) {
      return;
    }

    this.programAnalysis.error(
      `${label} '${typeLabel(sourceType)}' must resolve to a non-negative integer`,
      sourceType.span ?? 0,
    );
  }

  private dimensionResolves(
    sourceType: TypeSpec,
    bindings: TemplateBindings,
  ): boolean {
    if (sourceType.kind === AstKind.NAME) {
      return this.resolvedConstant(
        sourceType.name,
        bindings,
        new Set(),
      ) !== null;
    }

    if (sourceType.kind !== AstKind.EXPR_VALUE) {
      return false;
    }

    return evalIntegralConst(
      sourceType.expression,
      (name) => this.resolvedConstant(name, bindings, new Set()),
    ) !== null;
  }

  private resolvedConstant(
    name: string,
    bindings: TemplateBindings,
    resolving: Set<string>,
  ): bigint | null {
    const bound = bindings.values.get(name);
    if (bound !== undefined) {
      return bound;
    }

    if (resolving.has(name)) {
      return null;
    }

    const tail = name.split("::").pop()!;
    const initializer = (
      this.programAnalysis.constexprInit.get(name) ??
      this.programAnalysis.constexprInit.get(tail)
    );
    if (!initializer) {
      return this.programAnalysis.resolveConst(name, bindings);
    }

    resolving.add(name);
    const value = evalIntegralConst(
      initializer,
      (dependency) => this.resolvedConstant(dependency, bindings, resolving),
    );
    resolving.delete(name);
    return value === null
      ? null
      : this.programAnalysis.resolveConst(name, bindings);
  }
}

function withExactSize(type: AbiType, size: number): AbiType {
  if (type.size === size) {
    return type;
  }

  return {
    ...type,
    size,
  } as AbiType;
}

function systemProcedureMask(prepared: PreparedContractModule): number {
  if (!prepared.contract) {
    return 0;
  }

  let mask = 0;

  for (const member of prepared.contract.members) {
    if (member.kind !== AstKind.FUNCTION) {
      continue;
    }

    const id = prepared.systemProcedureIndex.idsByImplementation.get(
      member.name,
    );

    if (id !== undefined) {
      mask |= 1 << id;
    }
  }

  return mask;
}

function contractEnums(
  prepared: PreparedContractModule,
): ContractEnum[] {
  const enums: ContractEnum[] = [];

  for (const declaration of userDeclarations(prepared)) {
    if (declaration.kind !== AstKind.ENUM || !declaration.name) {
      continue;
    }

    const enumDeclaration = declaration as EnumDecl;
    const name = enumDeclaration.name;

    if (!name) {
      continue;
    }
    const underlyingName = enumDeclaration.underlyingType?.kind === AstKind.NAME
      ? enumDeclaration.underlyingType.name
      : "sint32";
    const underlying = scalarKindForName(underlyingName) ?? AbiScalarKind.SINT32;
    const members: Record<string, string> = {};

    for (const member of enumDeclaration.members) {
      const value = (
        prepared.programAnalysis.resolveConst(
          `${name}::${member.name}`,
        ) ??
        prepared.programAnalysis.resolveConst(member.name)
      );

      if (value !== null) {
        members[value.toString()] = member.name;
      }
    }

    enums.push({
      name,
      underlying,
      members,
    });
  }

  return enums;
}

function contractLogs(
  prepared: PreparedContractModule,
  builder: AbiTypeBuilder,
): ContractLog[] {
  const logs: ContractLog[] = [];

  for (const declaration of userDeclarations(prepared)) {
    if (declaration.kind !== AstKind.STRUCT || !declaration.name) {
      continue;
    }

    const struct = declaration as StructDecl;
    const terminatorIndex = struct.members.findIndex((member) => (
      member.kind === AstKind.VARIABLE &&
      (member as VariableDecl).name === "_terminator"
    ));

    if (terminatorIndex < 0) {
      continue;
    }

    const fullLayout = prepared.programAnalysis.layoutOf(struct);
    const terminator = fullLayout.fields.get("_terminator");

    if (!terminator) {
      continue;
    }

    const fields = new Map(
      [...fullLayout.fields].filter(([name]) => name !== "_terminator"),
    );
    const align = fields.size === 0
      ? 1
      : Math.max(
          ...[...fields.values()].map((field) => (
            prepared.programAnalysis.alignOfType(field.type)
          )),
        );

    logs.push({
      name: struct.name,
      type: builder.namedStruct(
        struct.name,
        {
          size: terminator.offset,
          align,
          fields,
        },
        true,
        struct,
      ),
    });
  }

  return logs;
}

function nestedStruct(
  contract: StructDecl | undefined,
  name: string,
): StructDecl | undefined {
  return contract?.members.find((member) => (
    member.kind === AstKind.STRUCT &&
    member.name === name &&
    member.hasBody !== false
  )) as StructDecl | undefined;
}

function withLocalStructs(
  declaration: StructDecl,
  bindings: TemplateBindings,
): TemplateBindings {
  const structs = new Map(bindings.structs);

  for (const member of declaration.members) {
    if (
      member.kind === AstKind.STRUCT &&
      member.name &&
      member.hasBody !== false
    ) {
      structs.set(member.name, member as StructDecl);
    }
  }

  return {
    types: bindings.types,
    values: bindings.values,
    structs,
  };
}

function userDeclarations(prepared: PreparedContractModule): Declaration[] {
  const declarations: Declaration[] = [];
  const seen = new Set<Declaration>();

  const visit = (items: Declaration[]): void => {
    for (const declaration of items) {
      if (seen.has(declaration)) {
        continue;
      }

      seen.add(declaration);
      declarations.push(declaration);

      if (
        declaration.kind === AstKind.STRUCT ||
        declaration.kind === AstKind.NAMESPACE ||
        declaration.kind === AstKind.EXTERN_BLOCK ||
        declaration.kind === AstKind.CLASS_TEMPLATE
      ) {
        const children = (
          "members" in declaration
            ? declaration.members
            : "body" in declaration && Array.isArray(declaration.body)
              ? declaration.body
              : []
        ) as Declaration[];
        visit(children);
      }
    }
  };

  visit(prepared.declarations);
  return declarations;
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function scalarKindForSize(size: number): AbiScalarKind {
  switch (size) {
    case 1:
      return AbiScalarKind.UINT8;
    case 2:
      return AbiScalarKind.UINT16;
    case 8:
      return AbiScalarKind.UINT64;
    case 16:
      return AbiScalarKind.UINT128;
    case 32:
      return AbiScalarKind.M256I;
    default:
      return AbiScalarKind.UINT32;
  }
}

function typeLabel(type: TypeSpec): string {
  if (type.kind === AstKind.NAME) {
    return type.name;
  }

  if (
    type.kind === AstKind.EXPR_VALUE &&
    type.expression.kind === AstKind.IDENTIFIER
  ) {
    return type.expression.name;
  }

  return "unknown";
}

function scalarKindForName(name: string): AbiScalarKind | undefined {
  const normalized = name.replace(/^QPI::/, "");
  const scalars: Record<string, AbiScalarKind> = {
    bit: AbiScalarKind.BIT,
    id: AbiScalarKind.ID,
    m256i: AbiScalarKind.M256I,
    __m256i: AbiScalarKind.M256I,
    uint8: AbiScalarKind.UINT8,
    uint16: AbiScalarKind.UINT16,
    uint32: AbiScalarKind.UINT32,
    uint64: AbiScalarKind.UINT64,
    uint128: AbiScalarKind.UINT128,
    sint8: AbiScalarKind.SINT8,
    sint16: AbiScalarKind.SINT16,
    sint32: AbiScalarKind.SINT32,
    sint64: AbiScalarKind.SINT64,
    sint128: AbiScalarKind.SINT128,
    bool: AbiScalarKind.UINT8,
    char: AbiScalarKind.SINT8,
    "signed char": AbiScalarKind.SINT8,
    "unsigned char": AbiScalarKind.UINT8,
    short: AbiScalarKind.SINT16,
    "signed short": AbiScalarKind.SINT16,
    "unsigned short": AbiScalarKind.UINT16,
    int: AbiScalarKind.SINT32,
    "signed int": AbiScalarKind.SINT32,
    "unsigned int": AbiScalarKind.UINT32,
    long: AbiScalarKind.SINT64,
    "unsigned long": AbiScalarKind.UINT64,
    "long long": AbiScalarKind.SINT64,
    "signed long long": AbiScalarKind.SINT64,
    "unsigned long long": AbiScalarKind.UINT64,
    size_t: AbiScalarKind.UINT64,
  };

  return scalars[normalized];
}
