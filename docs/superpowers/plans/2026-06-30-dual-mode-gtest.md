# Dual-backend gtest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the upstream QUTIL gtest bridge run its contracts-under-test through either backend — our TS compiler (`compileContract`) or native clang (`buildContract`) — selectable in production, run-both-and-diff in dev, to mechanically separate compiler bugs from bridge bugs.

**Architecture:** The clang-built runner wasm is mode-independent (built once). Only the *deployed* contract wasm in the Sim swaps. Extract the shared bridge into a non-test helper (`qutil-bridge.ts`); the production test and a new dev dual test are thin consumers. Mode is chosen by env var.

**Tech Stack:** TypeScript, Bun test, `@qinit/compile` (TS contract compiler), `@qinit/build` (clang→wasm), `@qinit/engine` (Sim), WebAssembly, wasi-sdk clang.

## Global Constraints

- No AI/Claude attribution in commit messages.
- Branch: `feat/ts-qpi-compiler` (Qinit repo). Do NOT touch core-lite; it stays read-only here.
- No process/conversation comments in code; comments stay neutral/technical.
- No one-line function bodies (body on its own line, not the brace line).
- Separate logical sections in a function with blank lines.
- Run tests from `packages/compile`: `bun test tests/<file>.test.ts`. wasi-sdk clang must be present (suite self-skips otherwise).
- `BuildResult.so` is the path to a **wasm** module (vestigial field name). Do NOT rename it.
- Preserve today's behavior exactly when `GTEST_MODE` is unset: `qutil-upstream.test.ts` reports 51/51.
- Contract indices: `QUTIL_IDX = 4`, `QX_IDX = 1`. Core path: `/home/kali/Projects/core-lite`.

---

## File Structure

- `packages/compile/tests/qutil-bridge.ts` — **NEW** non-test helper. Holds the `SHIM`, `wasiAvailable`, `runUpstream`, `TR`, constants (moved verbatim from the current test), plus new builders `buildRunner`, `buildContractsOurs`, `buildContractsNative`.
- `packages/compile/tests/qutil-upstream.test.ts` — **MODIFY** to a thin consumer: pick mode from `GTEST_MODE` (default `ours`), build runner + contracts(mode), assert `>= 51`.
- `packages/compile/tests/qutil-dual.test.ts` — **NEW** dev differential test, guarded by `GTEST_DUAL`. Runs both backends against one runner, classifies each test, asserts result vectors equal.

---

### Task 1: Extract the bridge helper; mode-parameterize the production test

Refactor only. The existing `qutil-upstream.test.ts` (currently 1 pass / 51 gtests) is the regression guard — it must stay green with `GTEST_MODE` unset.

**Files:**
- Create: `packages/compile/tests/qutil-bridge.ts`
- Modify: `packages/compile/tests/qutil-upstream.test.ts`

**Interfaces:**
- Produces (consumed by Task 2, Task 3):
  - `const QUTIL_IDX = 4`, `const QX_IDX = 1`, `const CORE: string`
  - `interface TR { name: string; passed: boolean; message: string }`
  - `function wasiAvailable(): boolean`
  - `function buildRunner(core: string): Promise<Uint8Array>` — clang runner wasm (phase 0)
  - `function buildContractsOurs(core: string): Promise<Record<number, Uint8Array>>` — `{4: QUTIL, 1: QX}` via `compileContract`
  - `function runUpstream(runnerWasm: Uint8Array, contracts: Record<number, Uint8Array>): Promise<TR[]>`

- [ ] **Step 1: Verify the regression guard is green before refactoring**

Run: `cd packages/compile && bun test tests/qutil-upstream.test.ts`
Expected: `1 pass`, `0 fail`. Console line: `contract_qutil.cpp vs my QUTIL+QX: 51 PASS · 0 FAIL · 0 HANG (of 51)`.

- [ ] **Step 2: Create `qutil-bridge.ts` with the moved + new code**

Create `packages/compile/tests/qutil-bridge.ts`. Move `SHIM` (the `String.raw` block, lines ~29-88 of the current test), `wasiAvailable` (~90-97), `TR` (~99), and `runUpstream` (~165-275) **verbatim** from `qutil-upstream.test.ts`. Add the constants and the two new builders. Full file:

```typescript
// Shared bridge for driving the upstream contract_qutil.cpp gtest corpus against deployable QUTIL+QX
// wasm. The runner (clang) is mode-independent; only the deployed contract wasm swaps between backends.
import { existsSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Sim, KIND, type Contract } from "@qinit/engine";
import { compileContract, loadQpiHeader, type CompileResult } from "../src/index";
import { buildContract } from "@qinit/build";

export const CORE = "/home/kali/Projects/core-lite";
export const QUTIL_IDX = 4;
export const QX_IDX = 1;

export interface TR {
  name: string;
  passed: boolean;
  message: string;
}

// <<< MOVE VERBATIM: the SHIM String.raw`...` constant from qutil-upstream.test.ts, exported >>>
export const SHIM = String.raw`...`;

export function wasiAvailable(): boolean {
  // <<< MOVE VERBATIM: body from qutil-upstream.test.ts wasiAvailable() >>>
}

function calleeIdlFrom(name: string, index: number, r: CompileResult) {
  const fns = Object.fromEntries(r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }]));
  const procs = Object.fromEntries(r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }]));
  return { name, index, functions: fns, procedures: procs };
}

// Phase 0: the clang runner wasm (test logic + a dead QUTIL copy for types). Built once, mode-independent.
export async function buildRunner(core: string): Promise<Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-upstream-"));
  const rawTest = readFileSync(`${core}/test/contract_qutil.cpp`, "utf8");
  const strippedTest = rawTest.replace(/^\s*#include\s+"contract_testing\.h".*$/m, "");
  const testSource = `${SHIM}\n${strippedTest}`;

  const built = await buildContract({
    contractPath: `${core}/src/contracts/QUtil.h`, name: "QUTIL", stateType: "QUTIL", slot: QUTIL_IDX,
    corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
    testSource, testPath: "contract_qutil.cpp",
  });
  if (!built.ok) {
    const lines = (built.stderr ?? "").split("\n").filter((l) => / error:| undefined | cannot |fatal|ld\.lld|wasm-ld/i.test(l));
    throw new Error("runner build failed:\n" + lines.slice(0, 30).join("\n"));
  }
  return new Uint8Array(readFileSync(built.so!));
}

// Phase 1 (ours): QUTIL+QX compiled by our TS compiler. QUTIL gets QX's IDL + source so its
// CALL_OTHER_CONTRACT(QX, ...) calls resolve.
export async function buildContractsOurs(core: string): Promise<Record<number, Uint8Array>> {
  const headers = loadQpiHeader(core);
  const qutilSrc = readFileSync(`${core}/src/contracts/QUtil.h`, "utf8");
  const qxSrc = readFileSync(`${core}/src/contracts/Qx.h`, "utf8");

  const mineQx = await compileContract({ source: qxSrc, name: "QX", slot: QX_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024 });
  const callees = [calleeIdlFrom("QX", QX_IDX, mineQx)];
  const calleeSources = [{ name: "QX", source: qxSrc }];
  const mineQutil = await compileContract({ source: qutilSrc, name: "QUTIL", slot: QUTIL_IDX, qpiHeader: headers, arenaSz: 8 * 1024 * 1024, callees, calleeSources });

  const qxErrs = mineQx.diagnostics.filter((d) => d.severity === "error");
  const qutilErrs = mineQutil.diagnostics.filter((d) => d.severity === "error");
  if (qxErrs.length || qutilErrs.length) {
    throw new Error("ours compile errors: QX=" + qxErrs.length + " QUTIL=" + qutilErrs.length);
  }
  return { [QUTIL_IDX]: mineQutil.wasm, [QX_IDX]: mineQx.wasm };
}

// <<< MOVE VERBATIM: the entire runUpstream(runnerWasm, contracts) function from
//     qutil-upstream.test.ts (~lines 165-275), prefixed with `export`. It already imports nothing
//     beyond Sim/KIND/Contract (now imported above). Remove the now-unused `SP` import if present. >>>
export async function runUpstream(runnerWasm: Uint8Array, contracts: Record<number, Uint8Array>): Promise<TR[]> {
  // ...moved body...
}
```

When moving `runUpstream`, ensure its imports resolve from this file's imports (`Sim`, `KIND`, `Contract`). The current test imports `SP` and `initK12` — those are NOT used by `runUpstream`; leave `initK12` in the test file, drop `SP` if unused by the moved body.

- [ ] **Step 3: Rewrite `qutil-upstream.test.ts` as a thin consumer**

Replace the whole file with:

```typescript
// Upstream Qubic gtest corpus (core-lite/test/contract_qutil.cpp, 51 TEST cases) driven against
// contracts-under-test deployed in a Sim. Backend selected by GTEST_MODE: "ours" (our TS compiler,
// default) or "native" (clang). The bridge mechanics live in ./qutil-bridge.
import { describe, test, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE, wasiAvailable, buildRunner, buildContractsOurs, buildContractsNative, runUpstream } from "./qutil-bridge";

describe("upstream gtest — contract_qutil.cpp against deployed QUTIL+QX wasm", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("contract_qutil.cpp drives the selected backend", async () => {
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }

    const mode = (process.env.GTEST_MODE ?? "ours") as "ours" | "native";
    const runner = await buildRunner(CORE);
    const contracts = mode === "native" ? await buildContractsNative(CORE) : await buildContractsOurs(CORE);
    const results = await runUpstream(runner, contracts);

    const passed = results.filter((r) => r.passed).length;
    const failed = results.length - passed;
    console.log(`\n  [${mode}] contract_qutil.cpp: ${passed} PASS · ${failed} FAIL (of ${results.length})`);
    for (const r of results.filter((r) => !r.passed).slice(0, 12)) {
      console.log(`  FAIL  ${r.name || ""} — ${r.message.replace(/\n/g, " ").slice(0, 110)}`);
    }
    expect(passed).toBeGreaterThanOrEqual(51);
  }, 300000);
});
```

Note: `buildContractsNative` is imported here but only added in Task 2. Until then the `native` branch is unreachable (default `ours`), but the import must exist or TS errors. To keep Task 1 independently green, add a temporary stub export in `qutil-bridge.ts` now:

```typescript
// Phase 1 (native): added in Task 2. Stub keeps the production test's import resolvable.
export async function buildContractsNative(_core: string): Promise<Record<number, Uint8Array>> {
  throw new Error("native backend not implemented yet (Task 2)");
}
```

- [ ] **Step 4: Run the production test — verify ours is still 51/51**

Run: `cd packages/compile && bun test tests/qutil-upstream.test.ts`
Expected: `1 pass`, `0 fail`. Console: `[ours] contract_qutil.cpp: 51 PASS · 0 FAIL (of 51)`.

- [ ] **Step 5: Commit**

```bash
git add packages/compile/tests/qutil-bridge.ts packages/compile/tests/qutil-upstream.test.ts
git commit -m "refactor(compile): extract qutil-bridge; GTEST_MODE-select backend (ours default)"
```

---

### Task 2: Native clang backend

Implement `buildContractsNative` — QUTIL+QX built by clang as plain deployable wasm (no test source), deployed in the Sim exactly like the ours wasm.

**Files:**
- Modify: `packages/compile/tests/qutil-bridge.ts:buildContractsNative` (replace the Task 1 stub)

**Interfaces:**
- Consumes: `buildContract` from `@qinit/build` (auto-derives the QX callee prelude from `corePath` + the `CALL_OTHER_CONTRACT` scan in QUtil.h — no manual prelude needed).
- Produces: `buildContractsNative(core): Promise<Record<number, Uint8Array>>` returning `{4: QUTIL.wasm, 1: QX.wasm}` — same shape as `buildContractsOurs`.

- [ ] **Step 1: Replace the stub with the real native builder**

In `packages/compile/tests/qutil-bridge.ts`, replace the `buildContractsNative` stub from Task 1 with:

```typescript
// Phase 1 (native): QUTIL+QX built by clang (LITE_WASM_TU_BUILD) as plain deployable contract wasm —
// no testSource, so recipe.ts emits a contract module the Sim deploys identically to the ours wasm.
// buildContract auto-derives QX's callee prelude from corePath + QUtil.h's CALL_OTHER_CONTRACT scan.
export async function buildContractsNative(core: string): Promise<Record<number, Uint8Array>> {
  const dir = mkdtempSync(join(tmpdir(), "qutil-native-"));

  const qx = await buildContract({
    contractPath: `${core}/src/contracts/Qx.h`, name: "QX", stateType: "QX", slot: QX_IDX,
    corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
  });
  if (!qx.ok) {
    throw new Error("native QX build failed:\n" + (qx.stderr ?? "").split("\n").slice(-15).join("\n"));
  }

  const qutil = await buildContract({
    contractPath: `${core}/src/contracts/QUtil.h`, name: "QUTIL", stateType: "QUTIL", slot: QUTIL_IDX,
    corePath: core, outDir: dir, arenaSz: 8 * 1024 * 1024, skipVerify: true,
  });
  if (!qutil.ok) {
    throw new Error("native QUTIL build failed:\n" + (qutil.stderr ?? "").split("\n").slice(-15).join("\n"));
  }

  return { [QUTIL_IDX]: new Uint8Array(readFileSync(qutil.so!)), [QX_IDX]: new Uint8Array(readFileSync(qx.so!)) };
}
```

- [ ] **Step 2: Run the production test in native mode — observe the result**

Run: `cd packages/compile && GTEST_MODE=native bun test tests/qutil-upstream.test.ts`
Expected: console `[native] contract_qutil.cpp: 51 PASS · 0 FAIL (of 51)`, test passes. native-clang QUTIL is the reference impl, so it should pass every upstream case. If it reports `< 51`, that is a **bridge bug** surfaced by the new mode (the SHIM/`thost`/Sim is not a faithful oracle) — record which cases fail; that becomes a follow-up fix in the bridge, not this task's blocker. If it OOMs on the 384 MB QUTIL state, note it (the ours path already instantiates that size, so this is unexpected) and reduce scope to documenting the limit.

- [ ] **Step 3: Re-run ours mode — verify no regression**

Run: `cd packages/compile && bun test tests/qutil-upstream.test.ts`
Expected: `[ours] contract_qutil.cpp: 51 PASS · 0 FAIL (of 51)`, `1 pass`.

- [ ] **Step 4: Commit**

```bash
git add packages/compile/tests/qutil-bridge.ts
git commit -m "feat(compile): native clang backend for qutil gtest (GTEST_MODE=native)"
```

---

### Task 3: Dev differential test

Add a guarded dev test that runs both backends against one runner and diffs per-test, classifying each mismatch as a compiler bug or bridge bug.

**Files:**
- Create: `packages/compile/tests/qutil-dual.test.ts`

**Interfaces:**
- Consumes: `wasiAvailable`, `buildRunner`, `buildContractsOurs`, `buildContractsNative`, `runUpstream`, `TR`, `CORE` from `./qutil-bridge`.

- [ ] **Step 1: Create the guarded dual test**

Create `packages/compile/tests/qutil-dual.test.ts`:

```typescript
// Dev-only differential: run contract_qutil.cpp against BOTH backends (ours = @qinit/compile,
// native = clang) through the same runner, and classify each test. native is the reference.
// Gated by GTEST_DUAL because it pays for two contract builds. Run:  GTEST_DUAL=1 bun test tests/qutil-dual.test.ts
import { describe, test, expect, beforeAll } from "bun:test";
import { initK12 } from "@qinit/core";
import { CORE, wasiAvailable, buildRunner, buildContractsOurs, buildContractsNative, runUpstream, type TR } from "./qutil-bridge";

function classify(ours: TR | undefined, native: TR | undefined): string {
  const o = ours?.passed ?? false;
  const n = native?.passed ?? false;
  if (o && n) {
    return "ok";
  }
  if (!n) {
    return "BRIDGE";
  }
  return "COMPILER";
}

describe("dual-backend differential — ours vs native", () => {
  beforeAll(async () => {
    await initK12();
  });

  test("ours matches native per-test", async () => {
    if (!process.env.GTEST_DUAL) {
      console.log("  (set GTEST_DUAL=1 to run the dual differential)");
      return;
    }
    if (!wasiAvailable()) {
      console.log("  (wasi-sdk clang not found — skipping)");
      return;
    }

    const runner = await buildRunner(CORE);
    const rNative = await runUpstream(runner, await buildContractsNative(CORE));
    const rOurs = await runUpstream(runner, await buildContractsOurs(CORE));

    const byName = (rs: TR[]) => new Map(rs.map((r, i) => [r.name || String(i), r]));
    const on = byName(rOurs);
    const nn = byName(rNative);
    const names = [...new Set([...on.keys(), ...nn.keys()])];

    const buckets: Record<string, string[]> = { ok: [], COMPILER: [], BRIDGE: [] };
    for (const name of names) {
      buckets[classify(on.get(name), nn.get(name))].push(name);
    }

    console.log(`\n  dual: ${buckets.ok.length} ok · ${buckets.COMPILER.length} COMPILER-BUG · ${buckets.BRIDGE.length} BRIDGE-BUG (of ${names.length})`);
    for (const name of buckets.COMPILER) {
      console.log(`  COMPILER  ${name} — ours fails, native passes (fix codegen)`);
    }
    for (const name of buckets.BRIDGE) {
      console.log(`  BRIDGE    ${name} — native fails (fix SHIM/thost/Sim)`);
    }

    const oursVec = names.map((n) => `${n}:${on.get(n)?.passed ? 1 : 0}`);
    const nativeVec = names.map((n) => `${n}:${nn.get(n)?.passed ? 1 : 0}`);
    expect(oursVec).toEqual(nativeVec);
  }, 600000);
});
```

- [ ] **Step 2: Run the dual test**

Run: `cd packages/compile && GTEST_DUAL=1 bun test tests/qutil-dual.test.ts`
Expected: console `dual: 51 ok · 0 COMPILER-BUG · 0 BRIDGE-BUG (of 51)`, `1 pass`. (If any line prints COMPILER or BRIDGE, the deep-equal fails and the table tells you which side to fix.)

- [ ] **Step 3: Verify the gate — unset env skips cleanly**

Run: `cd packages/compile && bun test tests/qutil-dual.test.ts`
Expected: `1 pass`, console `(set GTEST_DUAL=1 to run the dual differential)` — no builds run.

- [ ] **Step 4: Commit**

```bash
git add packages/compile/tests/qutil-dual.test.ts
git commit -m "test(compile): dual-backend differential (GTEST_DUAL) — classify compiler vs bridge bugs"
```

---

## Self-Review

**Spec coverage:**
- Production one-mode-selectable (default ours) → Task 1 (`GTEST_MODE` default ours) + Task 2 (native branch). ✓
- Dev run-both-and-diff → Task 3. ✓
- Runner built once, mode-independent → `buildRunner` in Task 1, reused in all modes. ✓
- Swap only deployed contracts → `buildContracts{Ours,Native}` return the same map shape; `runUpstream` unchanged. ✓
- Failure classification table → Task 3 `classify` + buckets. ✓
- Helper extraction (qutil-bridge.ts) → Task 1. ✓
- QUTIL 384 MB risk → Task 2 Step 2 note (already instantiated by today's runner, so proven-feasible). ✓
- Native-fails-and-don't-block-ours → Task 2 Step 2 records bridge bugs as follow-up, ours path untouched. ✓
- Out-of-scope (rename `so`, generalize to 27 contracts, pure-native, CI wiring) → not in any task. ✓

**Placeholder scan:** The `<<< MOVE VERBATIM >>>` markers in Task 1 are move instructions, not placeholders — the source lines are cited by file+approx line and the moved code already exists in `qutil-upstream.test.ts`. All NEW code is shown in full. No TBD/TODO.

**Type consistency:** `buildContractsOurs` / `buildContractsNative` both return `Promise<Record<number, Uint8Array>>`. `runUpstream(runnerWasm, contracts)` signature is identical across all call sites. `TR` shape `{name, passed, message}` consistent. `buildRunner(core)` returns `Uint8Array` consumed by `runUpstream`. Env vars: `GTEST_MODE` (Task 1/2), `GTEST_DUAL` (Task 3). ✓
