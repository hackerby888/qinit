import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCommandInvocation } from "../../src/args";
import { resolveGtestSlot } from "../../src/commands/deploy-interact/gtest";

const core = mkdtempSync(join(tmpdir(), "qinit-gtest-slot-"));
const contractCore = join(core, "src", "contract_core");
mkdirSync(contractCore, { recursive: true });
writeFileSync(
  join(contractCore, "contract_def.h"),
  `#define LAST_CONTRACT_INDEX 40
#define CONTRACT_INDEX LAST_CONTRACT_INDEX
#ifdef LITE_WASM_SC
constexpr unsigned short WASM_RESERVED_SLOT_BASE = (CONTRACT_INDEX + 1);
constexpr unsigned short WASM_RESERVED_SLOT_COUNT = 2;
constexpr unsigned short LITEDYN0_CONTRACT_INDEX = WASM_RESERVED_SLOT_BASE + 0;
constexpr unsigned short LITEDYN1_CONTRACT_INDEX = WASM_RESERVED_SLOT_BASE + 1;
#endif
`,
);

afterAll(() => {
  rmSync(core, { recursive: true, force: true });
});

test("gtest defaults to the selected core's first Wasm slot", () => {
  expect(resolveGtestSlot(core)).toBe(41);
});

test("gtest accepts only integer contract slots", () => {
  expect(resolveGtestSlot(core, "1")).toBe(1);
  expect(resolveGtestSlot(core, "100")).toBe(100);
  expect(resolveGtestSlot(core, "1023")).toBe(1023);

  for (const slot of ["", "0", "1.5", "1024", "NaN"]) {
    expect(() => resolveGtestSlot(core, slot)).toThrow(
      "contract slot must be an integer from 1 to 1023",
    );
  }
});

test("gtest accepts repeated callee declarations", () => {
  const invocation = parseCommandInvocation("gtest", [
    "tests/Proxy.test.cpp",
    "--callee",
    "Counter=contracts/Counter.h",
    "--callee",
    "Oracle=contracts/Oracle.h@42",
  ]);

  expect(invocation.commandArgs.getAll("callee")).toEqual([
    "Counter=contracts/Counter.h",
    "Oracle=contracts/Oracle.h@42",
  ]);
});
