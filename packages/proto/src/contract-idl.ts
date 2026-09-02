import { roundUp } from "@qinit/core";
import {
    arrayGeometry,
    bitArrayGeometry,
    bitWordCount,
    collectionGeometry,
    collectionFmt,
    hashMapGeometry,
    hashMapFmt,
    hashSetGeometry,
    hashSetFmt,
    linkedListFmt,
    linkedListGeometry,
} from "./qpi-layout";

export const QINIT_IDL_VERSION = 5 as const;

export enum AbiTypeKind {
    SCALAR = "scalar",
    STRUCT = "struct",
    ARRAY = "array",
    BIT_ARRAY = "bit_array",
    COLLECTION = "collection",
    HASH_MAP = "hash_map",
    HASH_SET = "hash_set",
    LINKED_LIST = "linked_list",
}

export enum AbiScalarKind {
    BIT = "bit",
    ID = "id",
    M256I = "m256i",
    UINT8 = "uint8",
    UINT16 = "uint16",
    UINT32 = "uint32",
    UINT64 = "uint64",
    UINT128 = "uint128",
    SINT8 = "sint8",
    SINT16 = "sint16",
    SINT32 = "sint32",
    SINT64 = "sint64",
    SINT128 = "sint128",
}

export enum AbiContainerKind {
    ARRAY = "array",
    BIT_ARRAY = "bit_array",
    COLLECTION = "collection",
    HASH_MAP = "hash_map",
    HASH_SET = "hash_set",
    LINKED_LIST = "linked_list",
}

interface AbiTypeBase {
    size: number;
    align: number;
    format: string;
}

export interface AbiScalar extends AbiTypeBase {
    kind: AbiTypeKind.SCALAR;
    scalar: AbiScalarKind;
}

export interface AbiStruct extends AbiTypeBase {
    kind: AbiTypeKind.STRUCT;
    name?: string;
    fields: AbiField[];
}

export interface AbiArray extends AbiTypeBase {
    kind: AbiTypeKind.ARRAY;
    count: number;
    element: AbiType;
}

export interface AbiBitArray extends AbiTypeBase {
    kind: AbiTypeKind.BIT_ARRAY;
    bitCount: number;
}

export interface AbiCollection extends AbiTypeBase {
    kind: AbiTypeKind.COLLECTION;
    capacity: number;
    value: AbiType;
}

export interface AbiHashMap extends AbiTypeBase {
    kind: AbiTypeKind.HASH_MAP;
    capacity: number;
    key: AbiType;
    value: AbiType;
}

export interface AbiHashSet extends AbiTypeBase {
    kind: AbiTypeKind.HASH_SET;
    capacity: number;
    key: AbiType;
}

export interface AbiLinkedList extends AbiTypeBase {
    kind: AbiTypeKind.LINKED_LIST;
    capacity: number;
    value: AbiType;
}

export type AbiType = AbiScalar | AbiStruct | AbiArray | AbiBitArray | AbiCollection | AbiHashMap | AbiHashSet | AbiLinkedList;

export interface AbiField {
    name: string;
    offset: number;
    size: number;
    type: AbiType;
}

export interface ContractEntry {
    name: string;
    inputType: number;
    inSize: number;
    outSize: number;
    input: AbiType;
    output: AbiType;
    notification?: boolean; // oracle-reply callback: the node dispatches it, users never invoke it
}

export interface ContractEnum {
    name: string;
    underlying: AbiScalarKind;
    members: Record<string, string>;
}

export interface ContractLog {
    name: string;
    type: AbiStruct;
}

// One argument of a CC_PRINT call. A literal part carries its text and emits no code; a value part
// carries the type the bytes on the wire decode as, plus the argument's own source text as its label.
export interface ContractCheatPart {
    lit?: string;
    type?: AbiType;
    expr?: string;
}

// A CC_PRINT call site. `id` is the line the contract tags its records with, so the two compilers agree
// without sharing a counter; a line therefore holds at most one print.
export interface ContractCheat {
    id: number;
    line: number;
    parts: ContractCheatPart[];
}

export interface ContractMigration {
    oldState: AbiStruct;
}

export interface ContractIdl {
    version: typeof QINIT_IDL_VERSION;
    name: string;
    slot: number;
    functions: ContractEntry[];
    procedures: ContractEntry[];
    state: AbiStruct;
    sysprocMask: number;
    enums: ContractEnum[];
    logs: ContractLog[];
    cheats: ContractCheat[];
    migration?: ContractMigration;
    dependencies: string[];
}

export interface ContractIdlArtifact extends ContractIdl {
    codeHash?: string;
    debugWasm?: string;
    linesJson?: string;
}

export interface ContractIdlFile {
    version: typeof QINIT_IDL_VERSION;
    contracts: Record<string, ContractIdlArtifact>;
}

export function formatAbiType(type: AbiType): string {
    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            return type.scalar;
        case AbiTypeKind.STRUCT: {
            const fields = type.fields.map((field) => formatAbiType(field.type)).join(", ");
            return fields ? `{ ${fields} }` : "{}";
        }
        case AbiTypeKind.ARRAY:
            return `[${type.count};${formatAbiType(type.element)}]`;
        case AbiTypeKind.BIT_ARRAY:
            return `[${bitWordCount(type.bitCount)};uint64]`;
        case AbiTypeKind.COLLECTION:
            return collectionFmt(formatAbiType(type.value), type.capacity);
        case AbiTypeKind.HASH_MAP:
            return hashMapFmt(formatAbiType(type.key), formatAbiType(type.value), type.capacity);
        case AbiTypeKind.HASH_SET:
            return hashSetFmt(formatAbiType(type.key), type.capacity);
        case AbiTypeKind.LINKED_LIST:
            return linkedListFmt(formatAbiType(type.value), type.capacity);
    }
}

export function abiTypeContainsKind(type: AbiType, kind: AbiTypeKind): boolean {
    if (type.kind === kind) {
        return true;
    }
    switch (type.kind) {
        case AbiTypeKind.STRUCT:
            return type.fields.some((field) => abiTypeContainsKind(field.type, kind));
        case AbiTypeKind.ARRAY:
            return abiTypeContainsKind(type.element, kind);
        case AbiTypeKind.COLLECTION:
        case AbiTypeKind.LINKED_LIST:
            return abiTypeContainsKind(type.value, kind);
        case AbiTypeKind.HASH_MAP:
            return abiTypeContainsKind(type.key, kind) || abiTypeContainsKind(type.value, kind);
        case AbiTypeKind.HASH_SET:
            return abiTypeContainsKind(type.key, kind);
        default:
            return false;
    }
}

// Containers the protocol forbids in a contract's public interface — they can carry inconsistent
// internal state across the call boundary (core-lite `doc/contracts.md`, "Restrictions").
const FORBIDDEN_PUBLIC_TYPES: readonly (readonly [AbiTypeKind, string])[] = [
    [AbiTypeKind.COLLECTION, "Collection"],
    [AbiTypeKind.HASH_MAP, "HashMap"],
    [AbiTypeKind.HASH_SET, "HashSet"],
    [AbiTypeKind.LINKED_LIST, "LinkedList"],
];

export function forbiddenPublicType(type: AbiType): string | undefined {
    return FORBIDDEN_PUBLIC_TYPES.find(([kind]) => abiTypeContainsKind(type, kind))?.[1];
}

export function parseContractIdl(value: unknown): ContractIdl {
    return parseContract(value, "IDL");
}

export function parseContractIdlFile(value: unknown): ContractIdlFile {
    const file = objectValue(value, "IDL file");
    exactVersion(file, "IDL file");
    const contracts = objectValue(file.contracts, "IDL file contracts");
    const parsed: Record<string, ContractIdlArtifact> = {};

    for (const [slot, contract] of Object.entries(contracts)) {
        if (!/^(0|[1-9]\d*)$/.test(slot)) {
            throw new Error(`IDL file contract key '${slot}' is not a slot`);
        }
        const artifact = parseContract(contract, `IDL contract ${slot}`) as ContractIdlArtifact;
        if (artifact.slot !== Number(slot)) {
            throw new Error(`IDL contract ${slot} stores slot ${artifact.slot}`);
        }
        const source = objectValue(contract, `IDL contract ${slot}`);
        optionalString(source, "codeHash");
        optionalString(source, "debugWasm");
        optionalString(source, "linesJson");
        artifact.codeHash = source.codeHash as string | undefined;
        artifact.debugWasm = source.debugWasm as string | undefined;
        artifact.linesJson = source.linesJson as string | undefined;
        parsed[slot] = artifact;
    }

    return {
        version: QINIT_IDL_VERSION,
        contracts: parsed,
    };
}

function parseContract(value: unknown, label: string): ContractIdl {
    const contract = objectValue(value, label);
    exactVersion(contract, label);
    const name = stringValue(contract.name, `${label} name`);
    const slot = uintValue(contract.slot, `${label} slot`);
    const functions = entryArray(contract.functions, `${label} functions`);
    const procedures = entryArray(contract.procedures, `${label} procedures`);
    const state = abiStruct(contract.state, `${label} state`);
    const sysprocMask = uintValue(contract.sysprocMask, `${label} sysprocMask`);
    const enums = arrayValue(contract.enums, `${label} enums`).map((item, index) => contractEnum(item, `${label} enum ${index}`));
    const logs = arrayValue(contract.logs, `${label} logs`).map((item, index) => contractLog(item, `${label} log ${index}`));
    const cheats = arrayValue(contract.cheats, `${label} cheats`).map((item, index) => contractCheat(item, `${label} cheat ${index}`));
    const dependencies = arrayValue(contract.dependencies, `${label} dependencies`).map((item, index) => stringValue(item, `${label} dependency ${index}`));
    const migration = contract.migration === undefined ? undefined : contractMigration(contract.migration, `${label} migration`);

    return {
        version: QINIT_IDL_VERSION,
        name,
        slot,
        functions,
        procedures,
        state,
        sysprocMask,
        enums,
        logs,
        cheats,
        migration,
        dependencies,
    };
}

function entryArray(value: unknown, label: string): ContractEntry[] {
    const entries = arrayValue(value, label).map((item, index) => contractEntry(item, `${label} ${index}`));
    const ids = new Set<number>();
    for (const entry of entries) {
        if (ids.has(entry.inputType)) {
            throw new Error(`${label} repeats inputType ${entry.inputType}`);
        }
        ids.add(entry.inputType);
    }
    return entries;
}

function contractEntry(value: unknown, label: string): ContractEntry {
    const entry = objectValue(value, label);
    const input = entryAbiType(entry.input, `${label} input`);
    const output = entryAbiType(entry.output, `${label} output`);
    const inSize = uintValue(entry.inSize, `${label} inSize`);
    const outSize = uintValue(entry.outSize, `${label} outSize`);

    if (input.size !== inSize) {
        throw new Error(`${label} inSize ${inSize} does not match input size ${input.size}`);
    }
    if (output.size !== outSize) {
        throw new Error(`${label} outSize ${outSize} does not match output size ${output.size}`);
    }

    return {
        name: stringValue(entry.name, `${label} name`),
        inputType: uintValue(entry.inputType, `${label} inputType`),
        inSize,
        outSize,
        input,
        output,
        ...(entry.notification === true ? { notification: true } : {}),
    };
}

function entryAbiType(value: unknown, label: string): AbiType {
    const type = abiType(value, label);

    if (type.kind !== AbiTypeKind.STRUCT) {
        return type;
    }

    return {
        ...type,
        format: type.fields.map((field) => formatAbiType(field.type)).join(", "),
    };
}

function contractEnum(value: unknown, label: string): ContractEnum {
    const entry = objectValue(value, label);
    const underlying = stringValue(entry.underlying, `${label} underlying`) as AbiScalarKind;
    if (!Object.values(AbiScalarKind).includes(underlying)) {
        throw new Error(`${label} has unknown scalar '${underlying}'`);
    }
    const rawMembers = objectValue(entry.members, `${label} members`);
    const members: Record<string, string> = {};
    for (const [number, name] of Object.entries(rawMembers)) {
        if (!/^-?\d+$/.test(number)) {
            throw new Error(`${label} member key '${number}' is not an integer`);
        }
        members[number] = stringValue(name, `${label} member ${number}`);
    }
    return {
        name: stringValue(entry.name, `${label} name`),
        underlying,
        members,
    };
}

function contractLog(value: unknown, label: string): ContractLog {
    const entry = objectValue(value, label);
    return {
        name: stringValue(entry.name, `${label} name`),
        type: abiStruct(entry.type, `${label} type`, true),
    };
}

function contractCheat(value: unknown, label: string): ContractCheat {
    const entry = objectValue(value, label);
    return {
        id: uintValue(entry.id, `${label} id`),
        line: uintValue(entry.line, `${label} line`),
        parts: arrayValue(entry.parts, `${label} parts`).map((item, index) => {
            const part = objectValue(item, `${label} part ${index}`);
            return part.lit === undefined
                ? { type: abiType(part.type, `${label} part ${index} type`, true), expr: stringValue(part.expr, `${label} part ${index} expr`) }
                : { lit: stringValue(part.lit, `${label} part ${index} lit`) };
        }),
    };
}

function contractMigration(value: unknown, label: string): ContractMigration {
    const migration = objectValue(value, label);
    return {
        oldState: abiStruct(migration.oldState, `${label} oldState`),
    };
}

function abiStruct(value: unknown, label: string, allowUnpaddedTail = false): AbiStruct {
    const type = abiType(value, label, allowUnpaddedTail);
    if (type.kind !== AbiTypeKind.STRUCT) {
        throw new Error(`${label} must be a struct`);
    }
    return {
        ...type,
        format: type.fields.map((field) => formatAbiType(field.type)).join(", "),
    };
}

function abiType(value: unknown, label: string, allowUnpaddedTail = false): AbiType {
    const raw = objectValue(value, label);
    const kind = stringValue(raw.kind, `${label} kind`) as AbiTypeKind;
    const common = {
        size: uintValue(raw.size, `${label} size`),
        align: positiveUintValue(raw.align, `${label} align`),
        format: stringValue(raw.format, `${label} format`),
    };

    let type: AbiType;
    switch (kind) {
        case AbiTypeKind.SCALAR: {
            const scalar = stringValue(raw.scalar, `${label} scalar`) as AbiScalarKind;
            if (!Object.values(AbiScalarKind).includes(scalar)) {
                throw new Error(`${label} has unknown scalar '${scalar}'`);
            }
            type = { kind, scalar, ...common };
            break;
        }
        case AbiTypeKind.STRUCT: {
            const fields = arrayValue(raw.fields, `${label} fields`).map((item, index) => abiField(item, `${label} field ${index}`));
            const name = raw.name === undefined ? undefined : stringValue(raw.name, `${label} name`);
            type = { kind, name, fields, ...common };
            break;
        }
        case AbiTypeKind.ARRAY:
            type = {
                kind,
                count: uintValue(raw.count, `${label} count`),
                element: abiType(raw.element, `${label} element`),
                ...common,
            };
            break;
        case AbiTypeKind.BIT_ARRAY:
            type = {
                kind,
                bitCount: uintValue(raw.bitCount, `${label} bitCount`),
                ...common,
            };
            break;
        case AbiTypeKind.COLLECTION:
            type = {
                kind,
                capacity: uintValue(raw.capacity, `${label} capacity`),
                value: abiType(raw.value, `${label} value`),
                ...common,
            };
            break;
        case AbiTypeKind.HASH_MAP:
            type = {
                kind,
                capacity: uintValue(raw.capacity, `${label} capacity`),
                key: abiType(raw.key, `${label} key`),
                value: abiType(raw.value, `${label} value`),
                ...common,
            };
            break;
        case AbiTypeKind.HASH_SET:
            type = {
                kind,
                capacity: uintValue(raw.capacity, `${label} capacity`),
                key: abiType(raw.key, `${label} key`),
                ...common,
            };
            break;
        case AbiTypeKind.LINKED_LIST:
            type = {
                kind,
                capacity: uintValue(raw.capacity, `${label} capacity`),
                value: abiType(raw.value, `${label} value`),
                ...common,
            };
            break;
        default:
            throw new Error(`${label} has unknown kind '${kind}'`);
    }

    validateAbiType(type, label, allowUnpaddedTail);
    return {
        ...type,
        format: formatAbiType(type),
    } as AbiType;
}

function abiField(value: unknown, label: string): AbiField {
    const field = objectValue(value, label);
    const type = abiType(field.type, `${label} type`);
    const size = uintValue(field.size, `${label} size`);
    if (size !== type.size) {
        throw new Error(`${label} size ${size} does not match type size ${type.size}`);
    }
    return {
        name: stringValue(field.name, `${label} name`),
        offset: uintValue(field.offset, `${label} offset`),
        size,
        type,
    };
}

function exactVersion(value: Record<string, unknown>, label: string): void {
    if (value.version !== QINIT_IDL_VERSION) {
        throw new Error(`${label} version must be ${QINIT_IDL_VERSION}`);
    }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
    if (!Array.isArray(value)) {
        throw new Error(`${label} must be an array`);
    }
    return value;
}

function stringValue(value: unknown, label: string): string {
    if (typeof value !== "string") {
        throw new Error(`${label} must be a string`);
    }
    return value;
}

function uintValue(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new Error(`${label} must be a non-negative integer`);
    }
    return Number(value);
}

function positiveUintValue(value: unknown, label: string): number {
    const number = uintValue(value, label);
    if (number === 0) {
        throw new Error(`${label} must be positive`);
    }
    return number;
}

function optionalString(value: Record<string, unknown>, key: string): void {
    if (value[key] !== undefined && typeof value[key] !== "string") {
        throw new Error(`IDL artifact ${key} must be a string`);
    }
}

const SCALAR_LAYOUT: Record<AbiScalarKind, { size: number; align: number }> = {
    [AbiScalarKind.BIT]: { size: 1, align: 1 },
    [AbiScalarKind.ID]: { size: 32, align: 8 },
    [AbiScalarKind.M256I]: { size: 32, align: 8 },
    [AbiScalarKind.UINT8]: { size: 1, align: 1 },
    [AbiScalarKind.UINT16]: { size: 2, align: 2 },
    [AbiScalarKind.UINT32]: { size: 4, align: 4 },
    [AbiScalarKind.UINT64]: { size: 8, align: 8 },
    [AbiScalarKind.UINT128]: { size: 16, align: 8 },
    [AbiScalarKind.SINT8]: { size: 1, align: 1 },
    [AbiScalarKind.SINT16]: { size: 2, align: 2 },
    [AbiScalarKind.SINT32]: { size: 4, align: 4 },
    [AbiScalarKind.SINT64]: { size: 8, align: 8 },
    [AbiScalarKind.SINT128]: { size: 16, align: 8 },
};

function validateAbiType(type: AbiType, label: string, allowUnpaddedTail = false): void {
    if (!isPowerOfTwo(type.align)) {
        throw new Error(`${label} align ${type.align} must be a power of two`);
    }

    switch (type.kind) {
        case AbiTypeKind.SCALAR:
            assertLayout(type, SCALAR_LAYOUT[type.scalar], label);
            return;
        case AbiTypeKind.STRUCT:
            validateStruct(type, label, allowUnpaddedTail);
            return;
        case AbiTypeKind.ARRAY:
            assertLayout(type, arrayGeometry(type.element, type.count), label);
            return;
        case AbiTypeKind.BIT_ARRAY:
            validatePositivePowerOfTwo(type.bitCount, `${label} bitCount`);
            assertLayout(type, bitArrayGeometry(type.bitCount), label);
            return;
        case AbiTypeKind.COLLECTION:
            validatePositivePowerOfTwo(type.capacity, `${label} capacity`);
            assertLayout(type, collectionGeometry(type.value, type.capacity), label);
            return;
        case AbiTypeKind.HASH_MAP:
            validatePositivePowerOfTwo(type.capacity, `${label} capacity`);
            assertLayout(type, hashMapGeometry(type.key, type.value, type.capacity), label);
            return;
        case AbiTypeKind.HASH_SET:
            validatePositivePowerOfTwo(type.capacity, `${label} capacity`);
            assertLayout(type, hashSetGeometry(type.key, type.capacity), label);
            return;
        case AbiTypeKind.LINKED_LIST:
            validatePositivePowerOfTwo(type.capacity, `${label} capacity`);
            assertLayout(type, linkedListGeometry(type.value, type.capacity), label);
            return;
    }
}

function validateStruct(type: AbiStruct, label: string, allowUnpaddedTail: boolean): void {
    const names = new Set<string>();
    let end = 0;
    let previousOffset = 0;

    for (const field of type.fields) {
        if (names.has(field.name)) {
            throw new Error(`${label} repeats field '${field.name}'`);
        }
        names.add(field.name);

        if (field.offset % field.type.align !== 0) {
            throw new Error(`${label} field '${field.name}' offset ${field.offset} is not aligned to ${field.type.align}`);
        }
        if (field.offset < previousOffset) {
            throw new Error(`${label} field '${field.name}' offsets are out of order`);
        }

        previousOffset = field.offset;
        const fieldEnd = field.offset + field.size;
        if (!Number.isSafeInteger(fieldEnd) || fieldEnd > type.size) {
            throw new Error(`${label} field '${field.name}' exceeds struct size ${type.size}`);
        }
        end = Math.max(end, fieldEnd);
    }

    const expectedAlign = type.fields.length ? Math.max(...type.fields.map((field) => field.type.align)) : 1;
    const paddedSize = type.fields.length ? roundUp(end, expectedAlign) : 1;
    const sizeIsValid = type.size === paddedSize || (allowUnpaddedTail && type.size === end);
    if (!sizeIsValid) {
        throw new Error(`${label} size ${type.size} must be ${paddedSize}`);
    }
    if (type.align !== expectedAlign) {
        throw new Error(`${label} align ${type.align} must be ${expectedAlign}`);
    }
}

function assertLayout(actual: { size: number; align: number }, expected: { size: number; align: number }, label: string): void {
    if (actual.size !== expected.size) {
        throw new Error(`${label} size ${actual.size} must be ${expected.size}`);
    }
    if (actual.align !== expected.align) {
        throw new Error(`${label} align ${actual.align} must be ${expected.align}`);
    }
}

function validatePositivePowerOfTwo(value: number, label: string): void {
    if (!isPowerOfTwo(value)) {
        throw new Error(`${label} ${value} must be a positive power of two`);
    }
}

function isPowerOfTwo(value: number): boolean {
    if (!Number.isSafeInteger(value) || value <= 0) {
        return false;
    }
    const integer = BigInt(value);
    return (integer & (integer - 1n)) === 0n;
}
