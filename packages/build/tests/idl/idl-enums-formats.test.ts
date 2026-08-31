// Two pieces of the IDL nothing downstream recomputes: an enum's underlying scalar, and the `format`
// string stored on a nested type. The root's format is rebuilt from the tree, but a nested struct's is
// the string the CLI prints for that field, so its braces are load-bearing.
import { expect, test } from "bun:test";
import { AbiScalarKind, AbiTypeKind, extractIdl } from "../../src/compile/idl";

const SOURCE = `
using namespace QPI;
enum Plain { First, Second };
enum class Sized : uint16 { Low, High };
enum class Wide : sint64 { Near = -1, Far = 1 };
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Point { sint32 x; sint32 y; };
  struct Box { Point origin; Array<Point, 2> corners; uint8 tag; };
  struct StateData {
    Point origin;
    Box box;
    Array<Point, 2> path;
    uint64 counter;
  };
  INITIALIZE() {}
};`;

const idl = extractIdl(SOURCE, "Shapes", { slot: 3 });
const enumNamed = (name: string) => idl.enums.find((entry) => entry.name === name);
const stateField = (name: string) => idl.state.fields.find((field) => field.name === name)!;

test("an enum without an explicit underlying type is sint32, and an explicit one is kept", () => {
    expect(enumNamed("Plain")?.underlying).toBe(AbiScalarKind.SINT32);
    expect(enumNamed("Plain")?.members).toEqual({ "0": "First", "1": "Second" });
    expect(enumNamed("Sized")?.underlying).toBe(AbiScalarKind.UINT16);
    expect(enumNamed("Wide")?.underlying).toBe(AbiScalarKind.SINT64);
    expect(enumNamed("Wide")?.members).toEqual({ "-1": "Near", "1": "Far" });
});

test("a nested struct's stored format keeps the braces that mark where it begins", () => {
    expect(stateField("origin").type.format).toBe("{ sint32, sint32 }");
    expect(stateField("path").type.format).toBe("[2;{ sint32, sint32 }]");
    expect(stateField("box").type.format).toBe("{ { sint32, sint32 }, [2;{ sint32, sint32 }], uint8 }");
    expect(stateField("counter").type.format).toBe("uint64");

    // The state root itself is the one struct printed without them — it is the field list, not a value.
    expect(idl.state.format).toBe("{ sint32, sint32 }, { { sint32, sint32 }, [2;{ sint32, sint32 }], uint8 }, [2;{ sint32, sint32 }], uint64");
});

test("a nested struct keeps its own name and layout beside the format", () => {
    const box = stateField("box").type;
    if (box.kind !== AbiTypeKind.STRUCT) {
        throw new Error("box must be a struct");
    }

    expect(box.name).toBe("Box");
    expect(box.fields.map((field) => [field.name, field.offset, field.size])).toEqual([
        ["origin", 0, 8],
        ["corners", 8, 16],
        ["tag", 24, 1],
    ]);
    expect(box.size).toBe(28);
    expect(box.align).toBe(4);
});

// One row per native C spelling the compiler accepts. A spelling the kind map misses falls through to
// scalarKindForSize, which answers unsigned for every width — so asserting `size` alone would pass on a
// field that silently lost its sign. Every row pins `format`, which is the only place signedness shows.
// Widths are wasm32's (ILP32): long, unsigned long and size_t are 4 bytes, only long long is 8.
const NATIVE_SCALARS: [string, string][] = [
    ["bool", "uint8"],
    ["char", "sint8"],
    ["signed char", "sint8"],
    ["unsigned char", "uint8"],
    ["short", "sint16"],
    ["short int", "sint16"],
    ["signed short", "sint16"],
    ["signed short int", "sint16"],
    ["unsigned short", "uint16"],
    ["unsigned short int", "uint16"],
    ["int", "sint32"],
    ["signed", "sint32"],
    ["signed int", "sint32"],
    ["unsigned", "uint32"],
    ["unsigned int", "uint32"],
    ["long", "sint32"],
    ["long int", "sint32"],
    ["signed long", "sint32"],
    ["signed long int", "sint32"],
    ["unsigned long", "uint32"],
    ["unsigned long int", "uint32"],
    ["size_t", "uint32"],
    ["wchar_t", "sint32"],
    ["long long", "sint64"],
    ["signed long long", "sint64"],
    ["unsigned long long", "uint64"],
];

const SCALAR_WIDTH: Record<string, number> = {
    uint8: 1,
    sint8: 1,
    uint16: 2,
    sint16: 2,
    uint32: 4,
    sint32: 4,
    uint64: 8,
    sint64: 8,
};

test("every native C spelling keeps the width and signedness the ABI maps it to", () => {
    for (const [spelling, expected] of NATIVE_SCALARS) {
        const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { ${spelling} value; };
  INITIALIZE() {}
};`;

        const field = extractIdl(source, "Native", { slot: 5 }).state.fields[0];
        expect({ spelling, format: field.type.format, size: field.type.size }).toEqual({
            spelling,
            format: expected,
            size: SCALAR_WIDTH[expected],
        });
    }
});

test("native scalars pack together at the offsets their own widths imply", () => {
    const source = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    char letter;
    unsigned char byte;
    bool flag;
    unsigned short small;
    long native;
    size_t count;
    long long wide;
  };
  INITIALIZE() {}
};`;

    const state = extractIdl(source, "Native", { slot: 5 }).state;
    expect(state.fields.map((field) => [field.name, field.type.format, field.offset])).toEqual([
        ["letter", "sint8", 0],
        ["byte", "uint8", 1],
        ["flag", "uint8", 2],
        ["small", "uint16", 4],
        ["native", "sint32", 8],
        ["count", "uint32", 12],
        ["wide", "sint64", 16],
    ]);
    expect(state.size).toBe(24);
});
