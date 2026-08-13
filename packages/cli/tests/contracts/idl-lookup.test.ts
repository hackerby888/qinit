// The explorer reads a transaction's input with nothing but its inputType and the contract's IDL, so
// these pin the two halves it depends on: naming an entry, and decoding bytes back to readable values.
import { expect, test } from "bun:test";
import { extractIdl } from "@qinit/build";
import { encodeInput } from "@qinit/proto";
import { decodeTxInput, entryFor } from "../../src/contracts/idl-lookup";
import { entryLabel } from "../../src/commands/deploy-interact/explorer/chrome";

const SOURCE = `
using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 counter; };

  struct IssueAsset_input { uint64 assetName; sint64 numberOfShares; sint8 decimals; };
  typedef NoData IssueAsset_output;
  PUBLIC_PROCEDURE(IssueAsset)
  {
    state.mut().counter = input.assetName;
  }

  struct Point { sint32 x; sint32 y; };
  struct Move_input { Point at; uint64 when; };
  typedef NoData Move_output;
  PUBLIC_PROCEDURE(Move)
  {
    state.mut().counter = input.when;
  }

  typedef NoData Ping_input;
  typedef NoData Ping_output;
  PUBLIC_PROCEDURE(Ping)
  {
    state.mut().counter = 1;
  }

  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {
    REGISTER_USER_PROCEDURE(IssueAsset, 1);
    REGISTER_USER_PROCEDURE(Ping, 2);
    REGISTER_USER_PROCEDURE(Move, 3);
  }
};
`;

const idl = extractIdl(SOURCE, "Sample", { slot: 4 });
const idls = new Map([[4, idl]]);
const entryNamed = (name: string) => idl.procedures.find((entry) => entry.name === name)!;

test("an entry is resolved by slot and inputType, and named", () => {
    expect(entryFor(4, 1, idls)?.name).toBe("IssueAsset");
    expect(entryFor(4, 99, idls)).toBeUndefined();
    expect(entryFor(9, 1, idls)).toBeUndefined();
    expect(entryFor(null, 1, idls)).toBeUndefined();

    expect(entryLabel(4, 1, idls)).toBe("1 IssueAsset");
    expect(entryLabel(4, 0, idls)).toBe("0");
    expect(entryLabel(null, 3, idls)).toBe("3");
});

test("input bytes decode to named fields and back to the --in format", async () => {
    const entry = entryNamed("IssueAsset");
    const bytes = await encodeInput("1096040772uint64, 1000000000sint64, -3sint8");

    const decoded = await decodeTxInput(entry, bytes);

    expect(decoded.fields).toEqual([
        ["assetName", "1096040772"],
        ["numberOfShares", "1000000000"],
        ["decimals", "-3"],
    ]);
    expect(decoded.format).toBe("1096040772uint64, 1000000000sint64, -3sint8");
    expect(await encodeInput(decoded.format!)).toEqual(bytes);
});

test("a short input is zero-padded the way the engine's dispatch frame pads it", async () => {
    const entry = entryNamed("IssueAsset");
    const full = await encodeInput("7uint64, 0sint64, 0sint8");

    const decoded = await decodeTxInput(entry, full.subarray(0, 8));

    expect(decoded.fields.map(([, value]) => value)).toEqual(["7", "0", "0"]);
});

// A struct field is a record, not a list: it has to keep its own field names rather than collapse to
// the positional array the ABI decoder hands back.
test("a nested struct field keeps its field names", async () => {
    const entry = entryNamed("Move");
    const bytes = await encodeInput("{1sint32, 2sint32}, 3026uint64");

    const decoded = await decodeTxInput(entry, bytes);

    expect(decoded.fields).toEqual([
        ["at", "{x: 1, y: 2}"],
        ["when", "3026"],
    ]);
});

test("an entry with no input has nothing to show", async () => {
    const decoded = await decodeTxInput(entryNamed("Ping"), new Uint8Array(0));

    expect(decoded.fields).toEqual([]);
    expect(decoded.format).toBeUndefined();
});
