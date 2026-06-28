import { test, expect } from "bun:test";
import { extractIdl } from "../src/idl";

const SRC = `
using namespace QPI;
enum Status { Idle, Running = 5, Stopped };          // 0, 5, 6
enum class Color : uint8 { Red, Green, Blue };       // 0, 1, 2
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData {
    uint64 counter;
    Array<uint32, 2 + 1> nums;                        // expr size -> 3
    HashMap<id, uint64, 1024> bal;
  };
  struct LogMsg { uint32 _contractIndex; uint32 _type; uint64 amount; sint8 _terminator; };
  struct Get_input {}; struct Get_output { uint64 n; };
  struct Set_input { uint64 v; id who; }; struct Set_output {};
  struct Grant_input { id to; }; struct Grant_output { uint64 total; };
  PUBLIC_FUNCTION(Get) {}
  PUBLIC_PROCEDURE(Set) {}
  PUBLIC_PROCEDURE(Grant) {}
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); REGISTER_USER_PROCEDURE(Set, 2); REGISTER_USER_PROCEDURE(Grant, 3); }
  INITIALIZE() {}
};`;

const idl = extractIdl(SRC, "Test");

test("extractIdl: functions keyed by inputType, in/out fmt + fields", () => {
  expect(idl.name).toBe("Test");
  expect(idl.functions["1"].name).toBe("Get");
  expect(idl.functions["1"].in).toBe("");                       // empty Get_input
  expect(idl.functions["1"].out).toBe("uint64");
  expect(idl.functions["1"].outFields!.map((f) => [f.name, f.type])).toEqual([["n", "uint64"]]);
});

test("extractIdl: procedures with multi-field input -> in fmt + named inFields", () => {
  expect(idl.procedures["2"].name).toBe("Set");
  expect(idl.procedures["2"].in).toBe("uint64, id");
  expect(idl.procedures["2"].inFields.map((f) => [f.name, f.type])).toEqual([["v", "uint64"], ["who", "id"]]);
});

test("extractIdl: procedure output type captured (_output), empty stays falsy", () => {
  expect(idl.procedures["3"].name).toBe("Grant");
  expect(idl.procedures["3"].out).toBe("uint64");                  // decoded in the IDE trace/debugger, not raw hex
  expect(idl.procedures["3"].outFields!.map((f) => [f.name, f.type])).toEqual([["total", "uint64"]]);
  expect(idl.procedures["2"].out).toBe("");                        // empty Set_output -> falsy -> no spurious decode
});

test("extractIdl: StateData fields + Array<T,expr> size eval", () => {
  const names = idl.state!.map((f) => f.name);
  expect(names).toEqual(["counter", "nums", "bal"]);
  expect(idl.state!.find((f) => f.name === "nums")!.type).toBe("[3;uint32]");   // 2+1 evaluated
});

test("extractIdl: HashMap expands to the exact C++ struct layout + container meta", () => {
  const bal = idl.state!.find((f) => f.name === "bal")!;
  // [L; {key,val}] then [ceil(2L/64); uint64] flags then _population, _markRemovalCounter
  expect(bal.type).toBe("{ [1024;{ id, uint64 }], [32;uint64], uint64, uint64 }");
  expect(bal.container).toEqual({ kind: "hashmap", keyFmt: "id", valFmt: "uint64", capacity: 1024 });
});

test("extractIdl: enums (auto-increment, explicit value continues, enum class + base)", () => {
  const status = idl.enums!.find((e) => e.name === "Status")!;
  expect(status.members).toEqual({ "0": "Idle", "5": "Running", "6": "Stopped" });
  const color = idl.enums!.find((e) => e.name === "Color")!;
  expect(color.members).toEqual({ "0": "Red", "1": "Green", "2": "Blue" });
});

test("extractIdl: log catalog = flat _terminator structs only; container structs skipped", () => {
  expect(idl.logStructs).toEqual([{ name: "LogMsg", fmt: "uint32, uint32, uint64", fields: ["_contractIndex", "_type", "amount"] }]);
  // CONTRACT_STATE_TYPE has a nested `struct` body -> excluded even though its text contains "_terminator"
  expect(idl.logStructs!.some((s) => s.name === "CONTRACT_STATE_TYPE")).toBe(false);
});

test("extractIdl: empty / no-StateData / comment stripping / unknown type passthrough", () => {
  const empty = extractIdl("", "X");
  expect(empty).toEqual({ name: "X", functions: {}, procedures: {} });   // no state/logStructs/enums keys
  const noState = extractIdl(`struct CONTRACT_STATE_TYPE { struct Foo_input { uint64 a; }; PUBLIC_FUNCTION(Foo) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Foo, 1); } };`, "N");
  expect(noState.state).toBeUndefined();
  const commented = extractIdl(`struct StateData { uint64 a; /* skip */ MyType b; // trailing\n };`, "C");
  expect(commented.state!.map((f) => [f.name, f.type])).toEqual([["a", "uint64"], ["b", "MyType"]]);  // unknown type verbatim
});

test("extractIdl: _terminator at index 0 (nothing before it) is not a log struct", () => {
  const idl2 = extractIdl(`struct OnlyTerm { sint8 _terminator; };`, "Z");
  expect(idl2.logStructs).toBeUndefined();
});
