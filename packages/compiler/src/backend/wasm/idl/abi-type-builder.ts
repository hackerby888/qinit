// Maps a resolved TypeSpec or struct layout onto the IDL's AbiType tree, including QPI containers.
import {
    AbiScalarKind,
    AbiTypeKind,
    formatAbiType,
    type AbiArray,
    type AbiBitArray,
    type AbiCollection,
    type AbiField,
    type AbiHashMap,
    type AbiHashSet,
    type AbiLinkedList,
    type AbiScalar,
    type AbiStruct,
    type AbiType,
} from "@qinit/proto/contract-idl";
import { bitWordCount, collectionFmt, hashMapFmt, hashSetFmt, linkedListFmt } from "@qinit/proto/qpi-layout";
import { AstKind } from "../../../shared/enums";
import type { StructDecl, TypeSpec } from "../../../ast";
import { EMPTY_TEMPLATE_BINDINGS, type StructLayout, type TemplateBindings } from "../../../semantics/types";
import type { ProgramAnalysis } from "../../../semantics/program-analysis";
import { evalIntegralConst } from "../../../frontend/validation/validation-helpers";
import { scalarKindForName, scalarKindForSize } from "./scalars";

export class AbiTypeBuilder {
    constructor(private readonly programAnalysis: ProgramAnalysis) {}

    entryType(name: string, layout: StructLayout, declaration?: StructDecl): AbiType {
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
            format: type.fields.map((field) => formatAbiType(field.type)).join(", "),
        };
    }

    namedStruct(name: string, layout: StructLayout, root: boolean, declaration?: StructDecl): AbiStruct {
        return this.struct(name, layout, root, EMPTY_TEMPLATE_BINDINGS, declaration);
    }

    type(sourceType: TypeSpec, bindings: TemplateBindings = EMPTY_TEMPLATE_BINDINGS): AbiType {
        const type = this.programAnalysis.derefType(sourceType);

        if (type.kind === AstKind.CONST) {
            return this.type(type.valueType, bindings);
        }

        if (type.kind === AstKind.ARRAY) {
            const count = this.programAnalysis.evalConst(type.size, bindings);
            const dimensionType: TypeSpec = {
                kind: AstKind.EXPR_VALUE,
                expression: type.size,
                span: type.span,
            };
            this.validateDimension("array length", count, dimensionType, bindings);
            return this.array(type.element, count, sourceType, bindings);
        }

        if (type.kind === AstKind.INLINE_STRUCT) {
            const layout = this.programAnalysis.layoutOf(type.struct);
            return this.struct(type.struct.name, layout, false, bindings, type.struct);
        }

        if (type.kind === AstKind.TEMPLATE_INSTANCE) {
            return this.template(type, bindings);
        }

        if (type.kind === AstKind.DEPENDENT_MEMBER) {
            const resolved = this.programAnalysis.resolveDependentMember(type, bindings);

            if (resolved) {
                return this.type(resolved.type, resolved.bindings);
            }
        }

        if (type.kind === AstKind.NAME) {
            return this.namedType(type, bindings);
        }

        return this.scalar(AbiScalarKind.UINT32, this.programAnalysis.sizeOfType(type, bindings), this.programAnalysis.alignOfType(type, bindings));
    }

    private namedType(type: Extract<TypeSpec, { kind: AstKind.NAME }>, bindings: TemplateBindings): AbiType {
        const unqualifiedName = type.name.split("::").pop()!;
        const scalarKind = scalarKindForName(unqualifiedName);

        if (scalarKind) {
            return this.scalar(scalarKind, this.programAnalysis.sizeOfType(type, bindings), this.programAnalysis.alignOfType(type, bindings));
        }

        if (unqualifiedName === "DateAndTime") {
            return this.scalar(AbiScalarKind.UINT64, 8, 8);
        }

        const enumUnderlying = this.programAnalysis.enumUnderlying.get(type.name) ?? this.programAnalysis.enumUnderlying.get(unqualifiedName);

        if (enumUnderlying || this.programAnalysis.enumNames.has(type.name) || this.programAnalysis.enumNames.has(unqualifiedName)) {
            const underlyingName = enumUnderlying?.kind === AstKind.NAME ? enumUnderlying.name : "sint32";
            const underlying = scalarKindForName(underlyingName) ?? AbiScalarKind.SINT32;
            return this.scalar(underlying, this.programAnalysis.sizeOfType(type, bindings), this.programAnalysis.alignOfType(type, bindings));
        }

        const resolved = this.programAnalysis.resolveType(type, bindings);

        if (resolved.kind !== AstKind.NAME || resolved.name !== type.name) {
            return this.type(resolved, bindings);
        }

        const layout = this.programAnalysis.layoutOfType(type, bindings);

        if (layout) {
            return this.struct(unqualifiedName, layout, false, bindings, this.programAnalysis.structOf(type, bindings) ?? undefined);
        }

        return this.scalar(
            scalarKindForSize(this.programAnalysis.sizeOfType(type, bindings)),
            this.programAnalysis.sizeOfType(type, bindings),
            this.programAnalysis.alignOfType(type, bindings),
        );
    }

    private template(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiType {
        const name = type.name.split("::").pop()!;

        if (name === "Array" || name === "SlowAnySizeArray") {
            const count = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings));
            if (name === "Array") {
                this.validatePowerOfTwoDimension("Array length", count, type.callArguments[1], bindings);
            } else {
                this.validatePositiveDimension("SlowAnySizeArray length", count, type.callArguments[1], bindings);
            }
            return this.array(type.callArguments[0], count, type, bindings);
        }

        if (name === "BitArray") {
            return this.bitArray(type, bindings);
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

        if (name === "LinkedList") {
            return this.linkedList(type, bindings);
        }

        const layout = this.programAnalysis.layoutOfType(type, bindings) ?? this.programAnalysis.containerLayout(type.name, type.callArguments, bindings);
        const templateBindings = this.programAnalysis.bindContainer(type.name, type.callArguments, bindings);
        return this.struct(name, layout, false, templateBindings);
    }

    private array(elementType: TypeSpec, count: number, sourceType: TypeSpec, bindings: TemplateBindings): AbiArray {
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

    private bitArray(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiBitArray {
        const bitCount = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[0], bindings));
        this.validatePowerOfTwoDimension("BitArray bit count", bitCount, type.callArguments[0], bindings);
        return {
            kind: AbiTypeKind.BIT_ARRAY,
            bitCount,
            size: this.programAnalysis.sizeOfType(type, bindings),
            align: this.programAnalysis.alignOfType(type, bindings),
            format: `[${bitWordCount(bitCount)};uint64]`,
        };
    }

    private hashMap(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiHashMap {
        const capacity = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[2], bindings));
        this.validatePowerOfTwoDimension("HashMap capacity", capacity, type.callArguments[2], bindings);
        const key = this.type(type.callArguments[0], bindings);
        const value = this.type(type.callArguments[1], bindings);
        return {
            kind: AbiTypeKind.HASH_MAP,
            capacity,
            key,
            value,
            size: this.programAnalysis.sizeOfType(type, bindings),
            align: this.programAnalysis.alignOfType(type, bindings),
            format: hashMapFmt(formatAbiType(key), formatAbiType(value), capacity),
        };
    }

    private hashSet(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiHashSet {
        const capacity = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings));
        this.validatePowerOfTwoDimension("HashSet capacity", capacity, type.callArguments[1], bindings);
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

    private collection(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiCollection {
        const capacity = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings));
        this.validatePowerOfTwoDimension("Collection capacity", capacity, type.callArguments[1], bindings);
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

    private linkedList(type: Extract<TypeSpec, { kind: AstKind.TEMPLATE_INSTANCE }>, bindings: TemplateBindings): AbiLinkedList {
        const capacity = Number(this.programAnalysis.valueOfTypeArg(type.callArguments[1], bindings));
        this.validatePowerOfTwoDimension("LinkedList capacity", capacity, type.callArguments[1], bindings);
        const value = this.type(type.callArguments[0], bindings);
        return {
            kind: AbiTypeKind.LINKED_LIST,
            capacity,
            value,
            size: this.programAnalysis.sizeOfType(type, bindings),
            align: this.programAnalysis.alignOfType(type, bindings),
            format: linkedListFmt(formatAbiType(value), capacity),
        };
    }

    private struct(name: string | undefined, layout: StructLayout, root: boolean, bindings: TemplateBindings, declaration?: StructDecl): AbiStruct {
        const localBindings = declaration ? withLocalStructs(declaration, bindings) : bindings;
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
            format: root || body.length === 0 ? body : `{ ${body} }`,
        };
    }

    private scalar(scalar: AbiScalarKind, size: number, align: number): AbiScalar {
        return {
            kind: AbiTypeKind.SCALAR,
            scalar,
            size,
            align: Math.max(1, align),
            format: scalar,
        };
    }

    private validateDimension(label: string, value: number, sourceType: TypeSpec, bindings: TemplateBindings): void {
        if (Number.isSafeInteger(value) && value >= 0 && this.dimensionResolves(sourceType, bindings)) {
            return;
        }

        this.programAnalysis.error(`${label} '${dimensionLabel(sourceType, value)}' must resolve to a non-negative integer`, sourceType.span ?? 0);
    }

    private validatePowerOfTwoDimension(label: string, value: number, sourceType: TypeSpec, bindings: TemplateBindings): void {
        if (isPowerOfTwo(value) && this.dimensionResolves(sourceType, bindings)) {
            return;
        }

        this.programAnalysis.error(`${label} '${dimensionLabel(sourceType, value)}' must resolve to a positive power-of-two integer`, sourceType.span ?? 0);
    }

    private validatePositiveDimension(label: string, value: number, sourceType: TypeSpec, bindings: TemplateBindings): void {
        if (Number.isSafeInteger(value) && value > 0 && this.dimensionResolves(sourceType, bindings)) {
            return;
        }

        this.programAnalysis.error(`${label} '${dimensionLabel(sourceType, value)}' must resolve to a positive integer`, sourceType.span ?? 0);
    }

    private dimensionResolves(sourceType: TypeSpec, bindings: TemplateBindings): boolean {
        if (sourceType.kind === AstKind.NAME) {
            return this.resolvedConstant(sourceType.name, bindings, new Set()) !== null;
        }

        if (sourceType.kind !== AstKind.EXPR_VALUE) {
            return false;
        }

        return evalIntegralConst(sourceType.expression, (name) => this.resolvedConstant(name, bindings, new Set())) !== null;
    }

    private resolvedConstant(name: string, bindings: TemplateBindings, resolving: Set<string>): bigint | null {
        const bound = bindings.values.get(name);
        if (bound !== undefined) {
            return bound;
        }

        if (resolving.has(name)) {
            return null;
        }

        const tail = name.split("::").pop()!;
        const initializer = this.programAnalysis.constexprInit.get(name) ?? this.programAnalysis.constexprInit.get(tail);
        if (!initializer) {
            return this.programAnalysis.resolveConst(name, bindings);
        }

        resolving.add(name);
        const value = evalIntegralConst(initializer, (dependency) => this.resolvedConstant(dependency, bindings, resolving));
        resolving.delete(name);
        return value === null ? null : this.programAnalysis.resolveConst(name, bindings);
    }
}

function isPowerOfTwo(value: number): boolean {
    if (!Number.isSafeInteger(value) || value <= 0) {
        return false;
    }
    const integer = BigInt(value);
    return (integer & (integer - 1n)) === 0n;
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

function withLocalStructs(declaration: StructDecl, bindings: TemplateBindings): TemplateBindings {
    const structs = new Map(bindings.structs);

    for (const member of declaration.members) {
        if (member.kind === AstKind.STRUCT && member.name && member.hasBody !== false) {
            structs.set(member.name, member as StructDecl);
        }
    }

    return {
        types: bindings.types,
        values: bindings.values,
        structs,
    };
}

// A template parameter or a named constant reads better as its name; a literal or an arithmetic
// expression has no name worth showing, so name it by what it resolved to.
function dimensionLabel(type: TypeSpec, value: number): string {
    const named = typeLabel(type);
    return named === "unknown" && Number.isFinite(value) ? String(value) : named;
}

function typeLabel(type: TypeSpec): string {
    if (type.kind === AstKind.NAME) {
        return type.name;
    }

    if (type.kind === AstKind.EXPR_VALUE && type.expression.kind === AstKind.IDENTIFIER) {
        return type.expression.name;
    }

    return "unknown";
}
