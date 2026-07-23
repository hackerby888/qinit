import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configuredContractIdentity,
  contractStateType,
  findContractCandidates,
  findProjectRoot,
  isQpiContractSource,
  selectTestContract,
  testContractType,
} from "../../src/project-util";

test("QPI contract detection ignores comments and string literals", () => {
  expect(contractStateType("struct Counter : public ContractBase {}")).toBe("Counter");
  expect(contractStateType("class Counter final : ContractBase {}")).toBe("Counter");
  expect(isQpiContractSource("// struct Fake : public ContractBase {}")).toBe(false);
  expect(isQpiContractSource('const char* text = "struct Fake : ContractBase";')).toBe(false);
  expect(isQpiContractSource("struct Plain {}")).toBe(false);
});

test("test contract type prefers INIT_CONTRACT and ignores comments", () => {
  const source = `
    // INIT_CONTRACT(Wrong)
    class ContractTestingFallback {};
    void init() { INIT_CONTRACT(Counter); }
  `;
  expect(testContractType(source)).toBe("Counter");
});

test("test pairing uses its type and only falls back to one contract", () => {
  const counter = { path: "/work/Counter.h", stateType: "Counter" };
  const token = { path: "/work/Token.h", stateType: "Token" };

  expect(selectTestContract("INIT_CONTRACT(Token)", [counter, token])).toEqual(token);
  expect(selectTestContract("TEST(X, Y) {}", [counter])).toEqual(counter);
  expect(selectTestContract("TEST(X, Y) {}", [counter, token])).toBeUndefined();
  expect(selectTestContract("INIT_CONTRACT(Missing)", [counter, token])).toBeUndefined();
});

test("project and contract discovery work without qinit.json", () => {
  const root = mkdtempSync(join(tmpdir(), "qpi-project-"));
  try {
    mkdirSync(join(root, "contracts"));
    mkdirSync(join(root, "tests"));
    writeFileSync(
      join(root, "contracts", "Counter.h"),
      "struct Counter : public ContractBase {};",
    );
    writeFileSync(join(root, "contracts", "Plain.h"), "struct Plain {};");

    expect(findProjectRoot(join(root, "tests", "Counter.test.cpp"))).toBeUndefined();
    expect(findContractCandidates(root)).toEqual([
      {
        path: join(root, "contracts", "Counter.h"),
        stateType: "Counter",
      },
    ]);

    writeFileSync(
      join(root, "qinit.json"),
      JSON.stringify({
        name: "Counter",
        contract: "contracts/Counter.h",
        slot: 42,
      }),
    );
    expect(findProjectRoot(join(root, "tests", "Counter.test.cpp"))).toBe(root);
    expect(
      configuredContractIdentity(join(root, "contracts", "Counter.h")),
    ).toEqual({
      name: "Counter",
      slot: 42,
    });
    expect(
      configuredContractIdentity(join(root, "contracts", "Plain.h")),
    ).toEqual({});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
