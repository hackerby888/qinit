// Every kind of declaration a namespace can hold has to stay addressable by its qualified name. Indexed by
// bare name alone, two namespaces sharing a name collapse into whichever registered last — silently, with
// the loser's width changing under it. The table below is the invariant: one row per declaration kind.
import { expect, test } from "bun:test";
import { AbiScalarKind, extractIdl, parseContractIdl } from "../../src/compile/idl";

const contract = (declarations: string, stateFields: string) => `
using namespace QPI;
${declarations}
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
${stateFields}
  };
  INITIALIZE() {}
};`;

// Every fixture is round-tripped through the validator: it recomputes size, align and format from the type
// tree, so any two resolution paths disagreeing about one field is rejected here rather than shipped.
const idlOf = (declarations: string, stateFields: string) => {
    const idl = extractIdl(contract(declarations, stateFields), "Scoped", { slot: 15 });
    expect(() => parseContractIdl(idl)).not.toThrow();
    return idl;
};

const sizesOf = (declarations: string, stateFields: string) => idlOf(declarations, stateFields).state.fields.map((field) => [field.name, field.size]);

// One row per declaration kind: two namespaces declare the same name, each field must get its own.
const SIBLING_CASES: { kind: string; declarations: string; stateFields: string; sizes: [string, number][] }[] = [
    {
        kind: "typedef",
        declarations: "namespace Alpha { typedef uint8 W; }\nnamespace Beta { typedef uint64 W; }",
        stateFields: "    Alpha::W a;\n    Beta::W b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "struct",
        declarations: "namespace Alpha { struct Rec { uint8 v; }; }\nnamespace Beta { struct Rec { uint64 v; }; }",
        stateFields: "    Alpha::Rec a;\n    Beta::Rec b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "constant",
        declarations: "namespace Alpha { constexpr uint64 LIMIT = 4; }\nnamespace Beta { constexpr uint64 LIMIT = 16; }",
        stateFields: "    Array<uint64, Alpha::LIMIT> a;\n    Array<uint64, Beta::LIMIT> b;",
        sizes: [
            ["a", 32],
            ["b", 128],
        ],
    },
    {
        kind: "enum",
        declarations: "namespace Alpha { enum class Code : uint8 { X }; }\nnamespace Beta { enum class Code : uint64 { Y }; }",
        stateFields: "    Alpha::Code a;\n    Beta::Code b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "class template",
        declarations: "namespace Alpha { template<typename T> struct Box { T v; }; }\nnamespace Beta { template<typename T> struct Box { T v; T w; }; }",
        stateFields: "    Alpha::Box<uint64> a;\n    Beta::Box<uint64> b;",
        sizes: [
            ["a", 8],
            ["b", 16],
        ],
    },
];

for (const scoped of SIBLING_CASES) {
    test(`sibling namespaces keep their own ${scoped.kind}`, () => {
        expect(sizesOf(scoped.declarations, scoped.stateFields)).toEqual(scoped.sizes);
    });
}

test("a name declared in a namespace does not displace the global one", () => {
    const declarations = `
typedef uint8 Unit;
constexpr uint64 COUNT = 2;
namespace Inner {
  typedef uint64 Unit;
  constexpr uint64 COUNT = 8;
}`;

    expect(
        sizesOf(declarations, "    Unit outer;\n    Inner::Unit inner;\n    Array<uint8, COUNT> outerCount;\n    Array<uint8, Inner::COUNT> innerCount;"),
    ).toEqual([
        ["outer", 1],
        ["inner", 8],
        ["outerCount", 2],
        ["innerCount", 8],
    ]);
});

test("nesting three deep keeps every level distinct", () => {
    const declarations = `
namespace L1 {
  typedef uint8 T;
  namespace L2 {
    typedef uint16 T;
    namespace L3 { typedef uint64 T; }
  }
}`;

    expect(sizesOf(declarations, "    L1::T a;\n    L1::L2::T b;\n    L1::L2::L3::T c;")).toEqual([
        ["a", 1],
        ["b", 2],
        ["c", 8],
    ]);
});

test("an enum member is reachable through its namespace as well as its enum", () => {
    const declarations = `
namespace Alpha { enum class Size : uint64 { Small = 2, Large = 4 }; }
namespace Beta { enum class Size : uint64 { Small = 16, Large = 32 }; }`;

    expect(sizesOf(declarations, "    Array<uint8, Alpha::Size::Small> a;\n    Array<uint8, Beta::Size::Large> b;")).toEqual([
        ["a", 2],
        ["b", 32],
    ]);
});

test("a constant defined from another constant resolves inside its own namespace", () => {
    const declarations = `
namespace Alpha { constexpr uint64 BASE = 2; constexpr uint64 DOUBLED = BASE * 2; }
namespace Beta { constexpr uint64 BASE = 8; constexpr uint64 DOUBLED = BASE * 2; }`;

    expect(sizesOf(declarations, "    Array<uint8, Alpha::DOUBLED> a;\n    Array<uint8, Beta::DOUBLED> b;")).toEqual([
        ["a", 4],
        ["b", 16],
    ]);
});

test("a typedef chain crossing namespaces keeps the width of the type it names", () => {
    const declarations = `
namespace Alpha { typedef uint8 W; }
namespace Beta { typedef uint64 W; typedef Alpha::W Borrowed; typedef W Own; }`;

    expect(sizesOf(declarations, "    Beta::Borrowed borrowed;\n    Beta::Own own;")).toEqual([
        ["borrowed", 1],
        ["own", 8],
    ]);
});

test("a namespaced struct keeps its own nested members and layout", () => {
    const declarations = `
namespace Alpha { struct Outer { struct Inner { uint8 v; }; Inner inner; uint8 tag; }; }
namespace Beta { struct Outer { struct Inner { uint64 v; }; Inner inner; uint8 tag; }; }`;

    expect(sizesOf(declarations, "    Alpha::Outer a;\n    Beta::Outer b;\n    Alpha::Outer::Inner c;")).toEqual([
        ["a", 2],
        ["b", 16],
        ["c", 1],
    ]);
});

test("a namespaced typedef of a struct keeps that namespace's struct, not a same-named one", () => {
    const declarations = `
namespace Alpha { struct Rec { uint8 v; }; typedef Rec Alias; }
namespace Beta { struct Rec { uint64 v; }; typedef Rec Alias; }`;

    const fields = idlOf(declarations, "    Alpha::Alias a;\n    Beta::Alias b;").state.fields;
    expect(fields.map((field) => [field.name, field.size, field.type.align, field.type.format])).toEqual([
        ["a", 1, 1, "{ uint8 }"],
        ["b", 8, 8, "{ uint64 }"],
    ]);
});

test("a typedef reaching a struct through another typedef stays in its own namespace", () => {
    const declarations = `
namespace Alpha { struct Rec { uint8 v; }; typedef Rec Inner; typedef Inner Outer; }
namespace Beta { struct Rec { uint64 v; }; typedef Rec Inner; typedef Inner Outer; }`;

    expect(sizesOf(declarations, "    Alpha::Outer a;\n    Beta::Outer b;")).toEqual([
        ["a", 1],
        ["b", 8],
    ]);
});

test("a namespaced typedef of a container keeps its own element type", () => {
    const declarations = `
namespace Alpha { struct Rec { uint8 v; }; typedef Array<Rec, 4> Buffer; }
namespace Beta { struct Rec { uint64 v; }; typedef Array<Rec, 4> Buffer; }`;

    expect(sizesOf(declarations, "    Alpha::Buffer a;\n    Beta::Buffer b;")).toEqual([
        ["a", 4],
        ["b", 32],
    ]);
});

// A base named through a typedef is the one bug in this family the validator cannot catch: every path
// agrees on the wrong base, so the IDL is self-consistent. Only the concrete C++ layout tells them apart.
test("a base class named through a namespaced typedef comes from that namespace", () => {
    const declarations = `
namespace Alpha { struct Base { uint8 v; }; typedef Base B; }
namespace Beta { struct Base { uint64 a; uint64 b; }; typedef Base B; }`;
    const stateFields = "    FromAlpha a;\n    FromBeta b;";
    const nested = `
  struct FromAlpha : public Alpha::B { uint8 extra; };
  struct FromBeta : public Beta::B { uint8 extra; };`;

    const source = `
using namespace QPI;
${declarations}
struct CONTRACT_STATE_TYPE : public ContractBase {
${nested}
  struct StateData {
${stateFields}
  };
  INITIALIZE() {}
};`;

    const idl = extractIdl(source, "Bases", { slot: 18 });
    expect(() => parseContractIdl(idl)).not.toThrow();
    expect(idl.state.fields.map((field) => [field.name, field.size, field.type.align, field.type.format])).toEqual([
        ["a", 2, 1, "{ uint8, uint8 }"],
        ["b", 24, 8, "{ uint64, uint64, uint8 }"],
    ]);
});

test("a base class named directly still resolves to its own namespace", () => {
    const source = `
using namespace QPI;
namespace Alpha { struct Base { uint8 v; }; }
namespace Beta { struct Base { uint64 a; uint64 b; }; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct FromAlpha : public Alpha::Base { uint8 extra; };
  struct FromBeta : public Beta::Base { uint8 extra; };
  struct StateData {
    FromAlpha a;
    FromBeta b;
  };
  INITIALIZE() {}
};`;

    const idl = extractIdl(source, "Bases", { slot: 19 });
    expect(() => parseContractIdl(idl)).not.toThrow();
    expect(idl.state.fields.map((field) => [field.name, field.size])).toEqual([
        ["a", 2],
        ["b", 24],
    ]);
});

test("a nested type reached through a namespaced typedef comes from that namespace", () => {
    const declarations = `
namespace Alpha { struct Owner { struct Inner { uint8 v; }; }; typedef Owner O; }
namespace Beta { struct Owner { struct Inner { uint64 a; uint64 b; }; }; typedef Owner O; }`;

    expect(sizesOf(declarations, "    Alpha::O::Inner a;\n    Beta::O::Inner b;")).toEqual([
        ["a", 1],
        ["b", 16],
    ]);
});

// A base written unqualified inside a namespace means that namespace's type. Nothing recorded where a
// struct was declared before this, so `Beta::D` inherited whichever Base owned the bare name.
test("a struct inherits the base of its own namespace, not a same-named one", () => {
    const declarations = `
namespace Alpha { struct Base { uint8 v; }; struct D : public Base { uint8 e; }; typedef D T; }
namespace Beta { struct Base { uint64 a; uint64 b; }; struct D : public Base { uint8 e; }; typedef D T; }`;

    expect(sizesOf(declarations, "    Alpha::D a;\n    Beta::D b;")).toEqual([
        ["a", 2],
        ["b", 24],
    ]);
    expect(sizesOf(declarations, "    Alpha::T a;\n    Beta::T b;")).toEqual([
        ["a", 2],
        ["b", 24],
    ]);
});

// An enum's underlying type can be named through an alias, and both the width it lays out at and the scalar
// the IDL reports come from separate lookups — so the table pins each spelling on both, and the last row
// keeps the fallback honest for an underlying type that is not a scalar at all.
const enumIdl = (declarations: string, stateFields: string) => {
    const idl = extractIdl(contract(declarations, stateFields), "Scoped", { slot: 31 });
    expect(() => parseContractIdl(idl)).not.toThrow();
    return idl;
};

const ALIASES = "namespace Widths { typedef uint16 W; typedef W W2; }";

test("an enum sizes and reports the scalar its underlying alias resolves to", () => {
    for (const underlying of ["Widths::W", "Widths::W2"]) {
        const idl = enumIdl(`${ALIASES}\nenum class Choice : ${underlying} { Only };`, "    Choice c;\n    uint8 tail;");
        expect(idl.state.fields.map((field) => [field.name, field.size])).toEqual([
            ["c", 2],
            ["tail", 1],
        ]);
        expect(idl.enums.find((entry) => entry.name === "Choice")?.underlying).toBe(AbiScalarKind.UINT16);
    }
});

test("an explicit or absent underlying type is unaffected", () => {
    for (const [underlying, size, reported] of [
        [" : uint16", 2, AbiScalarKind.UINT16],
        [" : sint8", 1, AbiScalarKind.SINT8],
        [" : uint64", 8, AbiScalarKind.UINT64],
        ["", 4, AbiScalarKind.SINT32],
    ] as const) {
        const idl = enumIdl(`enum class Choice${underlying} { Only };`, "    Choice c;\n    uint8 tail;");
        expect(idl.state.fields[0].size).toBe(size);
        expect(idl.enums.find((entry) => entry.name === "Choice")?.underlying).toBe(reported);
    }
});

test("an aliased enum keeps its width inside a struct and an array", () => {
    const declarations = `${ALIASES}\nenum class Choice : Widths::W { Only };`;
    expect(enumIdl(declarations, "    struct Inner { Choice c; uint8 t; } inner;").state.fields[0].size).toBe(4);
    expect(enumIdl(declarations, "    Array<Choice, 4> xs;").state.fields[0].size).toBe(8);
});

test("an underlying type that is not a scalar still falls back", () => {
    const idl = enumIdl(
        "namespace Widths { struct NotScalar { uint8 v; }; }\nenum class Choice : Widths::NotScalar { Only };",
        "    Choice c;\n    uint8 tail;",
    );
    expect(idl.state.fields.map((field) => [field.name, field.size])).toEqual([
        ["c", 4],
        ["tail", 1],
    ]);
    expect(idl.enums.find((entry) => entry.name === "Choice")?.underlying).toBe(AbiScalarKind.SINT32);
});

// A name written unqualified inside a namespace means that namespace's declaration. Resolved from the bare
// name instead, a sibling's or the global's width silently takes its place — the layout is wrong and every
// path agrees on it, so the table below states the C++ size for one row per declaration kind.
const UNQUALIFIED_CASES: { kind: string; declarations: string; stateFields: string; sizes: [string, number][] }[] = [
    {
        kind: "typedef shadowing a global one",
        declarations: "typedef uint64 W;\nnamespace Alpha { typedef uint8 W; struct R { W v; }; }",
        stateFields: "    Alpha::R a;",
        sizes: [["a", 1]],
    },
    {
        kind: "sibling typedefs",
        declarations: "namespace Alpha { typedef uint8 W; struct R { W v; }; }\nnamespace Beta { typedef uint64 W; struct R { W v; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "sibling struct members",
        declarations:
            "namespace Alpha { struct Base { uint8 v; }; struct M { Base b; uint8 e; }; }\nnamespace Beta { struct Base { uint64 a; uint64 b; }; struct M { Base b; uint8 e; }; }",
        stateFields: "    Alpha::M a;\n    Beta::M b;",
        sizes: [
            ["a", 2],
            ["b", 24],
        ],
    },
    {
        kind: "sibling enums",
        declarations: "namespace Alpha { enum class C : uint8 { X }; struct R { C v; }; }\nnamespace Beta { enum class C : uint64 { X }; struct R { C v; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "sibling constants as a template argument",
        declarations:
            "namespace Alpha { constexpr uint64 N = 2; struct R { Array<uint64, N> v; }; }\nnamespace Beta { constexpr uint64 N = 8; struct R { Array<uint64, N> v; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 16],
            ["b", 64],
        ],
    },
    {
        kind: "sibling constants as a C array bound",
        declarations:
            "namespace Alpha { constexpr uint64 N = 2; struct R { uint64 v[N]; }; }\nnamespace Beta { constexpr uint64 N = 8; struct R { uint64 v[N]; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 16],
            ["b", 64],
        ],
    },
    {
        kind: "sibling constants inside a bound expression",
        declarations:
            "namespace Alpha { constexpr uint64 N = 2; struct R { uint64 v[N * 2]; }; }\nnamespace Beta { constexpr uint64 N = 8; struct R { uint64 v[N * 2]; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 32],
            ["b", 128],
        ],
    },
    {
        kind: "sibling class templates",
        declarations:
            "namespace Alpha { template<typename T> struct Box { T v; }; struct R { Box<uint64> v; }; }\nnamespace Beta { template<typename T> struct Box { T v; T w; }; struct R { Box<uint64> v; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 8],
            ["b", 16],
        ],
    },
    {
        kind: "sibling container element types",
        declarations:
            "namespace Alpha { struct Rec { uint8 v; }; struct R { Array<Rec, 2> v; }; }\nnamespace Beta { struct Rec { uint64 v; }; struct R { Array<Rec, 2> v; }; }",
        stateFields: "    Alpha::R a;\n    Beta::R b;",
        sizes: [
            ["a", 2],
            ["b", 16],
        ],
    },
    {
        kind: "sibling nested struct members",
        declarations:
            "namespace Alpha { struct Inner { uint8 v; }; struct Outer { Inner i; }; }\nnamespace Beta { struct Inner { uint64 v; }; struct Outer { Inner i; }; }",
        stateFields: "    Alpha::Outer a;\n    Beta::Outer b;",
        sizes: [
            ["a", 1],
            ["b", 8],
        ],
    },
    {
        kind: "a struct named like a qpi.h type",
        declarations: "namespace Alpha { struct Entity { uint8 v; }; struct R { Entity e; }; }",
        stateFields: "    Alpha::R a;",
        sizes: [["a", 1]],
    },
    {
        kind: "member types of a class template",
        declarations:
            "namespace Alpha { struct Rec { uint8 v; }; template<typename T> struct Box { Rec r; T v; }; }\nnamespace Beta { struct Rec { uint64 v; }; template<typename T> struct Box { Rec r; T v; }; }",
        stateFields: "    Alpha::Box<uint8> a;\n    Beta::Box<uint8> b;",
        sizes: [
            ["a", 2],
            ["b", 16],
        ],
    },
];

for (const unqualified of UNQUALIFIED_CASES) {
    test(`an unqualified reference inside a namespace resolves there: ${unqualified.kind}`, () => {
        expect(sizesOf(unqualified.declarations, unqualified.stateFields)).toEqual(unqualified.sizes);
    });
}

// The other half of the same rule: a name an inner scope declares itself still wins there. Re-pointing one
// of these at the namespace breaks the exact-name lookups template bindings and member typedefs rely on.
const SHADOWING_CONTROLS: { kind: string; declarations: string; stateFields: string; sizes: [string, number][] }[] = [
    {
        kind: "a namespace declaring no such name leaves the global one",
        declarations: "typedef uint64 W;\nnamespace Alpha { struct R { W v; }; }",
        stateFields: "    Alpha::R a;",
        sizes: [["a", 8]],
    },
    {
        kind: "a nested member struct shadows the namespace struct",
        declarations: "namespace Alpha { struct Rec { uint64 a; uint64 b; }; struct R { struct Rec { uint8 v; }; Rec r; }; }",
        stateFields: "    Alpha::R a;",
        sizes: [["a", 1]],
    },
    {
        kind: "a template type parameter shadows a namespace type",
        declarations: "namespace Alpha { struct T { uint64 a; uint64 b; }; template<typename T> struct Box { T v; }; }",
        stateFields: "    Alpha::Box<uint8> a;",
        sizes: [["a", 1]],
    },
    {
        kind: "a template non-type parameter shadows a namespace constant",
        declarations: "namespace Alpha { constexpr uint64 N = 8; template<uint64 N> struct Buf { uint64 v[N]; }; }",
        stateFields: "    Alpha::Buf<2> a;",
        sizes: [["a", 16]],
    },
];

for (const control of SHADOWING_CONTROLS) {
    test(`a name declared closer in still wins: ${control.kind}`, () => {
        expect(sizesOf(control.declarations, control.stateFields)).toEqual(control.sizes);
    });
}

test("an enum in a namespace sizes and reports the alias its own namespace declares", () => {
    const declarations = `
namespace Alpha { typedef uint8 W; enum class C : W { X }; }
namespace Beta { typedef uint64 W; enum class C : W { X }; }`;

    const idl = enumIdl(declarations, "    Alpha::C a;\n    Beta::C b;");
    expect(idl.state.fields.map((field) => [field.name, field.size])).toEqual([
        ["a", 1],
        ["b", 8],
    ]);
    expect(idl.enums.filter((entry) => entry.name === "C").map((entry) => entry.underlying)).toEqual([AbiScalarKind.UINT8, AbiScalarKind.UINT64]);
});
