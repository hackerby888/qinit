// resolveContract is the single target-resolution path for call / ls / state: a name or index must map to
// the same contract everywhere, with user (dyn-registry) entries shadowing built-in system contracts.
import { test, expect } from "bun:test";
import { resolveContract, systemAsDyn, type ContractSets } from "../src/contracts";

const user = (over: any = {}) => ({
  index: 100, name: "MyToken", armed: true, constructed: true, version: 0, codeHash: "", source: "USER_SRC", ...over,
});
const sys = (over: any = {}) => ({
  index: 1, name: "QX", file: "QX.h", source: "SYS_SRC",
  idl: { name: "QX", functions: {}, procedures: {} } as any, ...over,
});
const sets = (over: Partial<ContractSets> = {}): ContractSets => ({ user: [], system: [], ...over });

test("resolveContract: matches a user contract by case-insensitive name", () => {
  const r = resolveContract("mytoken", sets({ user: [user()] as any }));

  expect(r).toEqual({ index: 100, name: "MyToken", kind: "user", source: "USER_SRC" });
});

test("resolveContract: matches by numeric index", () => {
  const r = resolveContract("1", sets({ system: [sys()] as any }));

  expect(r?.kind).toBe("system");
  expect(r?.index).toBe(1);
});

test("resolveContract: user contracts shadow system on an index/name collision", () => {
  const r = resolveContract("1", sets({ user: [user({ index: 1, name: "Mine" })] as any, system: [sys()] as any }));

  expect(r?.kind).toBe("user");
  expect(r?.name).toBe("Mine");
});

test("resolveContract: falls through to system when not a user contract", () => {
  const r = resolveContract("QX", sets({ user: [user()] as any, system: [sys()] as any }));

  expect(r?.kind).toBe("system");
  expect(r?.name).toBe("QX");
});

test("resolveContract: trims surrounding whitespace before matching", () => {
  const r = resolveContract("  MyToken  ", sets({ user: [user()] as any }));

  expect(r?.index).toBe(100);
});

test("resolveContract: an unmatched target resolves to null", () => {
  expect(resolveContract("ghost", sets({ user: [user()] as any, system: [sys()] as any }))).toBeNull();
});

test("resolveContract: a non-numeric target never matches an index by accident", () => {
  const r = resolveContract("notanumber", sets({ user: [user({ name: "" })] as any }));

  expect(r).toBeNull();
});

test("resolveContract: an unnamed user contract reports its index as the name", () => {
  const r = resolveContract("100", sets({ user: [user({ name: "" })] as any }));

  expect(r).toEqual({ index: 100, name: "100", kind: "user", source: "USER_SRC" });
});

test("systemAsDyn: presents a system contract as an armed, constructed DynContract", () => {
  const c = sys({ idl: { name: "QX", functions: { "1": { name: "Get", in: "", out: "uint64" } }, procedures: { "2": { name: "Set", in: "uint64", out: "" } } } });
  const d = systemAsDyn(c as any);

  expect(d.index).toBe(1);
  expect(d.name).toBe("QX");
  expect(d.armed).toBe(true);
  expect(d.constructed).toBe(true);
  expect(d.source).toBe("SYS_SRC");
  expect(d.functions.map((f) => f.inputType)).toEqual([1]);
  expect(d.procedures.map((p) => p.inputType)).toEqual([2]);
});
