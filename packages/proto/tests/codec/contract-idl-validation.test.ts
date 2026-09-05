// The validator branches the main contract-idl suite does not reach: enums, migration, the registry
// file, entry metadata, and how deep a type tree may go before anything gives.
import { expect, test } from "bun:test";
import {
    AbiScalarKind,
    AbiTypeKind,
    abiTypeContainsKind,
    forbiddenPublicType,
    formatAbiType,
    parseContractIdl,
    parseContractIdlFile,
    type AbiStruct,
    type AbiType,
} from "../../src/contract-idl";
import { hasOverlappingAbiType } from "../../src/abi-fmt";
import { arr, co, contractIdl, hm, hs, id, ll, named, st, u8, u64, validated } from "./abi-builders";

const STATE = st(u64) as AbiStruct;
const enumIdl = (underlying: string, members: unknown) => contractIdl(STATE, { enums: [{ name: "E", underlying, members }] as never });
const entry = (inputType: number, extra: object = {}) => ({
    name: `e${inputType}`,
    inputType,
    inSize: 8,
    outSize: 8,
    input: st(u64),
    output: st(u64),
    ...extra,
});

test("enum members may be negative and the underlying scalar must be known", () => {
    const parsed = parseContractIdl(enumIdl("sint8", { "-1": "NEG", "0": "ZERO" }));
    expect(parsed.enums[0].members).toEqual({ "-1": "NEG", "0": "ZERO" });

    expect(() => parseContractIdl(enumIdl("bool", {}))).toThrow("IDL enum 0 has unknown scalar 'bool'");
    expect(() => parseContractIdl(enumIdl("sint8", { "1.5": "X" }))).toThrow("IDL enum 0 member key '1.5' is not an integer");
    expect(() => parseContractIdl(enumIdl("sint8", { "1": 2 }))).toThrow("IDL enum 0 member 1 must be a string");
    expect(parseContractIdl(enumIdl("id", {})).enums[0].underlying).toBe(AbiScalarKind.ID); // any scalar name passes, by design
});

test("a log's recorded _type values must be unsigned integers", () => {
    const unpadded = { ...(st(u64, u8) as AbiStruct), size: 9 };
    expect(parseContractIdl(contractIdl(STATE, { logs: [{ name: "L", type: unpadded, types: [3, 4] }] })).logs[0].types).toEqual([3, 4]);
    expect(parseContractIdl(contractIdl(STATE, { logs: [{ name: "L", type: unpadded }] })).logs[0].types).toBeUndefined();
    expect(() => parseContractIdl(contractIdl(STATE, { logs: [{ name: "L", type: unpadded, types: [3, "x"] as never }] }))).toThrow(/log 0 type 1/);
});

test("only a log may omit its tail padding — migration and state may not", () => {
    const padded = st(u64, u8) as AbiStruct;
    const unpadded = { ...padded, size: 9 };

    expect(() => parseContractIdl(contractIdl(STATE, { migration: { oldState: u64 as never } }))).toThrow("IDL migration oldState must be a struct");
    expect(() => parseContractIdl(contractIdl(STATE, { migration: { oldState: unpadded } }))).toThrow("IDL migration oldState size 9 must be 16");
    expect(() => parseContractIdl(contractIdl(unpadded))).toThrow("IDL state size 9 must be 16");
    expect(parseContractIdl(contractIdl(STATE, { logs: [{ name: "L", type: unpadded }] })).logs[0].type.size).toBe(9);

    const migrated = parseContractIdl(contractIdl(STATE, { migration: { oldState: padded } }));
    expect(migrated.migration?.oldState.format).toBe("uint64, uint8");
    expect(parseContractIdl(contractIdl(STATE)).migration).toBeUndefined();
});

test("inputType is unique per entry list, not across functions and procedures", () => {
    expect(() => parseContractIdl(contractIdl(STATE, { functions: [entry(1), entry(1)] as never }))).toThrow("IDL functions repeats inputType 1");
    const shared = parseContractIdl(contractIdl(STATE, { functions: [entry(1)] as never, procedures: [entry(1)] as never }));
    expect([shared.functions[0].inputType, shared.procedures[0].inputType]).toEqual([1, 1]);
});

test("notification is carried only when it is exactly true", () => {
    const flagged = parseContractIdl(contractIdl(STATE, { procedures: [entry(1, { notification: true })] as never }));
    expect(flagged.procedures[0].notification).toBe(true);

    for (const value of [false, "yes", 1, null]) {
        const parsed = parseContractIdl(contractIdl(STATE, { procedures: [entry(1, { notification: value })] as never }));
        expect("notification" in parsed.procedures[0]).toBe(false);
    }
});

test("entry sizes are cross-checked against the type tree they describe", () => {
    const withSizes = (inSize: number, outSize: number) =>
        contractIdl(STATE, { functions: [{ name: "f", inputType: 1, inSize, outSize, input: st(u64), output: st(u8) }] as never });

    expect(parseContractIdl(withSizes(8, 1)).functions[0].input.format).toBe("uint64");
    expect(() => parseContractIdl(withSizes(9, 1))).toThrow("IDL functions 0 inSize 9 does not match input size 8");
    expect(() => parseContractIdl(withSizes(8, 2))).toThrow("IDL functions 0 outSize 2 does not match output size 1");
});

test("dependencies must be strings and field names must be unique", () => {
    expect(() => parseContractIdl(contractIdl(STATE, { dependencies: [7] as never }))).toThrow("IDL dependency 0 must be a string");

    const collide = named(["a", u64], ["a", u8]);
    expect(() => parseContractIdl(contractIdl(collide))).toThrow("IDL state repeats field 'a'");
});

test("the registry file keys contracts by slot and validates its artifact strings", () => {
    const one = contractIdl(STATE) as Record<string, unknown>;

    expect(() => parseContractIdlFile({ version: 4, contracts: {} })).toThrow("IDL file version must be 5");
    expect(() => parseContractIdlFile({ version: 5, contracts: [] })).toThrow("IDL file contracts must be an object");
    expect(() => parseContractIdlFile({ version: 5, contracts: { abc: one } })).toThrow("IDL file contract key 'abc' is not a slot");
    expect(() => parseContractIdlFile({ version: 5, contracts: { "01": one } })).toThrow("IDL file contract key '01' is not a slot");
    expect(() => parseContractIdlFile({ version: 5, contracts: { "-1": one } })).toThrow("IDL file contract key '-1' is not a slot");
    expect(() => parseContractIdlFile({ version: 5, contracts: { "5": one } })).toThrow("IDL contract 5 stores slot 1");

    for (const key of ["codeHash", "debugWasm", "linesJson"]) {
        expect(() => parseContractIdlFile({ version: 5, contracts: { "1": { ...one, [key]: 7 } } })).toThrow(`IDL artifact ${key} must be a string`);
    }

    const parsed = parseContractIdlFile({ version: 5, contracts: { "1": { ...one, codeHash: "aa", debugWasm: "bb", linesJson: "cc" } } });
    expect([parsed.contracts["1"].codeHash, parsed.contracts["1"].debugWasm, parsed.contracts["1"].linesJson]).toEqual(["aa", "bb", "cc"]);
});

// Every `format` in the document is advisory: the validator recomputes it from the type tree, so a
// stale one from an older generator cannot mislead a decoder.
const lieAboutFormats = (type: AbiType): AbiType => {
    const lied = { ...type, format: "lies" } as unknown as Record<string, unknown>;
    if (Array.isArray(lied.fields)) {
        lied.fields = (lied.fields as { type: AbiType }[]).map((field) => ({ ...field, type: lieAboutFormats(field.type) }));
    }
    for (const child of ["element", "key", "value"]) {
        if (lied[child]) {
            lied[child] = lieAboutFormats(lied[child] as AbiType);
        }
    }
    return lied as unknown as AbiType;
};

test("a wrong format at every level is recomputed from the type tree", () => {
    const deep = hm(st(arr(id, 2), u64), ll(u64, 2), 2);
    const normalized = validated(lieAboutFormats(deep));

    const formats: string[] = [];
    const collect = (type: AbiType) => {
        formats.push(type.format);
        const node = type as unknown as Record<string, unknown>;
        for (const field of (node.fields as { type: AbiType }[] | undefined) ?? []) {
            collect(field.type);
        }
        for (const child of ["element", "key", "value"]) {
            if (node[child]) {
                collect(node[child] as AbiType);
            }
        }
    };
    collect(normalized);

    expect(formats.length).toBe(7);
    expect(formats.filter((format) => format === "lies")).toEqual([]);
    expect(normalized.format).toBe(formatAbiType(normalized));
});

test("a container nested in a container is validated at every level", () => {
    const deep = hm(st(arr(id, 2), u64), ll(u64, 2), 2);
    expect(validated(deep).size).toBe(360);
    expect(() => parseContractIdl(contractIdl(st({ ...deep, size: 359 }) as AbiStruct))).toThrow("IDL state field 0 type size 359 must be 360");
    expect(() => parseContractIdl(contractIdl(st(hm(u8, ll(u8, 3), 2)) as AbiStruct))).toThrow(
        "IDL state field 0 type value capacity 3 must be a positive power of two",
    );

    const sixLevels = st(arr(st(hm(u8, arr(st(ll(u64, 2)), 2), 2)), 2));
    expect(validated(sixLevels)).toMatchObject({ size: 848, align: 8 });
});

test("an overlapping union survives inside a container and is still detectable", () => {
    const pair = st(u64, u64) as AbiStruct;
    const union = { ...pair, fields: pair.fields.map((field) => ({ ...field, offset: 0 })), size: 8 };

    const type = validated(hm(u8, union, 2));
    expect(hasOverlappingAbiType(type)).toBe(true);
});

test("a 300-deep type chain parses without special handling", () => {
    let structs: AbiType = u8;
    let arrays: AbiType = u8;
    for (let level = 0; level < 300; level++) {
        structs = st(structs);
        arrays = arr(arrays, 1);
    }

    expect(validated(structs)).toMatchObject({ size: 1, align: 1 });
    expect(validated(arrays)).toMatchObject({ size: 1, align: 1 });
});

// The rest of this file covers malformed input *shapes* — bad enum keys, non-slot file keys, wrong
// migration sizes. What it missed is the validator's *recomputation consistency*: the IDL carries a
// redundant size and align beside each type, and the validator recomputes both from the field tree and
// rejects a disagreement. A mutation sweep removed each of those two checks and nothing failed.
//
// The consequence is not cosmetic. Unlike `format`, which parseContractIdl overwrites with its own
// computation, a field's `size` is *kept* — so an IDL claiming a uint64 field is 999 bytes is believed,
// and every field after it reads at the wrong offset.
test("a field size that disagrees with its type is rejected, not believed", () => {
    const good = contractIdl(named(["counter", u64], ["flag", u8]) as AbiStruct) as Record<string, unknown>;
    expect(() => parseContractIdl(good)).not.toThrow();

    const lying = JSON.parse(JSON.stringify(good));
    lying.state.fields[0].size = 999;
    expect(() => parseContractIdl(lying)).toThrow("size 999 does not match type size 8");
});

test("an alignment that is not a power of two is rejected", () => {
    const good = contractIdl(st(u64) as AbiStruct) as Record<string, unknown>;
    expect(() => parseContractIdl(good)).not.toThrow();

    for (const align of [3, 6, 12]) {
        const skewed = JSON.parse(JSON.stringify(good));
        skewed.state.fields[0].type.align = align;
        expect(() => parseContractIdl(skewed)).toThrow(`align ${align} must be a power of two`);
    }
});

// A union whose widest member is not its last one: the struct's extent is the furthest field end, not the
// end of whichever field happens to come last. With byte alignment there is no padding to hide the difference.
test("a struct spans its furthest field, not its last one", () => {
    const union: AbiStruct = {
        kind: AbiTypeKind.STRUCT,
        size: 16,
        align: 1,
        format: "",
        fields: [
            { name: "raw", offset: 0, size: 16, type: arr(u8, 16) },
            { name: "tag", offset: 0, size: 1, type: u8 },
        ],
    };

    expect(validated(union)).toMatchObject({ size: 16, align: 1 });
    expect(hasOverlappingAbiType(validated(union))).toBe(true);

    // Over-declaring the size names the extent the widest field reaches, not the end of the last one.
    expect(() => parseContractIdl(contractIdl(st({ ...union, size: 32 }) as AbiStruct))).toThrow("IDL state field 0 type size 32 must be 16");
});

test("every count the IDL carries must be a real non-negative integer", () => {
    const good = contractIdl(named(["counter", u64]) as AbiStruct) as Record<string, unknown>;
    const NON_NEGATIVE = "must be a non-negative integer";
    const skewed = (mutate: (idl: any) => void) => {
        const copy = JSON.parse(JSON.stringify(good));
        mutate(copy);
        return () => parseContractIdl(copy);
    };

    expect(skewed((idl) => (idl.slot = -1))).toThrow(`IDL slot ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.sysprocMask = -1))).toThrow(`IDL sysprocMask ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.state.size = -16))).toThrow(`IDL state size ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.state.fields[0].offset = -8))).toThrow(`IDL state field 0 offset ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.state.fields[0].size = -8))).toThrow(`IDL state field 0 size ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.state.fields[0].type.align = -8))).toThrow(`IDL state field 0 type align ${NON_NEGATIVE}`);

    // A fractional or unrepresentable count is refused by the same gate.
    expect(skewed((idl) => (idl.slot = 1.5))).toThrow(`IDL slot ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.slot = 2 ** 53))).toThrow(`IDL slot ${NON_NEGATIVE}`);
    expect(skewed((idl) => (idl.state.size = "16"))).toThrow(`IDL state size ${NON_NEGATIVE}`);
});

test("a forbidden container is reported wherever the type tree hides it, not just on the key side", () => {
    const inMapValue = validated(hm(u64, co(u64, 2), 2));
    const inMapKey = validated(hm(co(u64, 2), u64, 2));
    const inArray = validated(arr(hs(u64, 2), 2));
    const inStructField = validated(st(u64, ll(u64, 2)));

    expect(abiTypeContainsKind(inMapValue, AbiTypeKind.COLLECTION)).toBe(true);
    expect(forbiddenPublicType(inMapValue)).toBe("Collection");
    expect(forbiddenPublicType(inMapKey)).toBe("Collection");
    expect(forbiddenPublicType(inArray)).toBe("HashSet");
    expect(forbiddenPublicType(inStructField)).toBe("LinkedList");
    expect(forbiddenPublicType(validated(arr(st(u64, u8), 2)))).toBeUndefined();
});
