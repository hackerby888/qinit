// A typedef declared in a namespace has to stay reachable by its qualified name. Registered bare-only, two
// namespaces sharing a typedef name collapse into whichever declared last, and the loser silently changes width.
import { expect, test } from "bun:test";
import { extractIdl } from "../../src/compile/idl";

const widthsOf = (source: string) => extractIdl(source, "Namespaced", { slot: 12 }).state.fields.map((field) => [field.name, field.size, field.type.format]);

test("same-named typedefs in sibling namespaces stay distinct", () => {
    const source = `
using namespace QPI;
namespace Alpha { typedef uint8 Word; }
namespace Beta { typedef uint64 Word; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Alpha::Word narrow;
    Beta::Word wide;
  };
  INITIALIZE() {}
};`;

    expect(widthsOf(source)).toEqual([
        ["narrow", 1, "uint8"],
        ["wide", 8, "uint64"],
    ]);
});

test("a nested namespace keeps its own typedef apart from its parent's", () => {
    const source = `
using namespace QPI;
namespace Outer {
  typedef uint16 Unit;
  namespace Inner { typedef uint32 Unit; }
}
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Outer::Unit outer;
    Outer::Inner::Unit inner;
  };
  INITIALIZE() {}
};`;

    expect(widthsOf(source)).toEqual([
        ["outer", 2, "uint16"],
        ["inner", 4, "uint32"],
    ]);
});

test("a namespaced typedef of an aggregate keeps that aggregate's layout", () => {
    const source = `
using namespace QPI;
namespace Small { typedef Array<uint8, 4> Buffer; }
namespace Large { typedef Array<uint64, 4> Buffer; }
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    Small::Buffer small;
    Large::Buffer large;
  };
  INITIALIZE() {}
};`;

    expect(widthsOf(source)).toEqual([
        ["small", 4, "[4;uint8]"],
        ["large", 32, "[4;uint64]"],
    ]);
});
