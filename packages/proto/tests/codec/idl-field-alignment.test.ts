// Validator branches the other codec suites never reach: a field offset that its own type's alignment
// forbids, plus the shape guards on raw IDL JSON (unknown kind, non-array fields, zero align).
import { expect, test } from "bun:test";
import { parseContractIdl, type AbiStruct, type AbiType } from "../../src/contract-idl";
import { arr, contractIdl, hm, ll, named, st, u8, u16, u32, u64 } from "./abi-builders";

// The builders always place fields correctly, so a misalignment has to be introduced on purpose.
function moveField(struct: AbiStruct, fieldName: string, offset: number): AbiStruct {
    return {
        ...struct,
        fields: struct.fields.map((field) => (field.name === fieldName ? { ...field, offset } : field)),
    };
}

const parseState = (state: AbiStruct) => parseContractIdl(contractIdl(state));

test("a field offset that its type's alignment forbids is rejected", () => {
    const state = named(["a", u8], ["b", u64]);
    expect(state.fields[1].offset).toBe(8);

    // 4 is past 'a' and still ascending, so only the alignment rule can catch it.
    expect(() => parseState(moveField(state, "b", 4))).toThrow("field 'b' offset 4 is not aligned to 8");
    expect(() => parseState(moveField(state, "b", 2))).toThrow("field 'b' offset 2 is not aligned to 8");
    expect(() => parseState(moveField(state, "b", 1))).toThrow("field 'b' offset 1 is not aligned to 8");
});

test("alignment is checked against the field's own type, not the struct", () => {
    // Each of these carries a different alignment, and the offset below is legal for every smaller one.
    const cases: [label: string, type: AbiType, align: number][] = [
        ["u16", u16, 2],
        ["u32", u32, 4],
        ["u64", u64, 8],
        ["nested struct", st(u32, u64), 8],
        ["array", arr(u32, 3), 4],
        ["hash map", hm(u64, u64, 8), 8],
        ["linked list", ll(u32, 8), 8],
    ];

    for (const [label, type, align] of cases) {
        const state = named(["head", u8], ["body", type]);
        expect(state.fields[1].offset % align, label).toBe(0);
        expect(() => parseState(moveField(state, "body", 1)), label).toThrow(`field 'body' offset 1 is not aligned to ${align}`);
    }
});

test("a narrow field may sit where the struct's own alignment would forbid", () => {
    // struct align is 8 (from 'big'), but 'small' only needs 2 — so offset 10 is legal for the field
    // and illegal for the struct. Checking against the wrong one of the two shows up only here.
    const state = named(["big", u64], ["small", u16]);
    expect(state.align).toBe(8);

    const moved = moveField(state, "small", 10);
    expect(() => parseState(moved)).not.toThrow();
    expect(parseState(moved).state.fields[1].offset).toBe(10);
});

test("offset 0 and single-byte fields are never misaligned", () => {
    expect(() => parseState(named(["only", u64]))).not.toThrow();

    // align 1 divides everything, so a uint8 is legal at any offset the other rules allow.
    const bytes = named(["a", u8], ["b", u8], ["c", u8]);
    expect(() => parseState(bytes)).not.toThrow();
    expect(bytes.fields.map((field) => field.offset)).toEqual([0, 1, 2]);
});

test("raw IDL shape guards: unknown kind, non-array fields, zero align", () => {
    const withStateType = (type: unknown) => contractIdl({ ...st(u64), fields: [{ name: "f", offset: 0, size: 8, type }] } as never);

    expect(() => parseContractIdl(withStateType({ kind: "matrix", size: 8, align: 8, format: "" }))).toThrow("has unknown kind 'matrix'");
    expect(() => parseContractIdl(withStateType({ kind: "struct", size: 8, align: 8, format: "", fields: {} }))).toThrow("fields must be an array");
    expect(() => parseContractIdl(withStateType({ kind: "scalar", scalar: "uint64", size: 8, align: 0, format: "uint64" }))).toThrow("align must be positive");
});
