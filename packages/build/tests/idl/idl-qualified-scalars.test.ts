// A namespace-qualified QPI scalar has to lay out exactly as its bare spelling. sizeOfType strips the
// qualifier before it looks a name up; alignment has to strip it too, or every field after the first moves.
import { expect, test } from "bun:test";
import { extractIdl, parseContractIdl, type ContractIdl } from "../../src/compile/idl";

const contract = (qualifier: string) => `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint8 pad;
    ${qualifier}uint64 wide;
    ${qualifier}id owner;
    ${qualifier}sint16 small;
  };
  struct Ask_input { ${qualifier}uint64 value; };
  struct Ask_output { ${qualifier}id caller; };
  PUBLIC_FUNCTION(Ask) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_FUNCTION(Ask, 1);
  }
  INITIALIZE() {}
};`;

const stateShape = (idl: ContractIdl) => ({
    fields: idl.state.fields.map((field) => [field.name, field.offset, field.size, field.type.align, field.type.format]),
    size: idl.state.size,
    align: idl.state.align,
});

const qualified = extractIdl(contract("QPI::"), "Qualified", { slot: 11 });
const bare = extractIdl(contract(""), "Qualified", { slot: 11 });

test("a QPI-qualified scalar lays out identically to its bare spelling", () => {
    expect(stateShape(qualified)).toEqual(stateShape(bare));

    // Pinned outright as well: a shared regression would move both spellings and still compare equal.
    expect(stateShape(qualified)).toEqual({
        fields: [
            ["pad", 0, 1, 1, "uint8"],
            ["wide", 8, 8, 8, "uint64"],
            ["owner", 16, 32, 8, "id"],
            ["small", 48, 2, 2, "sint16"],
        ],
        size: 56,
        align: 8,
    });
});

test("a QPI-qualified entry ABI matches the bare one and passes the validator", () => {
    expect(qualified.functions[0].input).toEqual(bare.functions[0].input);
    expect(qualified.functions[0].output).toEqual(bare.functions[0].output);
    expect([qualified.functions[0].inSize, qualified.functions[0].outSize]).toEqual([8, 32]);

    // The alignment the compiler reports is the one proto recomputes, so a wrong one is rejected here.
    expect(() => parseContractIdl(qualified)).not.toThrow();
});
