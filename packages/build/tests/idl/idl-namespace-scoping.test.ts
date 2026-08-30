// Every kind of declaration a namespace can hold has to stay addressable by its qualified name. Indexed by
// bare name alone, two namespaces sharing a name collapse into whichever registered last — silently, with
// the loser's width changing under it. The table below is the invariant: one row per declaration kind.
import { expect, test } from "bun:test";
import { extractIdl } from "../../src/compile/idl";

const contract = (declarations: string, stateFields: string) => `
using namespace QPI;
${declarations}
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
${stateFields}
  };
  INITIALIZE() {}
};`;

const sizesOf = (declarations: string, stateFields: string) =>
    extractIdl(contract(declarations, stateFields), "Scoped", { slot: 15 }).state.fields.map((field) => [field.name, field.size]);

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
