// Hand-built AbiType trees for the codec tests. The layout numbers come from the same qpi-layout
// geometry the validator asserts against, so a builder can never disagree with parseContractIdl.
import {
    AbiScalarKind,
    AbiTypeKind,
    parseContractIdl,
    type AbiArray,
    type AbiBitArray,
    type AbiCollection,
    type AbiHashMap,
    type AbiHashSet,
    type AbiLinkedList,
    type AbiScalar,
    type AbiStruct,
    type AbiType,
    type ContractIdl,
} from "../../src/contract-idl";
import { arrayGeometry, bitArrayGeometry, collectionGeometry, hashMapGeometry, hashSetGeometry, linkedListGeometry } from "../../src/qpi-layout";

const SCALAR_LAYOUT: Record<AbiScalarKind, [size: number, align: number]> = {
    [AbiScalarKind.BIT]: [1, 1],
    [AbiScalarKind.ID]: [32, 8],
    [AbiScalarKind.M256I]: [32, 8],
    [AbiScalarKind.UINT8]: [1, 1],
    [AbiScalarKind.UINT16]: [2, 2],
    [AbiScalarKind.UINT32]: [4, 4],
    [AbiScalarKind.UINT64]: [8, 8],
    [AbiScalarKind.UINT128]: [16, 8],
    [AbiScalarKind.SINT8]: [1, 1],
    [AbiScalarKind.SINT16]: [2, 2],
    [AbiScalarKind.SINT32]: [4, 4],
    [AbiScalarKind.SINT64]: [8, 8],
    [AbiScalarKind.SINT128]: [16, 8],
};

const roundUp = (value: number, align: number) => Math.ceil(value / align) * align;

export const sc = (scalar: AbiScalarKind): AbiScalar => ({
    kind: AbiTypeKind.SCALAR,
    scalar,
    size: SCALAR_LAYOUT[scalar][0],
    align: SCALAR_LAYOUT[scalar][1],
    format: scalar,
});

// Fields are laid out with C alignment and named f0, f1, ... — real offsets rather than hand-typed ones.
export const st = (...types: AbiType[]): AbiStruct => {
    let offset = 0;
    let align = 1;

    const fields = types.map((type, index) => {
        offset = roundUp(offset, type.align);
        const field = { name: `f${index}`, offset, size: type.size, type };
        offset += type.size;
        align = Math.max(align, type.align);
        return field;
    });

    return {
        kind: AbiTypeKind.STRUCT,
        fields,
        size: fields.length ? roundUp(offset, align) : 1,
        align,
        format: "",
    };
};

// A struct whose fields carry the caller's own names, for the tests that assert on field names.
export const named = (...entries: [name: string, type: AbiType][]): AbiStruct => {
    const struct = st(...entries.map(([, type]) => type));
    return {
        ...struct,
        fields: struct.fields.map((field, index) => ({ ...field, name: entries[index][0] })),
    };
};

export const arr = (element: AbiType, count: number): AbiArray => ({
    kind: AbiTypeKind.ARRAY,
    element,
    count,
    ...arrayGeometry(element, count),
    format: "",
});

export const ba = (bitCount: number): AbiBitArray => ({
    kind: AbiTypeKind.BIT_ARRAY,
    bitCount,
    ...bitArrayGeometry(bitCount),
    format: "",
});

export const hm = (key: AbiType, value: AbiType, capacity: number): AbiHashMap => ({
    kind: AbiTypeKind.HASH_MAP,
    key,
    value,
    capacity,
    ...hashMapGeometry(key, value, capacity),
    format: "",
});

export const hs = (key: AbiType, capacity: number): AbiHashSet => ({
    kind: AbiTypeKind.HASH_SET,
    key,
    capacity,
    ...hashSetGeometry(key, capacity),
    format: "",
});

export const co = (value: AbiType, capacity: number): AbiCollection => ({
    kind: AbiTypeKind.COLLECTION,
    value,
    capacity,
    ...collectionGeometry(value, capacity),
    format: "",
});

export const ll = (value: AbiType, capacity: number): AbiLinkedList => ({
    kind: AbiTypeKind.LINKED_LIST,
    value,
    capacity,
    ...linkedListGeometry(value, capacity),
    format: "",
});

export const K = AbiScalarKind;
export const u8 = sc(K.UINT8);
export const u16 = sc(K.UINT16);
export const u32 = sc(K.UINT32);
export const u64 = sc(K.UINT64);
export const u128 = sc(K.UINT128);
export const i8 = sc(K.SINT8);
export const i16 = sc(K.SINT16);
export const i32 = sc(K.SINT32);
export const i64 = sc(K.SINT64);
export const i128 = sc(K.SINT128);
export const id = sc(K.ID);
export const m256i = sc(K.M256I);
export const bit = sc(K.BIT);

export function contractIdl(state: AbiStruct, extra: Partial<ContractIdl> = {}): unknown {
    return {
        version: 5,
        name: "Fixture",
        slot: 1,
        functions: [],
        procedures: [],
        state,
        sysprocMask: 0,
        enums: [],
        logs: [],
        cheats: [],
        dependencies: [],
        ...extra,
    };
}

// Round a hand-built type through the validator, so every test uses the same normalized `format`
// strings the runtime sees — and any builder mistake fails as a validation error, not a wrong assertion.
export function validated<T extends AbiType>(type: T): T {
    const idl = parseContractIdl(contractIdl(st(type)));
    return idl.state.fields[0].type as T;
}
