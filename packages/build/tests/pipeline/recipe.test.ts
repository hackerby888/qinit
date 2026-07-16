// The compile recipe is the contract between qinit and the core headers: a wrong preamble order, a dropped
// impl include, or a target-specific include leak silently miscompiles. These lock the wrapper structure.
import { test, expect } from "bun:test";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import {
  buildPreamble,
  genWrapper,
  genWrapperWasm,
  WASM_CONTRACT_TESTING_HEADER,
} from "../../src/recipe";

const opts = (over: Partial<Parameters<typeof genWrapper>[0]> = {}) => ({
  contractPath: "/abs/Counter.h",
  name: "Counter",
  slot: 7,
  corePath: "/core",
  outDir: "/out",
  ...over,
});

const STD_HEADERS = [
  "cstdint",
  "cstddef",
  "cstring",
  "cstdlib",
  "string",
  "type_traits",
  "utility",
  "array",
  "limits",
];
const CORE_HEADERS = [
  "contract_core/pre_qpi_def.h",
  "contracts/qpi.h",
  "contract_core/qpi_proposal_voting.h",
  "oracle_core/oracle_interfaces_def.h",
];

test("buildPreamble: NO_UEFI, std headers, then build define, then core headers — in that order", () => {
  const p = buildPreamble("LITE_WASM_TU_BUILD");

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
  const iLastCore = p.indexOf('#include "oracle_core/oracle_interfaces_def.h"');

  expect(iNoUefi).toBeGreaterThanOrEqual(0);
  expect(iNoUefi).toBeLessThan(iFirstStd);
  expect(iFirstStd).toBeLessThan(iDefine);
  expect(iDefine).toBeLessThan(iFirstCore);
  expect(iFirstCore).toBeLessThan(iLastCore);
});

test("buildPreamble: native and Wasm differ only in the build define", () => {
  const native = buildPreamble("WASM_NATIVE_TU_BUILD");
  const wasm = buildPreamble("LITE_WASM_TU_BUILD");

  expect(native).toContain("#define WASM_NATIVE_TU_BUILD");
  expect(native).not.toContain("#define LITE_WASM_TU_BUILD");
  expect(native.replace("WASM_NATIVE_TU_BUILD", "LITE_WASM_TU_BUILD")).toBe(wasm);
});

test("genWrapper: starts with the native preamble, then per-contract defines bound to slot/name", () => {
  const w = genWrapper(opts());

  expect(w.startsWith(buildPreamble("WASM_NATIVE_TU_BUILD"))).toBe(true);
  expect(w).toContain("#define CONTRACT_INDEX 7");
  expect(w).toContain("#define Counter_CONTRACT_INDEX 7");
  expect(w).toContain("#define CONTRACT_STATE_TYPE Counter");
  expect(w).toContain("#define CONTRACT_STATE2_TYPE Counter2");
});

test("genWrapper: includes in recipe order — calls, contract, impls, abi binding", () => {
  const w = genWrapper(opts());

  const order = [
    CORE_WASM_HEADERS.sdk.intercontractCalls,
    "/abs/Counter.h",
    "contract_core/qpi_collection_impl.h",
    "contract_core/qpi_linked_list_impl.h",
    "contract_core/qpi_hash_map_impl.h",
    CORE_WASM_HEADERS.shared.abiTypes,
  ].map((s) => w.indexOf(s));

  expect(order.every((i) => i >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("genWrapper: the scratchpad rename brackets only the hash_map impl", () => {
  const w = genWrapper(opts());

  const iDef = w.indexOf("#define __acquireScratchpad __wasm_native_cb_acquireScratchpad_unused");
  const iHash = w.indexOf("contract_core/qpi_hash_map_impl.h");
  const iUndef = w.indexOf("#undef __acquireScratchpad");

  expect(iDef).toBeGreaterThanOrEqual(0);
  expect(iDef).toBeLessThan(iHash);
  expect(iHash).toBeLessThan(iUndef);
});

test("genWrapper: callee prelude is injected between preamble and the contract defines", () => {
  const prelude = "/*__CALLEE_PRELUDE__*/\n";
  const w = genWrapper(opts({ calleePrelude: prelude }));

  const iPreambleEnd = buildPreamble("WASM_NATIVE_TU_BUILD").length;
  const iPrelude = w.indexOf(prelude);
  const iDefines = w.indexOf("#define CONTRACT_INDEX 7");

  expect(iPrelude).toBe(iPreambleEnd);
  expect(iPrelude).toBeLessThan(iDefines);
});

test("genWrapper: omitting the callee prelude leaves no gap before the defines", () => {
  const w = genWrapper(opts());

  expect(w).toContain(`${buildPreamble("WASM_NATIVE_TU_BUILD")}\n#define CONTRACT_INDEX 7`);
});

test("native and Wasm wrappers emit their target-specific headers directly", () => {
  const o = opts();
  const native = genWrapper(o);
  const wasm = genWrapperWasm(o);

  expect(native).toContain("#define WASM_NATIVE_TU_BUILD");
  expect(native).toContain(`#include "${CORE_WASM_HEADERS.shared.abiTypes}"`);
  expect(native).not.toContain(CORE_WASM_HEADERS.sdk.qpiSupport);
  expect(native).not.toContain(CORE_WASM_HEADERS.sdk.moduleRuntime);

  expect(wasm).not.toContain("WASM_NATIVE_TU_BUILD");
  expect(wasm).toContain("#define LITE_WASM_TU_BUILD");
  expect(wasm).not.toContain(CORE_WASM_HEADERS.shared.abiTypes);
  expect(wasm).toContain(`#include "${CORE_WASM_HEADERS.sdk.qpiSupport}"`);
  expect(wasm).toContain(`#include "${CORE_WASM_HEADERS.sdk.moduleRuntime}"`);

  // Core's target support precedes the contract so its template bodies precede instantiation.
  expect(native).not.toContain("qinit wasm QPI shim");
  expect(wasm).not.toContain("qinit wasm QPI shim");
  expect(wasm.indexOf(`#include "${CORE_WASM_HEADERS.sdk.qpiSupport}"`)).toBeLessThan(
    wasm.indexOf(`#include "${o.contractPath}"`),
  );
  expect(wasm.indexOf(`#include "${CORE_WASM_HEADERS.sdk.moduleRuntime}"`)).toBeGreaterThan(
    wasm.indexOf("contract_core/qpi_hash_map_impl.h"),
  );
});

test("genWrapperWasm: slot/name interpolation for a system contract", () => {
  const w = genWrapperWasm(opts({ slot: 28, name: "QX", contractPath: "contracts/QX.h" }));

  expect(w).toContain("#define CONTRACT_INDEX 28");
  expect(w).toContain("#define QX_CONTRACT_INDEX 28");
  expect(w).toContain("#define CONTRACT_STATE_TYPE QX");
  expect(w).toContain("#define CONTRACT_STATE2_TYPE QX2");
  expect(w).toContain('#include "contracts/QX.h"');
});

test("Wasm test support resolves its core include through the canonical layout", () => {
  expect(WASM_CONTRACT_TESTING_HEADER).toContain(
    `#include "${CORE_WASM_HEADERS.shared.abiMetadata}"`,
  );
  expect(WASM_CONTRACT_TESTING_HEADER).not.toContain("__QINIT_CORE_WASM_ABI_METADATA__");
});
