import { test, expect } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { systemContracts, systemNames } from "@qinit/build";
import { resolveContract, type ContractSets } from "../../src/contracts";

// --- catalog parse over an inline fixture core tree ---
test("systemContracts: parses contract_def.h index->name->file + IDL", () => {
  const root = join(tmpdir(), `sc-fix-${process.pid}`);
  mkdirSync(join(root, "src", "contract_core"), { recursive: true });
  mkdirSync(join(root, "src", "contracts"), { recursive: true });
  writeFileSync(
    join(root, "src", "contract_core", "contract_def.h"),
    `
#include "contracts/qpi.h"
#define FOO_CONTRACT_INDEX 1
#include "contracts/Foo.h"
#define BAR_CONTRACT_INDEX 2
#include "contracts/Bar.h"
constexpr struct ContractDescription contractDescriptions[] = {
  {"", 0, 0, 0},
  {"FOO", 10, 1, 0},
  {"BAR", 20, 1, 0},
};`,
  );
  const c = (p: string, fn: string) =>
    writeFileSync(
      join(root, "src", "contracts", p),
      `using namespace QPI;\nstruct CONTRACT_STATE2_TYPE {};\nstruct CONTRACT_STATE_TYPE : public ContractBase { struct StateData { uint64 n; }; struct ${fn}_input {}; struct ${fn}_output { uint64 v; }; PUBLIC_FUNCTION(${fn}) {} REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(${fn}, 1); } INITIALIZE() {} };`,
    );
  c("Foo.h", "GetFoo");
  c("Bar.h", "GetBar");
  const cat = systemContracts(root);
  expect(cat.map((x) => [x.index, x.name, x.file])).toEqual([
    [1, "FOO", "Foo.h"],
    [2, "BAR", "Bar.h"],
  ]);
  expect(Object.values(cat[0].idl.functions).map((f: any) => f.name)).toEqual(["GetFoo"]);
  expect(systemNames(root)).toEqual(new Set(["foo", "bar"]));
  rmSync(root, { recursive: true, force: true });
});

// --- resolution: user matched before system ---
test("resolveContract: user before system; by name or index", () => {
  const sets: ContractSets = {
    user: [
      {
        index: 28,
        name: "MyTok",
        armed: true,
        constructed: true,
        version: 1,
        codeHash: "",
        functions: [],
        procedures: [],
        source: "u",
      } as any,
    ],
    system: [
      {
        index: 1,
        name: "QX",
        file: "Qx.h",
        source: "s",
        idl: { name: "QX", functions: {}, procedures: {} },
      } as any,
    ],
  };
  expect(resolveContract("MyTok", sets)?.kind).toBe("user");
  expect(resolveContract("28", sets)?.index).toBe(28);
  expect(resolveContract("QX", sets)?.kind).toBe("system");
  expect(resolveContract("1", sets)?.name).toBe("QX");
  expect(resolveContract("nope", sets)).toBeNull();
});

// --- snapshot sweep (skipped if no `qinit node run` snapshot) ---
test("systemContracts: snapshot catalog has QX/QEARN with fns", () => {
  const snap = join(homedir(), ".cache", "qinit", "qinit-v0.0.31", "core-headers"); // $HOME is unset on Windows
  if (!existsSync(snap)) return;
  const cat = systemContracts(snap);
  const qx = cat.find((c) => c.name === "QX");
  expect(qx).toBeDefined();
  expect(Object.keys(qx!.idl.functions).length).toBeGreaterThan(0);
});
