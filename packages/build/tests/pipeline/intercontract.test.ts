import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCalleePrelude, contractIndexDefines, parseContractDef, scanCallees } from "../../src/contracts/intercontract";

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
    const s = "CALL_OTHER_CONTRACT_FUNCTION(QX, a, b); INVOKE_OTHER_CONTRACT_PROCEDURE(Foo, c, d, 0);";
    expect([...scanCallees(s)].sort()).toEqual(["Foo", "QX"]);
});

test("scanCallees finds qualified types and constants but ignores comments", () => {
    const source = `
    QX::Transfer_input input{};
    const auto fee = RL_MAX_FEE;
    // COMMENTED::Type ignored{};
    const char* text = "STRING_VALUE";
  `;

    expect([...scanCallees(source, {}, ["QX", "RL", "COMMENTED", "STRING"])].sort()).toEqual(["QX", "RL"]);
});

test("scanCallees finds contracts initialized by a gtest", () => {
    const source = `
    INIT_CONTRACT(Counter);
    INIT_CONTRACT(Main);
  `;

    expect([...scanCallees(source, { contractName: "Main" }, ["Counter", "Main"])]).toEqual(["Counter"]);
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
            QX: { header: callee, slot: 1 },
        });
        // The QUtil fix: `id(QX_CONTRACT_INDEX, …)` needs the callee index in the single-contract TU, guarded so the full build's #define still wins.
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
            DYNAMIC: { header: callee, slot: 28 },
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
                ROOT: { header: rootHeader, slot: 2 },
                CHILD: { header: childHeader, slot: 1 },
            },
            "ROOT",
        );

        expect(prelude).toContain(`#include "${childHeader}"`);
        expect(prelude).not.toContain(`#include "${rootHeader}"`);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("buildCalleePrelude includes unreferenced dynamic callees only when the editor asks for them", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-unreferenced-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");
        const callee = join(root, "Calle.h");
        writeFileSync(
            callee,
            `struct CONTRACT_STATE_TYPE : public ContractBase {
      struct Get_input {}; struct Get_output {};
      PUBLIC_FUNCTION(Get) {}
      REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
    };`,
        );
        const dynamicCallees = { Calle: { header: callee, slot: 1 } };
        const source = "state.mut().counter += 1;";

        expect(buildCalleePrelude(root, source, dynamicCallees, "Counter")).not.toContain("Calle_Get_inputType");

        const editorPrelude = buildCalleePrelude(root, source, dynamicCallees, "Counter", true);
        expect(editorPrelude).toContain(`#include "${callee}"`);
        expect(editorPrelude).toContain("Calle_Get_inputType = 1");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("an unreferenced callee that fails to analyze drops instead of failing the contract being edited", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-broken-sibling-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");
        const broken = join(root, "Broken.h");
        writeFileSync(broken, "struct CONTRACT_STATE_TYPE : public ContractBase { PUBLIC_FUNCTION(Get) {");

        const prelude = buildCalleePrelude(root, "state.mut().counter += 1;", { Broken: { header: broken, slot: 1 } }, "Counter", true);

        expect(prelude).not.toContain("Broken.h");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the prelude leaves the inter-contract SDK include to the wasm wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-sdk-include-"));
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
        const prelude = buildCalleePrelude(root, "CALL_OTHER_CONTRACT_FUNCTION(QX, Get, in, out);", { QX: { header: callee, slot: 1 } });

        expect(prelude).not.toContain("intercontract_calls.h");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// E5: the prelude analysed each callee alone, so a middle contract naming a third contract's type was
// unanalysable and dropped, taking the caller's build down with it. Its own callees have to resolve first.
test("a callee that references a third contract's type still reaches the prelude", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-diamond-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");

        const ledger = join(root, "Ledger.h");
        writeFileSync(
            ledger,
            `struct Ledger : public ContractBase
{
    struct Stamp { uint64 at; };
    struct StateData { uint64 seq; Stamp last; };
    struct Note_input { uint64 n; };
    struct Note_output { uint64 seq; };
    PUBLIC_FUNCTION(Note) { output.seq = state.get().seq; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Note, 1); }
};
`,
        );

        // Bank names Ledger::Stamp, which only resolves when Ledger is in scope for Bank's own analysis.
        const bank = join(root, "Bank.h");
        writeFileSync(
            bank,
            `struct Bank : public ContractBase
{
    struct StateData { uint64 marker; Ledger::Stamp lastStamp; };
    struct Quote_input { uint64 n; };
    struct Quote_output { uint64 marker; };
    struct Quote_locals { Ledger::Note_input note; Ledger::Note_output back; };
    PUBLIC_FUNCTION_WITH_LOCALS(Quote)
    {
        CALL_OTHER_CONTRACT_FUNCTION(Ledger, Note, locals.note, locals.back);
        output.marker = state.get().marker;
    }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Quote, 1); }
};
`,
        );

        const dynamicCallees = { Ledger: { header: ledger, slot: 29 }, Bank: { header: bank, slot: 30 } };
        const dropped: string[] = [];
        const prelude = buildCalleePrelude(root, "CALL_OTHER_CONTRACT_FUNCTION(Bank, Quote, locals.q, locals.back);", dynamicCallees, "Teller", false, (type) =>
            dropped.push(type),
        );

        expect(dropped).toEqual([]);
        expect(prelude).toContain("Bank.h");
        expect(prelude).toContain("Ledger.h");
        // Bank's registrations resolved, so the caller gets the constant it needs to make the call.
        expect(prelude).toContain("Bank_Quote_inputType");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The reorder rests on this: scanning for callees reads the macro call list, which `analyzeContract`
// produces before the compile that can fail, so an unanalysable contract still yields its callee graph.
test("scanCallees returns the callee names even when the source does not analyze", () => {
    const unanalysable = `struct Bank : public ContractBase
{
    struct StateData { Ledger::Stamp lastStamp; };
    struct Quote_locals { Ledger::Note_input note; Ledger::Note_output back; };
    PUBLIC_FUNCTION_WITH_LOCALS(Quote) { CALL_OTHER_CONTRACT_FUNCTION(Ledger, Note, locals.note, locals.back); }
};
`;

    expect([...scanCallees(unanalysable, { contractName: "Bank" }, ["Ledger"])]).toEqual(["Ledger"]);
});

// A cycle terminates rather than throwing: the editor calls buildCalleePrelude unwrapped, and
// robustness.test.ts holds it to not throwing on odd input.
test("a callee cycle stops recursing instead of throwing", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-cycle-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");

        const first = join(root, "First.h");
        const second = join(root, "Second.h");
        writeFileSync(first, "struct First : public ContractBase { PUBLIC_FUNCTION(Go) { CALL_OTHER_CONTRACT_FUNCTION(Second, Go, in, out); } };\n");
        writeFileSync(second, "struct Second : public ContractBase { PUBLIC_FUNCTION(Go) { CALL_OTHER_CONTRACT_FUNCTION(First, Go, in, out); } };\n");

        const dynamicCallees = { First: { header: first, slot: 29 }, Second: { header: second, slot: 30 } };

        expect(() => buildCalleePrelude(root, "CALL_OTHER_CONTRACT_FUNCTION(First, Go, in, out);", dynamicCallees, "Caller", true, () => {})).not.toThrow();
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

// The drop itself was never the whole problem; dropping silently was. A sibling that genuinely cannot be
// analysed must reach the caller as a reason, since every symbol it would have declared is now missing.
test("a dropped sibling is reported with the reason it could not be analysed", () => {
    const root = mkdtempSync(join(tmpdir(), "ic-drop-reason-"));
    try {
        mkdirSync(join(root, "src", "contract_core"), { recursive: true });
        writeFileSync(join(root, "src", "contract_core", "contract_def.h"), "// empty registry\n");

        // Well-formed, but names a contract this project does not have, so its registrations never parse.
        const orphan = join(root, "Orphan.h");
        writeFileSync(
            orphan,
            `struct Orphan : public ContractBase
{
    struct StateData { uint64 count; Missing::Thing thing; };
    struct Get_input {}; struct Get_output { uint64 value; };
    PUBLIC_FUNCTION(Get) { output.value = state.get().count; }
    REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(Get, 1); }
};
`,
        );

        const dropped: { type: string; reason: string }[] = [];
        const prelude = buildCalleePrelude(root, "state.mut().counter += 1;", { Orphan: { header: orphan, slot: 29 } }, "Counter", true, (type, reason) =>
            dropped.push({ type, reason }),
        );

        expect(prelude).not.toContain("Orphan.h");
        expect(dropped.map((entry) => entry.type)).toEqual(["Orphan"]);
        expect(dropped[0].reason).toContain("Missing::Thing");
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
