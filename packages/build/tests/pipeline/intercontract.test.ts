import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    buildCalleePrelude,
    contractIndexDefines,
    parseContractDef,
    scanCallees,
} from "../../src/intercontract";

test("contract_def wrappers keep the existing static contract rules", () => {
    const root = mkdtempSync(join(tmpdir(), "contract-def-"));
    try {
        const contractCore = join(root, "src", "contract_core");
        mkdirSync(contractCore, { recursive: true });
        writeFileSync(
            join(contractCore, "contract_def.h"),
            `
#define FIRST_CONTRACT_INDEX 1
#define CONTRACT_INDEX FIRST_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE FirstState
#define CONTRACT_STATE2_TYPE FirstState2
#include "contracts/First.h"

constexpr TESTEX_CONTRACT_INDEX = (CONTRACT_INDEX + 1);
#define CONTRACT_INDEX TESTEX_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE TestState
#define CONTRACT_STATE2_TYPE TestState2
#include "contracts/TestExample.h"

#define LITEDYN_CONTRACT_INDEX WASM_RESERVED_SLOT_BASE
#define CONTRACT_INDEX LITEDYN_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE DynamicState
#define CONTRACT_STATE2_TYPE DynamicState2
#include "extensions/wasm/contract.h"

#define QSWAP_CONTRACT_INDEX 13
#define CONTRACT_INDEX QSWAP_CONTRACT_INDEX
#define CONTRACT_STATE_TYPE QSWAP
#define CONTRACT_STATE2_TYPE QSWAP2
#ifdef OLD_QSWAP
#include "contracts/Qswap_old.h"
#else
#include "contracts/Qswap.h"
#endif
`,
        );

        expect([...parseContractDef(root)]).toEqual([
            [
                "FirstState",
                {
                    type: "FirstState",
                    index: 1,
                    include: "contracts/First.h",
                },
            ],
            [
                "QSWAP",
                {
                    type: "QSWAP",
                    index: 13,
                    include: "contracts/Qswap.h",
                },
            ],
        ]);
        expect(contractIndexDefines(root)).toBe(
            "// ---- all contract indices (contract_def.h) so a directly-#included sibling resolves ----\n" +
                "#ifndef FIRST_CONTRACT_INDEX\n#define FIRST_CONTRACT_INDEX 1\n#endif\n" +
                "#ifndef QSWAP_CONTRACT_INDEX\n#define QSWAP_CONTRACT_INDEX 13\n#endif\n",
        );
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("contract_def wrappers preserve missing-file behavior", () => {
    expect(contractIndexDefines("/no/such/core")).toBe("");
    expect(() => parseContractDef("/no/such/core")).toThrow();
});

test("scanCallees finds CALL_OTHER_CONTRACT_FUNCTION + INVOKE_OTHER_CONTRACT_PROCEDURE names", () => {
    const s =
        "CALL_OTHER_CONTRACT_FUNCTION(QX, a, b); INVOKE_OTHER_CONTRACT_PROCEDURE(Foo, c, d, 0);";
    expect([...scanCallees(s)].sort()).toEqual(["Foo", "QX"]);
});

test("scanCallees finds qualified types and constants but ignores comments", () => {
    const source = `
    QX::Transfer_input input{};
    const auto fee = RL_MAX_FEE;
    // COMMENTED::Type ignored{};
    const char* text = "STRING_VALUE";
  `;

    expect([...scanCallees(source, {}, ["QX", "RL", "COMMENTED", "STRING"])].sort()).toEqual([
        "QX",
        "RL",
    ]);
});

test("scanCallees finds contracts initialized by a gtest", () => {
    const source = `
    INIT_CONTRACT(Counter);
    INIT_CONTRACT(Main);
  `;

    expect([...scanCallees(source, { contractName: "Main" }, ["Counter", "Main"])]).toEqual([
        "Counter",
    ]);
});

test("scanCallees excludes analyzed calls to the current contract", () => {
    const source = "INVOKE_OTHER_CONTRACT_PROCEDURE(QUTIL, Run, input, output, 0);";

    expect([...scanCallees(source, { contractName: "QUTIL" }, ["QUTIL"])]).toEqual([]);
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
        writeFileSync(
            callee,
            `struct CONTRACT_STATE_TYPE : public ContractBase {
      struct Get_input {}; struct Get_output {};
      PUBLIC_FUNCTION(Get) {}
      REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
    };`,
        );
        const prelude = buildCalleePrelude(root, "CALL_OTHER_CONTRACT_FUNCTION(QX, in, out);", {
            QX: { header: callee, index: 1 },
        });
        // the QUtil fix: a contract using `id(QX_CONTRACT_INDEX, …)` needs the callee index in the single-
        // contract TU (no contract_def.h) — guarded so the full build's #define still wins.
        expect(prelude).toContain("#ifndef QX_CONTRACT_INDEX");
        expect(prelude).toContain("#define QX_CONTRACT_INDEX 1");
        expect(prelude).toContain("QX_Get_inputType = 1");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("buildCalleePrelude includes static-only dynamic callees", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-static-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");
        const callee = join(root, "DYNAMIC.h");
        writeFileSync(
            callee,
            `struct CONTRACT_STATE_TYPE : public ContractBase {
      static uint64 helper() { return 1; }
      REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
    };`,
        );

        const prelude = buildCalleePrelude(root, "const auto value = DYNAMIC::helper();", {
            DYNAMIC: { header: callee, index: 28 },
        });

        expect(prelude).toContain("#define CONTRACT_STATE_TYPE DYNAMIC");
        expect(prelude).toContain(`#include "${callee}"`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("buildCalleePrelude does not reinclude the root through a callee", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-cycle-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");
        const rootHeader = join(root, "ROOT.h");
        const childHeader = join(root, "CHILD.h");
        writeFileSync(rootHeader, "// root header must not be included\n");
        writeFileSync(
            childHeader,
            `struct CONTRACT_STATE_TYPE : public ContractBase {
      static uint64 helper() { return ROOT_VALUE; }
      REGISTER_USER_FUNCTIONS_AND_PROCEDURES() {}
    };`,
        );

        const prelude = buildCalleePrelude(
            root,
            "const auto value = CHILD::helper();",
            {
                ROOT: { header: rootHeader, index: 2 },
                CHILD: { header: childHeader, index: 1 },
            },
            "ROOT",
        );

        expect(prelude).toContain(`#include "${childHeader}"`);
        expect(prelude).not.toContain(`#include "${rootHeader}"`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
