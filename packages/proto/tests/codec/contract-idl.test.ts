import { expect, test } from "bun:test";
import { AbiScalarKind, AbiTypeKind, QINIT_IDL_VERSION, formatAbiType, parseContractIdl, parseContractIdlFile, type ContractIdl } from "../../src/contract-idl";

const emptyStruct: ContractIdl["state"] = {
    kind: AbiTypeKind.STRUCT,
    size: 1,
    align: 1,
    format: "",
    fields: [],
};

const idl: ContractIdl = {
    version: QINIT_IDL_VERSION,
    name: "Counter",
    slot: 28,
    functions: [],
    procedures: [],
    state: emptyStruct,
    sysprocMask: 0,
    enums: [],
    logs: [],
        cheats: [],
    dependencies: [],
};

const paddedStruct: ContractIdl["state"] = {
    kind: AbiTypeKind.STRUCT,
    size: 24,
    align: 8,
    format: "stale root format",
    fields: [
        {
            name: "tag",
            offset: 0,
            size: 1,
            type: {
                kind: AbiTypeKind.SCALAR,
                scalar: AbiScalarKind.UINT8,
                size: 1,
                align: 1,
                format: "stale scalar format",
            },
        },
        {
            name: "value",
            offset: 16,
            size: 8,
            type: {
                kind: AbiTypeKind.SCALAR,
                scalar: AbiScalarKind.UINT64,
                size: 8,
                align: 8,
                format: "stale scalar format",
            },
        },
    ],
};

const uint16 = {
    kind: AbiTypeKind.SCALAR,
    scalar: AbiScalarKind.UINT16,
    size: 2,
    align: 2,
    format: "stale",
} as const;

test("parses typed v4 contract and registry IDL", () => {
    expect(parseContractIdl(idl)).toEqual(idl);
    expect(
        parseContractIdlFile({
            version: QINIT_IDL_VERSION,
            contracts: { 28: idl },
        }),
    ).toEqual({
        version: QINIT_IDL_VERSION,
        contracts: { 28: idl },
    });
});

test("parses exact scalar and array entry roots", () => {
    const scalarInput = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "stale",
    } as const;
    const arrayOutput = {
        kind: AbiTypeKind.ARRAY,
        count: 3,
        size: 6,
        align: 2,
        format: "stale",
        element: {
            kind: AbiTypeKind.SCALAR,
            scalar: AbiScalarKind.UINT16,
            size: 2,
            align: 2,
            format: "stale",
        },
    } as const;
    const parsed = parseContractIdl({
        ...idl,
        functions: [
            {
                name: "ExactRoots",
                inputType: 1,
                inSize: 8,
                outSize: 6,
                input: scalarInput,
                output: arrayOutput,
            },
        ],
    });

    expect(parsed.functions[0].input).toEqual({
        ...scalarInput,
        format: "uint64",
    });
    expect(parsed.functions[0].output).toEqual({
        ...arrayOutput,
        format: "[3;uint16]",
        element: {
            ...arrayOutput.element,
            format: "uint16",
        },
    });

    expect(() =>
        parseContractIdl({
            ...idl,
            functions: [
                {
                    name: "WrongSize",
                    inputType: 1,
                    inSize: 4,
                    outSize: 6,
                    input: scalarInput,
                    output: arrayOutput,
                },
            ],
        }),
    ).toThrow(/inSize 4 does not match input size 8/);
});

test("normalizes formats from the authoritative type tree", () => {
    const parsed = parseContractIdl({
        ...idl,
        state: paddedStruct,
    });

    expect(parsed.state.format).toBe("uint8, uint64");
    expect(parsed.state.fields.map((field) => field.type.format)).toEqual(["uint8", "uint64"]);
    expect(formatAbiType(paddedStruct)).toBe("{ uint8, uint64 }");
});

test("parses first-class BitArray and LinkedList physical layouts", () => {
    const parsed = parseContractIdl({
        ...idl,
        state: {
            kind: AbiTypeKind.STRUCT,
            size: 256,
            align: 8,
            format: "wrong",
            fields: [
                {
                    name: "bits",
                    offset: 0,
                    size: 16,
                    type: {
                        kind: AbiTypeKind.BIT_ARRAY,
                        bitCount: 128,
                        size: 16,
                        align: 8,
                        format: "wrong",
                    },
                },
                {
                    name: "items",
                    offset: 16,
                    size: 240,
                    type: {
                        kind: AbiTypeKind.LINKED_LIST,
                        capacity: 8,
                        value: uint16,
                        size: 240,
                        align: 8,
                        format: "wrong",
                    },
                },
            ],
        },
    });

    const [bits, items] = parsed.state.fields.map((field) => field.type);
    expect(bits).toMatchObject({
        kind: AbiTypeKind.BIT_ARRAY,
        bitCount: 128,
        size: 16,
        align: 8,
        format: "[2;uint64]",
    });
    expect(items).toMatchObject({
        kind: AbiTypeKind.LINKED_LIST,
        capacity: 8,
        size: 240,
        align: 8,
    });
    expect(items.format).toBe("{ [8;{ uint16, sint64, sint64 }], [1;uint64], sint64, sint64, sint64, uint64, uint64 }");
});

test("rejects invalid BitArray and LinkedList dimensions and layouts", () => {
    const stateWith = (type: unknown) => ({
        ...idl,
        state: {
            kind: AbiTypeKind.STRUCT,
            size: 8,
            align: 8,
            format: "wrong",
            fields: [{ name: "value", offset: 0, size: 8, type }],
        },
    });

    expect(() =>
        parseContractIdl(
            stateWith({
                kind: AbiTypeKind.BIT_ARRAY,
                bitCount: 3,
                size: 8,
                align: 8,
                format: "wrong",
            }),
        ),
    ).toThrow(/positive power of two/);
    expect(() =>
        parseContractIdl(
            stateWith({
                kind: AbiTypeKind.BIT_ARRAY,
                bitCount: 2 ** 51 + 1,
                size: 8,
                align: 8,
                format: "wrong",
            }),
        ),
    ).toThrow(/positive power of two/);
    expect(() =>
        parseContractIdl(
            stateWith({
                kind: AbiTypeKind.LINKED_LIST,
                capacity: 3,
                value: uint16,
                size: 8,
                align: 8,
                format: "wrong",
            }),
        ),
    ).toThrow(/positive power of two/);
    expect(() =>
        parseContractIdl(
            stateWith({
                kind: AbiTypeKind.BIT_ARRAY,
                bitCount: 128,
                size: 8,
                align: 8,
                format: "wrong",
            }),
        ),
    ).toThrow(/size 8 must be 16/);
});

test("accepts a resolved zero-length array", () => {
    const parsed = parseContractIdl({
        ...idl,
        state: {
            kind: AbiTypeKind.STRUCT,
            size: 0,
            align: 1,
            format: "wrong",
            fields: [
                {
                    name: "values",
                    offset: 0,
                    size: 0,
                    type: {
                        kind: AbiTypeKind.ARRAY,
                        count: 0,
                        size: 0,
                        align: 1,
                        format: "wrong",
                        element: {
                            kind: AbiTypeKind.SCALAR,
                            scalar: AbiScalarKind.UINT8,
                            size: 1,
                            align: 1,
                            format: "wrong",
                        },
                    },
                },
            ],
        },
    });

    expect(parsed.state.format).toBe("[0;uint8]");
});

test("accepts nested empty structs and arrays with one-byte stride", () => {
    const parsed = parseContractIdl({
        ...idl,
        state: {
            kind: AbiTypeKind.STRUCT,
            size: 4,
            align: 1,
            format: "wrong",
            fields: [
                {
                    name: "empty",
                    offset: 0,
                    size: 1,
                    type: emptyStruct,
                },
                {
                    name: "items",
                    offset: 1,
                    size: 3,
                    type: {
                        kind: AbiTypeKind.ARRAY,
                        count: 3,
                        size: 3,
                        align: 1,
                        format: "wrong",
                        element: emptyStruct,
                    },
                },
            ],
        },
    });

    expect(parsed.state.format).toBe("{}, [3;{}]");
    expect(parsed.state.fields[1].type.size).toBe(3);
});

test("rejects non-power-of-two HashMap, HashSet, and Collection capacities", () => {
    const scalar = {
        kind: AbiTypeKind.SCALAR,
        scalar: AbiScalarKind.UINT64,
        size: 8,
        align: 8,
        format: "wrong",
    } as const;
    for (const type of [
        {
            kind: AbiTypeKind.HASH_MAP,
            capacity: 0,
            key: scalar,
            value: scalar,
        },
        {
            kind: AbiTypeKind.HASH_SET,
            capacity: 3,
            key: scalar,
        },
        {
            kind: AbiTypeKind.COLLECTION,
            capacity: 6,
            value: scalar,
        },
    ]) {
        expect(() =>
            parseContractIdl({
                ...idl,
                state: {
                    kind: AbiTypeKind.STRUCT,
                    size: 8,
                    align: 8,
                    format: "wrong",
                    fields: [
                        {
                            name: "values",
                            offset: 0,
                            size: 8,
                            type: {
                                ...type,
                                size: 8,
                                align: 8,
                                format: "wrong",
                            },
                        },
                    ],
                },
            }),
        ).toThrow(/capacity .* must be a positive power of two/);
    }
});

test("accepts overlapping union views with explicit offsets", () => {
    const parsed = parseContractIdl({
        ...idl,
        state: {
            kind: AbiTypeKind.STRUCT,
            size: 8,
            align: 8,
            format: "wrong",
            fields: [
                {
                    name: "wide",
                    offset: 0,
                    size: 8,
                    type: {
                        kind: AbiTypeKind.SCALAR,
                        scalar: AbiScalarKind.UINT64,
                        size: 8,
                        align: 8,
                        format: "wrong",
                    },
                },
                {
                    name: "narrow",
                    offset: 0,
                    size: 4,
                    type: {
                        kind: AbiTypeKind.SCALAR,
                        scalar: AbiScalarKind.UINT32,
                        size: 4,
                        align: 4,
                        format: "wrong",
                    },
                },
            ],
        },
    });

    expect(parsed.state.fields.map((field) => field.offset)).toEqual([0, 0]);
});

test("accepts a log size that omits tail padding", () => {
    const parsed = parseContractIdl({
        ...idl,
        logs: [
            {
                name: "TailPadded",
                type: {
                    kind: AbiTypeKind.STRUCT,
                    size: 9,
                    align: 8,
                    format: "wrong",
                    fields: [
                        {
                            name: "value",
                            offset: 0,
                            size: 8,
                            type: {
                                kind: AbiTypeKind.SCALAR,
                                scalar: AbiScalarKind.UINT64,
                                size: 8,
                                align: 8,
                                format: "wrong",
                            },
                        },
                        {
                            name: "tag",
                            offset: 8,
                            size: 1,
                            type: {
                                kind: AbiTypeKind.SCALAR,
                                scalar: AbiScalarKind.UINT8,
                                size: 1,
                                align: 1,
                                format: "wrong",
                            },
                        },
                    ],
                },
            },
            {
                name: "EmptyPrefix",
                type: {
                    ...emptyStruct,
                    size: 0,
                },
            },
        ],
    });

    expect(parsed.logs[0].type.size).toBe(9);
    expect(parsed.logs[1].type.size).toBe(0);
});

test("rejects v4, zero-byte empty structs, and inconsistent entry sizes", () => {
    expect(() =>
        parseContractIdl({
            ...idl,
            version: 4,
        }),
    ).toThrow(/version must be 5/);
    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...emptyStruct,
                size: 0,
            },
        }),
    ).toThrow(/size 0 must be 1/);
    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...emptyStruct,
                align: 2,
            },
        }),
    ).toThrow(/align 2 must be 1/);
    expect(() =>
        parseContractIdl({
            ...idl,
            functions: [
                {
                    name: "Get",
                    inputType: 1,
                    inSize: 0,
                    outSize: 1,
                    input: emptyStruct,
                    output: emptyStruct,
                },
            ],
        }),
    ).toThrow(/inSize 0 does not match input size 1/);
});

test("rejects invalid scalar, array, and container layouts", () => {
    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...paddedStruct,
                fields: [
                    {
                        ...paddedStruct.fields[0],
                        size: 2,
                        type: {
                            ...paddedStruct.fields[0].type,
                            size: 2,
                        },
                    },
                    paddedStruct.fields[1],
                ],
            },
        }),
    ).toThrow(/scalar format|field|size 2 must be 1/);

    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                kind: AbiTypeKind.STRUCT,
                size: 4,
                align: 4,
                format: "wrong",
                fields: [
                    {
                        name: "values",
                        offset: 0,
                        size: 4,
                        type: {
                            kind: AbiTypeKind.ARRAY,
                            count: 2,
                            size: 4,
                            align: 4,
                            format: "wrong",
                            element: {
                                kind: AbiTypeKind.SCALAR,
                                scalar: AbiScalarKind.UINT32,
                                size: 4,
                                align: 4,
                                format: "wrong",
                            },
                        },
                    },
                ],
            },
        }),
    ).toThrow(/size 4 must be 8/);

    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                kind: AbiTypeKind.STRUCT,
                size: 24,
                align: 8,
                format: "wrong",
                fields: [
                    {
                        name: "values",
                        offset: 0,
                        size: 24,
                        type: {
                            kind: AbiTypeKind.HASH_SET,
                            capacity: 1,
                            size: 24,
                            align: 8,
                            format: "wrong",
                            key: {
                                kind: AbiTypeKind.SCALAR,
                                scalar: AbiScalarKind.UINT64,
                                size: 8,
                                align: 8,
                                format: "wrong",
                            },
                        },
                    },
                ],
            },
        }),
    ).toThrow(/size 24 must be 32/);
});

test("rejects out-of-order, misaligned, and out-of-bounds fields", () => {
    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...paddedStruct,
                fields: [
                    paddedStruct.fields[0],
                    {
                        ...paddedStruct.fields[1],
                        offset: 4,
                    },
                ],
            },
        }),
    ).toThrow(/not aligned/);

    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...paddedStruct,
                fields: [paddedStruct.fields[1], paddedStruct.fields[0]],
            },
        }),
    ).toThrow(/out of order/);

    expect(() =>
        parseContractIdl({
            ...idl,
            state: {
                ...paddedStruct,
                size: 16,
            },
        }),
    ).toThrow(/exceeds struct size/);
});
