# Dual-backend gtest — native clang vs @qinit/compile

## Problem

The upstream gtest bridge (`packages/compile/tests/qutil-upstream.test.ts`) drives the real
Qubic test corpus (`core-lite/test/contract_qutil.cpp`, 51 cases) against contracts compiled by
**our** TS compiler. When a test fails, the cause is ambiguous: a bug in our codegen, or a bug in
the bridge itself (SHIM / `thost` handlers / Sim fidelity). This session repeatedly burned time
resolving that ambiguity by hand-writing one-off Sim probes (e.g. `probe-v5e.ts`) to establish
ground truth.

A native-clang baseline removes the guesswork. Native-clang QUTIL/QX are the reference
implementation. Run the *same* runner + SHIM + Sim against them, and the result classifies the
failure mechanically.

## Goal

- **Production:** one backend at a time, selectable. Default = `ours` (preserves today's 51/51).
- **Dev:** run both backends against the same harness and diff per-test, to disambiguate
  compiler bugs from bridge bugs.

Non-goal: running the upstream test as a pure native binary (real `contract_testing.h`, no
engine). That validates "is QUTIL.h correct C++", not "does our compiler match native" — different
question, heavier harness, out of scope.

## Key insight — why this is cheap

The runner wasm (clang-built from `contract_qutil.cpp` + SHIM) embeds the test logic and a *dead*
QUTIL copy used only for types. It is **mode-independent — built once**. The runner never calls a
contract by function pointer; every operation crosses the `thost` boundary into the Sim, which
dispatches into separately-**deployed** contract wasm.

So dual-mode = swap *which wasm is deployed in the Sim*. Nothing else changes.

```
                       runner (clang, built once)
                              | thost -> Sim -> dispatch
                              v
  mode='ours'    deploy { 4: compileContract(QUTIL).wasm, 1: compileContract(QX).wasm }
  mode='native'  deploy { 4: buildContract(QUTIL).so,      1: buildContract(QX).so      }
                                        ^ clang, no testSource = plain deployable contract wasm
```

Note: `BuildResult.so` is a vestigial field name; it carries the path to a real **wasm** module
(`LITE_WASM_TU_BUILD`, `\0asm` magic, run by WAMR). Not a native `.so`. Left as-is to avoid
churning ~6 call sites; out of scope to rename.

## Architecture

Extract the shared bridge into a non-test helper so the production test and the dev dual test are
thin consumers (no duplication; sets up later generalization to other upstream contracts).

```
packages/compile/tests/
  qutil-bridge.ts          # NEW helper (not *.test.ts -> does not auto-run)
    - SHIM (ContractTesting -> thost), moved verbatim
    - buildRunner(core)            -> runner wasm (clang, once)
    - buildContractsOurs(core)     -> { 4: QUTIL.wasm, 1: QX.wasm } via compileContract
    - buildContractsNative(core)   -> { 4: QUTIL.wasm, 1: QX.wasm } via buildContract (no testSource)
    - runUpstream(runnerWasm, contracts) -> TR[]   (moved verbatim, unchanged)
    - wasiAvailable()
  qutil-upstream.test.ts   # PRODUCTION: thin. mode = env GTEST_MODE ?? "ours". expect >= 51.
  qutil-dual.test.ts       # DEV: guarded by env GTEST_DUAL. runs both, diffs, asserts equal.
```

### Components

1. **`buildContractWasm(core, name, slot, src)`** — `buildContract({ contractPath, name,
   stateType, slot, corePath, outDir })` with **no** `testSource` (recipe.ts:161 path) -> plain
   deployable wasm. Returns bytes read from `built.so`.

2. **`runUpstream(runnerWasm, contracts)`** — unchanged. Already parameterized by the contracts
   map. Mode only changes what fills it.

3. **`buildContracts(mode, core)`** — returns the deploy map: `ours` = `compileContract` pair
   (QX first, then QUTIL with QX as callee IDL + calleeSource), `native` = `buildContractWasm`
   pair.

4. **Production test** (`qutil-upstream.test.ts`) — `mode = process.env.GTEST_MODE ?? "ours"`;
   build runner + contracts(mode); `expect(passed).toBeGreaterThanOrEqual(51)`. Default `ours`
   = byte-for-byte today's behavior.

5. **Dev differential** (`qutil-dual.test.ts`) — guarded `if (!process.env.GTEST_DUAL) return`.
   Build runner once; run it against both contract maps; zip results per-test; classify; print
   table; `expect(oursResults).toEqual(nativeResults)` (pass/fail vector).

## Execution flow

- **Phase 0 (once):** strip `contract_testing.h` include, prepend SHIM, `buildContract` with
  testSource -> runner wasm.
- **Phase 1 (per mode):** build contracts-under-test (ours = TS, native = clang-no-test) ->
  contracts map.
- **Phase 2 (per mode):** `deployAll()` new Sim + deploy map; instantiate runner with
  `{ thost, env }` bound to that Sim; `_initialize()`; loop `run_test(i)` over `test_count()`;
  collect `t_report` rows.
- **Phase 3 (assert):**
  - env unset -> ours, `>= 51`.
  - `GTEST_MODE=native` -> native, `>= 51` (sanity: bridge is faithful).
  - `GTEST_DUAL=1` -> both + diff table + `toEqual`.

## Failure classification (the payoff)

| ours \\ native | native pass     | native fail            |
|----------------|-----------------|------------------------|
| **ours pass**  | green           | bridge favors ours (suspect) |
| **ours fail**  | COMPILER BUG    | BRIDGE / SHIM BUG      |

native = reference. native-fail => fix the harness (SHIM/thost/Sim), not codegen.
native-pass + ours-fail => fix codegen.

## Error handling / risks

- **QUTIL 384 MB state** (`Array<Voter, 8.4M>`): clang builds it (the runner already embeds it),
  so a no-test build is strictly simpler. Deploying standalone into the Sim = ~6000 linear-memory
  pages. Heavy but within what the engine handles. **Verify on first native run**; if it OOMs,
  that is a finding to record, not a blocker for the ours path.
- **Native build fails / wasi-sdk absent:** dual block logs the reason and skips; never fails the
  production (ours) path. `wasiAvailable()` already gates the whole suite.
- **Result-vector mismatch in dual:** the `toEqual` diff + printed classification table is the
  intended output, not a harness error.

## Scope

**In:** one helper module (extracted, mostly moved verbatim), `buildContractWasm`,
`buildContracts(mode)`, env-driven mode in the production test, a guarded dual test. Net new
logic is small (~40-60 lines); the bulk is a move.

**Out:** generalizing the harness to the other 27 upstream `contract_*.cpp` (separate task);
wiring dual into CI (dev-only env flag for now); renaming `BuildResult.so` -> `wasm`; pure-native
(non-engine) gtest.

## Verification

1. `GTEST_MODE` unset -> `qutil-upstream.test.ts` still reports 51/51 (no regression).
2. `GTEST_MODE=native` -> runner drives clang-built QUTIL/QX; expect 51/51 (proves the bridge is
   a faithful oracle). Any sub-51 here is a bridge bug surfaced by the new mode.
3. `GTEST_DUAL=1` -> prints the per-test classification table; `oursResults` deep-equals
   `nativeResults`.
4. Full `bun test` (the existing differential + sweep suites) stays green.
