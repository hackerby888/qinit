// The compile recipe is the contract between qinit and the core headers: a wrong preamble order, a dropped
// impl include, or a target-specific include leak silently miscompiles. These lock the wrapper structure.
import { test, expect } from "bun:test";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm/headers";
import {
    buildPreamble,
    generateWasmContractTestingHeader,
    generateWasmWrapperSource,
    WASM_CONTRACT_CLANG_FLAGS,
    WASM_CONTRACT_TESTING_HEADER,
} from "../../src/recipe";

const opts = (over: Partial<Parameters<typeof generateWasmWrapperSource>[0]> = {}) => ({
    contractPath: "/abs/Counter.h",
    name: "Counter",
    slot: 7,
    corePath: "/core",
    outDir: "/out",
    ...over,
});

const STD_HEADERS = ["cstdint", "cstddef", "cstring", "cstdlib", "string", "type_traits", "utility", "array", "limits"];
const CORE_HEADERS = [
    "contract_core/pre_qpi_def.h",
    "qpi/qpi.h",
    "qpi/impl/qpi_proposals_impl.h",
    "oracle_core/oracle_interfaces_def.h",
    "oc_core/oc_interfaces_def.h",
];

test("Wasm contract Clang flags define one shared compile profile", () => {
    expect(WASM_CONTRACT_CLANG_FLAGS).toEqual(["--target=wasm32-wasi", "-std=c++20", "-fno-rtti", "-fno-exceptions", "-DLITEDYN_CONTRACT_TU"]);
});

test("buildPreamble: NO_UEFI, std headers, then build define, then core headers — in that order", () => {
    const p = buildPreamble();

    for (const h of STD_HEADERS) {
        expect(p).toContain(`#include <${h}>`);
    }
    for (const h of CORE_HEADERS) {
        expect(p).toContain(`#include "${h}"`);
    }

    const iNoUefi = p.indexOf("#define NO_UEFI");
    const iFirstStd = p.indexOf("#include <cstdint>");
    const iDefine = p.indexOf("#define LITE_WASM_TU_BUILD");
    const iFirstCore = p.indexOf('#include "contract_core/pre_qpi_def.h"');
    const iLastCore = p.indexOf('#include "oc_core/oc_interfaces_def.h"');

    expect(iNoUefi).toBeGreaterThanOrEqual(0);
    expect(iNoUefi).toBeLessThan(iFirstStd);
    expect(iFirstStd).toBeLessThan(iDefine);
    expect(iDefine).toBeLessThan(iFirstCore);
    expect(iFirstCore).toBeLessThan(iLastCore);
});

test("generateWasmWrapperSource: starts with the preamble, then per-contract defines bound to slot/name", () => {
    const w = generateWasmWrapperSource(opts());

    expect(w.startsWith(buildPreamble())).toBe(true);
    expect(w).toContain("#define CONTRACT_INDEX 7");
    expect(w).toContain("#define Counter_CONTRACT_INDEX 7");
    expect(w).toContain("#define CONTRACT_STATE_TYPE Counter");
    expect(w).toContain("#define CONTRACT_STATE2_TYPE Counter2");
});

test("generateWasmWrapperSource: includes in recipe order — calls, support, contract, impls, runtime", () => {
    const w = generateWasmWrapperSource(opts());

    const order = [
        CORE_WASM_HEADERS.sdk.intercontractCalls,
        CORE_WASM_HEADERS.sdk.qpiSupport,
        "/abs/Counter.h",
        "qpi/impl/qpi_collection_impl.h",
        "qpi/impl/qpi_linked_list_impl.h",
        "qpi/impl/qpi_hash_map_impl.h",
        CORE_WASM_HEADERS.sdk.moduleRuntime,
    ].map((s) => w.indexOf(s));

    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("generateWasmWrapperSource: the scratchpad rename brackets only the hash_map impl", () => {
    const w = generateWasmWrapperSource(opts());

    const iDef = w.indexOf("#define __acquireScratchpad __qinit_cb_acquireScratchpad_unused");
    const iHash = w.indexOf("qpi/impl/qpi_hash_map_impl.h");
    const iUndef = w.indexOf("#undef __acquireScratchpad");

    expect(iDef).toBeGreaterThanOrEqual(0);
    expect(iDef).toBeLessThan(iHash);
    expect(iHash).toBeLessThan(iUndef);
});

test("generateWasmWrapperSource: container diagnostics trap without importing libc printf", () => {
    const w = generateWasmWrapperSource(opts());
    const iDefine = w.indexOf("#define printf(...) (__builtin_trap(), 0)");
    const iCollection = w.indexOf("qpi/impl/qpi_collection_impl.h");
    const iHash = w.indexOf("qpi/impl/qpi_hash_map_impl.h");
    const iUndef = w.indexOf("#undef printf");

    expect(iDefine).toBeGreaterThanOrEqual(0);
    expect(iDefine).toBeLessThan(iCollection);
    expect(iCollection).toBeLessThan(iHash);
    expect(iHash).toBeLessThan(iUndef);
});

test("generateWasmWrapperSource: callee prelude is injected between preamble and the contract defines", () => {
    const prelude = "/*__CALLEE_PRELUDE__*/\n";
    const w = generateWasmWrapperSource(opts({ calleePrelude: prelude }));

    const iPreambleEnd = buildPreamble().length;
    const iPrelude = w.indexOf(prelude);
    const iDefines = w.indexOf("#define CONTRACT_INDEX 7");

    expect(iPrelude).toBe(iPreambleEnd);
    expect(iPrelude).toBeLessThan(iDefines);
});

test("generateWasmWrapperSource: omitting the callee prelude leaves no gap before the defines", () => {
    const w = generateWasmWrapperSource(opts());

    expect(w).toContain(`${buildPreamble()}\n#define CONTRACT_INDEX 7`);
});

test("generateWasmWrapperSource: includes only the Wasm support and runtime headers", () => {
    const o = opts();
    const wasm = generateWasmWrapperSource(o);

    expect(wasm).toContain("#define LITE_WASM_TU_BUILD");
    expect(wasm).not.toContain(CORE_WASM_HEADERS.shared.abiTypes);
    expect(wasm).toContain(`#include "${CORE_WASM_HEADERS.sdk.qpiSupport}"`);
    expect(wasm).toContain(`#include "${CORE_WASM_HEADERS.sdk.moduleRuntime}"`);

    // Core's target support precedes the contract so its template bodies precede instantiation.
    expect(wasm).not.toContain("qinit wasm QPI shim");
    expect(wasm.indexOf(`#include "${CORE_WASM_HEADERS.sdk.qpiSupport}"`)).toBeLessThan(wasm.indexOf(`#include "${o.contractPath}"`));
    expect(wasm.indexOf(`#include "${CORE_WASM_HEADERS.sdk.moduleRuntime}"`)).toBeGreaterThan(wasm.indexOf("qpi/impl/qpi_hash_map_impl.h"));
});

test("generateWasmWrapperSource: slot/name interpolation for a system contract", () => {
    const w = generateWasmWrapperSource({
        ...opts(),
        slot: 28,
        name: "QX",
        contractPath: "contracts/QX.h",
    });

    expect(w).toContain("#define CONTRACT_INDEX 28");
    expect(w).toContain("#define QX_CONTRACT_INDEX 28");
    expect(w).toContain("#define CONTRACT_STATE_TYPE QX");
    expect(w).toContain("#define CONTRACT_STATE2_TYPE QX2");
    expect(w).toContain('#include "contracts/QX.h"');
});

test("Wasm test support resolves its core include through the canonical layout", () => {
    expect(WASM_CONTRACT_TESTING_HEADER).toContain(`#include "${CORE_WASM_HEADERS.shared.abiMetadata}"`);
    expect(WASM_CONTRACT_TESTING_HEADER).not.toContain("__QINIT_CORE_WASM_ABI_METADATA__");
    expect(WASM_CONTRACT_TESTING_HEADER).toContain("USER_PROCEDURE_CALL = contractSystemProcedureCount + 1");
    expect(WASM_CONTRACT_TESTING_HEADER).toContain("USER_FUNCTION_CALL = contractSystemProcedureCount + 2");
    expect(WASM_CONTRACT_TESTING_HEADER).not.toMatch(/USER_(?:PROCEDURE|FUNCTION)_CALL\s*=\s*1[34]\b/);
    expect(WASM_CONTRACT_TESTING_HEADER).toContain("contractError[MAX_NUMBER_OF_CONTRACTS]");
    expect(WASM_CONTRACT_TESTING_HEADER).toContain("qb_state_bufs[MAX_NUMBER_OF_CONTRACTS]");
});

test("Wasm test support generates sparse contract descriptions through the tested slot", () => {
    const header = generateWasmContractTestingHeader([
        { index: 1, assetName: "QX", constructionEpoch: 66 },
        { index: 100, assetName: "Counter", constructionEpoch: 0 },
    ]);

    expect(header).toContain("contractDescriptions[MAX_NUMBER_OF_CONTRACTS]");
    expect(header).toContain('{"QX", 66, 10000, 0}');
    expect(header).toContain('{"Counter", 0, 10000, 0}');
    expect(header.match(/^    \{\},$/gm)).toHaveLength(99);
    expect(header).toContain("contractCount = 101;");
});
