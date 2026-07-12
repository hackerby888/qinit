import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCalleePrelude, scanCallees } from "../../src/intercontract";

test("scanCallees finds CALL_OTHER_CONTRACT_FUNCTION + INVOKE_OTHER_CONTRACT_PROCEDURE names", () => {
  const s = "CALL_OTHER_CONTRACT_FUNCTION(QX, a, b); INVOKE_OTHER_CONTRACT_PROCEDURE(Foo, c, d, 0);";
  expect([...scanCallees(s)].sort()).toEqual(["Foo", "QX"]);
});

test("buildCalleePrelude returns '' when the contract makes no inter-contract calls (no core touched)", () => {
  expect(buildCalleePrelude("/no/such/core", "state.mut().n += 1;")).toBe("");
});

test("buildCalleePrelude emits guarded callee CONTRACT_INDEX + inputType constants", () => {
  // a minimal stub core so parseContractDef finds an (empty) contract_def.h; the callee comes from `dyn`
  const root = mkdtempSync(join(tmpdir(), "ic-"));
  try {
    mkdirSync(join(root, "src", "contract_core"), { recursive: true });
    writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");
    const callee = join(root, "QX.h");
    writeFileSync(callee, `struct CONTRACT_STATE_TYPE : public ContractBase {
      struct Get_input {}; struct Get_output {};
      REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
    };`);
    const prelude = buildCalleePrelude(root, "CALL_OTHER_CONTRACT_FUNCTION(QX, in, out);", { QX: { header: callee, index: 1 } });
    // the QUtil fix: a contract using `id(QX_CONTRACT_INDEX, …)` needs the callee index in the single-
    // contract TU (no contract_def.h) — guarded so the full build's #define still wins.
    expect(prelude).toContain("#ifndef QX_CONTRACT_INDEX");
    expect(prelude).toContain("#define QX_CONTRACT_INDEX 1");
    expect(prelude).toContain("QX_Get_inputType = 1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
