import { CORE_PATH } from "../../../../test-utils/paths";
// A system contract's ticker can differ from its C++ state type, such as QTRY and QUOTTERY.
// The wrapper must use the state type in its contract-state defines.
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { genWrapperWasm } from "../../src/recipe";
import { systemContracts } from "../../src/system-contracts";

const base = { contractPath: "/x/Quottery.h", slot: 2, corePath: "/core", outDir: "/out" };

test("genWrapperWasm uses stateType for the C++ struct #defines when it differs from name", () => {
  const w = genWrapperWasm({ ...base, name: "QTRY", stateType: "QUOTTERY" });
  expect(w).toContain("#define CONTRACT_STATE_TYPE QUOTTERY");
  expect(w).toContain("#define CONTRACT_STATE2_TYPE QUOTTERY2");
  expect(w).toContain("#define QUOTTERY_CONTRACT_INDEX 2");
  expect(w).not.toContain("#define CONTRACT_STATE_TYPE QTRY"); // the ticker must not be used as the struct type
});

test("genWrapperWasm defaults stateType to name (user contracts where they match)", () => {
  const w = genWrapperWasm({ ...base, name: "Counter" });
  expect(w).toContain("#define CONTRACT_STATE_TYPE Counter");
  expect(w).toContain("#define Counter_CONTRACT_INDEX 2");
});

const CORE = CORE_PATH;
test.skipIf(!existsSync(`${CORE}/src/contract_core/contract_def.h`))(
  "system catalog records the struct type distinct from the ticker",
  () => {
    const cat = systemContracts(CORE);
    const qtry = cat.find((c) => c.name === "QTRY");
    expect(qtry).toBeTruthy();
    expect(qtry!.stateType).toBe("QUOTTERY"); // ticker QTRY, struct QUOTTERY
    // contracts whose ticker == struct type still carry a matching stateType
    const qx = cat.find((c) => c.name === "QX");
    expect(qx?.stateType).toBe("QX");
  },
);
