// A system contract's on-chain ticker can differ from its C++ struct type (e.g. ticker QTRY -> struct QUOTTERY).
// The wrapper must #define CONTRACT_STATE_TYPE to the STRUCT type, not the ticker, or the build fails with
// "use of undeclared identifier". These pin the stateType threading.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { genWrapper } from "../src/recipe";
import { systemContracts } from "../src/system-contracts";

const base = { contractPath: "/x/Quottery.h", slot: 2, corePath: "/core", outDir: "/out" };

test("genWrapper uses stateType for the C++ struct #defines when it differs from name", () => {
  const w = genWrapper({ ...base, name: "QTRY", stateType: "QUOTTERY" });
  expect(w).toContain("#define CONTRACT_STATE_TYPE QUOTTERY");
  expect(w).toContain("#define CONTRACT_STATE2_TYPE QUOTTERY2");
  expect(w).toContain("#define QUOTTERY_CONTRACT_INDEX 2");
  expect(w).not.toContain("#define CONTRACT_STATE_TYPE QTRY"); // the ticker must not be used as the struct type
});

test("genWrapper defaults stateType to name (user contracts where they match)", () => {
  const w = genWrapper({ ...base, name: "Counter" });
  expect(w).toContain("#define CONTRACT_STATE_TYPE Counter");
  expect(w).toContain("#define Counter_CONTRACT_INDEX 2");
});

const CORE = "/home/kali/Projects/core-lite";
test.skipIf(!existsSync(`${CORE}/src/contract_core/contract_def.h`))("system catalog records the struct type distinct from the ticker", () => {
  const cat = systemContracts(CORE);
  const qtry = cat.find((c) => c.name === "QTRY");
  expect(qtry).toBeTruthy();
  expect(qtry!.stateType).toBe("QUOTTERY"); // ticker QTRY, struct QUOTTERY
  // contracts whose ticker == struct type still carry a matching stateType
  const qx = cat.find((c) => c.name === "QX");
  expect(qx?.stateType).toBe("QX");
});
