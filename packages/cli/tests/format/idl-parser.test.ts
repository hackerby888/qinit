import { test, expect } from "bun:test";
import { extractIdl } from "@qinit/build";
import { stateFieldsOf } from "../../src/trace-format";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SRC = `using namespace QPI;
constexpr uint64 CAP = 4 * 2;
constexpr uint64 HALF = div<uint64>(CAP, 2);
enum Color { Red, Green };
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Inner { uint64 x; };
  struct Wrap { struct Order { id who; uint64 amt; }; };
  struct StateData {
    unsigned int nativeU;
    int nativeI;
    uint128 big;
    Color c;
    Asset asset;
    DateAndTime when;
    Inner inner;
    Wrap::Order scoped;
    sint64 a, b, cc;
    Array<Inner, CAP> arr;
    void helper() { nativeI = 1; }
  };
  struct Get_input {}; struct Get_output { uint64 v; };
  PUBLIC_FUNCTION(Get) { }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
  INITIALIZE() {}
};`;

test("parser: native, uint128, enum, Asset, nested + scoped struct, multi-var, constexpr/div size, methods", () => {
  const sf = stateFieldsOf(extractIdl(SRC, "T"));
  const by = Object.fromEntries(sf.map((f) => [f.name, f]));
  expect(sf.some((f) => f.bad)).toBe(false); // everything resolves
  expect(by.nativeU.size).toBe(4); // unsigned int -> uint32
  expect(by.nativeI.size).toBe(4); // int -> sint32
  expect(by.big.size).toBe(16); // uint128
  expect(by.c.size).toBe(4); // enum -> uint32
  expect(by.asset.size).toBe(40); // Asset { id(32), uint64(8) }
  expect(by.when.size).toBe(8); // DateAndTime -> uint64
  expect(by.inner.size).toBe(8); // custom struct { uint64 }
  expect(by.scoped.size).toBe(40); // Wrap::Order { id, uint64 }
  expect(by.a.size).toBe(8);
  expect(by.b.size).toBe(8);
  expect(by.cc.size).toBe(8); // multi-var split
  expect(by.arr.size).toBe(8 * 8); // Array<Inner, CAP=8> stride 8
  expect(by.helper).toBeUndefined(); // method stripped, not a field
});

test("parser: unresolvable field type degrades gracefully (marks bad + stops)", () => {
  const bad = `struct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { uint64 ok; Array<X, SOME_EXTERNAL_DEFINE> nope; uint64 after; }; INITIALIZE() {} };`;
  const sf = stateFieldsOf(extractIdl(bad, "B"));
  expect(sf[0].name).toBe("ok");
  expect(sf.find((f) => f.bad)?.name).toBe("nope"); // unsizable -> bad
  expect(sf.some((f) => f.name === "after")).toBe(false); // stops (later offsets unknown)
});

// Optional sweep: every system contract parses without crashing (skipped if the core checkout isn't present).
const CORE_CONTRACTS = process.env.QINIT_CORE
  ? join(process.env.QINIT_CORE, "src", "contracts")
  : undefined;
test.skipIf(!CORE_CONTRACTS || !existsSync(CORE_CONTRACTS))(
  "sweep: all system contracts parse without throwing",
  () => {
    for (const f of readdirSync(CORE_CONTRACTS!).filter(
      (x) => x.endsWith(".h") && !["qpi.h", "math_lib.h"].includes(x),
    )) {
      expect(() =>
        stateFieldsOf(
          extractIdl(readFileSync(join(CORE_CONTRACTS!, f), "utf8"), f.replace(".h", "")),
        ),
      ).not.toThrow();
    }
  },
);

test("bare struct name resolves to the shallowest (contract-level) struct, not a nested same-named shadow", () => {
  const src = `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Order { id a; sint64 b; };                 // contract-level: id(32)+sint64(8) = 40
  struct StateData { Array<Order, 4> q; };
  struct Foo_output { struct Order { id a; sint64 b; sint64 c; }; Order x; };   // deeper shadow: 48
  INITIALIZE() {}
};`;
  const q = stateFieldsOf(extractIdl(src, "T")).find((f) => f.name === "q")!;
  expect(q.size).toBe(160); // 4 * contract-level Order(40); the nested 48-byte Order must NOT shadow it
});

test("enum underlying type sizes the field (enum class : uint8 -> 1B, not 4B)", () => {
  const src = `using namespace QPI;
enum class EState : uint8 { A, B };
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint8 a; EState s; uint16 b; uint64 tail; };
  INITIALIZE() {}
};`;
  const by = Object.fromEntries(stateFieldsOf(extractIdl(src, "T")).map((f) => [f.name, f]));
  expect(by.s.size).toBe(1); // enum class : uint8 -> 1 byte
  expect(by.b.off).toBe(2); // a(1)+s(1) -> uint16 at 2 (would be 6 if s were uint32)
  expect(by.tail.off).toBe(8);
});

test("BitArray<L> and bit_4096 size as uint64[ceil(L/64)]", () => {
  const src = `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { BitArray<256> flags; bit_4096 big; uint64 n; };
  INITIALIZE() {}
};`;
  const by = Object.fromEntries(stateFieldsOf(extractIdl(src, "T")).map((f) => [f.name, f]));
  expect(by.flags.size).toBe(32); // 256/64 = 4 uint64 = 32B
  expect(by.big.size).toBe(512); // 4096/64 = 64 uint64 = 512B
});

test("typedef alias resolves to its target type", () => {
  const src = `using namespace QPI;
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Order { id a; sint64 b; };
  typedef Order _Order;
  struct StateData { _Order o; };
  INITIALIZE() {}
};`;
  expect(stateFieldsOf(extractIdl(src, "T")).find((f) => f.name === "o")!.size).toBe(40); // id(32)+sint64(8)
});
