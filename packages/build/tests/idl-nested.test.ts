// Nested-type IDL extraction: a contract field that is a struct (or Array<struct>) must parse into a named
// field TREE (Field.struct / .array), not collapse to an opaque format token — and same-name nested structs in
// different parents must each resolve to their OWN definition (scoped). Driven by the real QX/QEARN/Quottery
// headers (rich nested order-book + state types) plus a synthetic alignment case. Also pins two bugs this work
// fixes: a nested `struct` definition leaking as a junk field, and a bare same-name collision.
import { test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { extractIdl, type Field } from "../src/idl";

const CORE = "/home/kali/Projects/core-lite/src/contracts";
const have = (c: string) => existsSync(`${CORE}/${c}.h`);
const idlOf = (c: string) => extractIdl(readFileSync(`${CORE}/${c}.h`, "utf8"), c);
const fn = (idl: ReturnType<typeof extractIdl>, name: string) => Object.values(idl.functions).find((e) => e.name === name)!;
const proc = (idl: ReturnType<typeof extractIdl>, name: string) => Object.values(idl.procedures).find((e) => e.name === name)!;
const allFields = (idl: ReturnType<typeof extractIdl>): Field[] =>
  Object.values({ ...idl.functions, ...idl.procedures }).flatMap((e) => [...(e.inFields ?? []), ...(e.outFields ?? [])]);

test.skipIf(!have("Qx"))("QX: nested struct definition no longer leaks as a junk field", () => {
  const idl = idlOf("Qx");
  // the inner `struct Order {...}` inside the *_output structs must not appear as a data field
  expect(allFields(idl).some((f) => f.name === "Order")).toBe(false);
  // AssetAskOrders_output therefore has exactly one real field: `orders`
  const out = fn(idl, "AssetAskOrders").outFields!;
  expect(out.map((f) => f.name)).toEqual(["orders"]);
});

test.skipIf(!have("Qx"))("QX: same-name nested `Order` resolves per parent (scoped, not first-declared)", () => {
  const idl = idlOf("Qx");
  // Asset order book: Order = { id entity; sint64 price; sint64 numberOfShares }  (3 fields)
  expect(fn(idl, "AssetAskOrders").out).toBe("[256;{ id, sint64, sint64 }]");
  // Entity order book: Order = { id issuer; uint64 assetName; sint64 price; sint64 numberOfShares } (4 fields)
  // — a bare-name lookup would WRONGLY reuse the Asset 3-field Order here.
  expect(fn(idl, "EntityAskOrders").out).toBe("[256;{ id, uint64, sint64, sint64 }]");
  expect(fn(idl, "EntityBidOrders").out).toBe("[256;{ id, uint64, sint64, sint64 }]");
});

test.skipIf(!have("Qx"))("QX: array-of-struct output carries the element field tree", () => {
  const orders = fn(idlOf("Qx"), "EntityAskOrders").outFields![0];
  expect(orders.name).toBe("orders");
  expect(orders.array).toBe(true);
  expect(orders.struct?.map((f) => [f.name, f.type])).toEqual([
    ["issuer", "id"], ["assetName", "uint64"], ["price", "sint64"], ["numberOfShares", "sint64"],
  ]);
});

test.skipIf(!have("Qx"))("QX: nested `Asset` input resolves to a named struct tree", () => {
  const asset = proc(idlOf("Qx"), "TransferShareManagementRights").inFields[0];
  expect(asset.name).toBe("asset");
  expect(asset.array).toBeUndefined();
  expect(asset.struct?.map((f) => [f.name, f.type])).toEqual([["issuer", "id"], ["assetName", "uint64"]]);
});

test.skipIf(!have("Quottery"))("Quottery: CreateEvent nested input struct keeps its member names", () => {
  const idl = idlOf("Quottery");
  const e = proc(idl, "CreateEvent") ?? fn(idl, "CreateEvent");
  const nested = e.inFields[0];
  expect(nested.struct).toBeTruthy();
  expect(nested.struct!.map((f) => f.name)).toContain("eid");
});

test.skipIf(!have("Qearn"))("QEARN: deep Array<struct> state parses to a nested tree (no crash)", () => {
  const idl = idlOf("Qearn");
  expect(idl.state).toBeTruthy();
  const arrayOfStruct = idl.state!.filter((f) => f.array && f.struct);
  expect(arrayOfStruct.length).toBeGreaterThan(0);
  // every element field of those arrays is itself named (not opaque)
  for (const f of arrayOfStruct) expect(f.struct!.every((c) => typeof c.name === "string" && c.name.length)).toBe(true);
});

test("synthetic: nested struct with trailing pad keeps the braced layout (alignment preserved)", () => {
  // Padded = { uint64 a; uint8 b } -> size 16 (pad 9..16); Outer = { Padded p; uint8 c } -> c at @16
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Padded { uint64 a; uint8 b; };
  struct Wrap_input { Padded p; uint8 c; }; struct Wrap_output {};
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Wrap, 1); }
};`;
  const idl = extractIdl(SRC, "S");
  const e = Object.values(idl.procedures).find((x) => x.name === "Wrap")!;
  expect(e.in).toBe("{ uint64, uint8 }, uint8"); // braces preserve the nested struct's own alignment/pad
  expect(e.inFields[0].struct?.map((f) => f.name)).toEqual(["a", "b"]);
});

test("synthetic: deeply nested struct (struct in struct in array) resolves fully", () => {
  const SRC = `
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct Leaf { sint64 v; };
  struct Mid { Leaf leaf; uint32 tag; };
  struct Deep_input {}; struct Deep_output { Array<Mid, 4> mids; };
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Deep, 1); }
};`;
  const mids = Object.values(extractIdl(SRC, "S").functions)[0].outFields![0];
  expect(mids.array).toBe(true);
  expect(mids.struct?.map((f) => f.name)).toEqual(["leaf", "tag"]);
  const leaf = mids.struct!.find((f) => f.name === "leaf")!;
  expect(leaf.struct?.map((f) => [f.name, f.type])).toEqual([["v", "sint64"]]);
});
