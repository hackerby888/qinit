# qinit gtest harness — run any contract_*.cpp out of the box (Stage A)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Make the qinit gtest system run the real upstream `core-lite/test/contract_*.cpp` corpora unmodified, by shipping a complete wasm-mode `contract_testing.h` harness + a generic engine binding — so any system contract (current or future) is testable with no per-contract harness code. Stage A stands up the foundation and validates it on QUTIL (51/51) + the EASY tier, dual-backend (our compiler vs native clang).

**Architecture:** Three things built once: (1) a qinit-shipped `wasm_contract_testing.h` mirroring the native `contract_testing.h` API but routing every op to `thost` imports; (2) a generic `runContractTesting(runner, contracts)` in `@qinit/engine` binding those imports against a Sim with N deployed contracts (incl. the `getState()` state-sync); (3) a build path that redirects a corpus's `#include "contract_testing.h"` to the qinit header so the corpus compiles verbatim. A thin driver names each corpus's contract+callees and runs both backends. The CLI wrapper (`qinit gtest`) comes in a later stage; Stage A delivers the harness + a sweep.

**Tech Stack:** TypeScript, Bun test, `@qinit/build` (clang→wasm + recipe), `@qinit/engine` (Sim/Contract/gtest), `@qinit/compile` (TS contract→wasm), WebAssembly, wasi-sdk clang.

## Global Constraints

- No AI/Claude attribution in commits. No process/conversation comments in code. No one-line function bodies. Blank lines between logical sections.
- Branch `feat/ts-qpi-compiler`. **core-lite is read-only** (we ship our own header; we never edit core's). `BuildResult.so` not renamed.
- The existing QUTIL test-dir bridge (`qutil-bridge.ts`, `qutil-upstream.test.ts`, `qutil-dual.test.ts`) must keep passing — leave it untouched as a regression anchor while the qinit-level path is built alongside. It may be retired in a later stage once the qinit path subsumes it.
- The native `core-lite/test/contract_testing.h` (234 lines) is the API SPEC: the qinit header must expose the same public surface the corpora use (class `ContractTesting` + free helpers + globals `contractStates`, `system`/`qubicSystemStruct`, `contractDescriptions`, `spectrumIndex`/`energy`/`getBalance`/`increaseEnergy`/`decreaseEnergy`/`numberOfShares`/`numberOfPossessedShares`, `checkContractExecCleanup`, macro `INIT_CONTRACT`) so corpora compile verbatim. Stage A implements the EASY-surface subset; asset/share/tick/time/oracle ops are Stage B/C (declared but may be unimplemented stubs that simply fail to link a HARD corpus — that is reported, not mis-run).
- Engine primitives (confirmed present): `Contract.state(): Uint8Array`, `Contract.writeState(bytes)`, `Contract.stateSize`, `sim.deploy(slot, wasm): Contract`, `sim.epochN`/`sim.tickN` (public mutable), the Sim ledger (`fund`/`balance`/`debit`) and `sim.assets`. `engine/gtest.ts` already has `runTests`/`runTestsAgainst`/`driveTests` + a `t_report`-style result collector to reuse.
- Build path fact: `recipe.ts genWrapperWasm` emits `contract → #include "extensions/lite_test.h" (gtest macros + runner exports test_count/run_test + t_report) → #line → testSource`. The corpus's `#include "contract_testing.h"` sits inside the corpus body; redirect THAT to the qinit header.
- CONTRACT_INDEX (contract_def.h): QX=1, QUOTTERY=2, RANDOM=3, QUTIL=4, GQMPROP=6, CCF=8, QEARN=9, QRP=21, VOTTUNBRIDGE=25.
- EASY tier (Stage A validation set): qutil(@4,callee QX@1) · qrp(QReservePool.h, QRP@21, no callee) · vottunbridge(VottunBridge.h, VOTTUNBRIDGE@25) · qearn(Qearn.h, QEARN@9) · gqmprop(GeneralQuorumProposal.h, GQMPROP@6) · ccf(ComputorControlledFund.h, CCF@8). All EASY = single contract (qutil has the QX callee) using ContractTesting + getState + epoch only.

## File Structure

- `packages/build/src/assets/wasm_contract_testing.h` — **NEW** the shipped harness header (the ContractTesting API + globals + free helpers → thost imports). The EASY surface in Stage A.
- `packages/build/src/recipe.ts` / `index.ts` — **MODIFY** add a corpus-build entry that (a) makes the asset header resolvable in the compile temp dir and (b) redirects the corpus's `contract_testing.h` include.
- `packages/engine/src/gtest.ts` — **MODIFY** add `runContractTesting(runnerWasm, contracts)` (generic multi-contract thost binding + state-sync). Export from `engine/src/index.ts`.
- `packages/build/tests/sc-corpus.test.ts` — **NEW** driver + registry + dual-backend sweep validating QUTIL + EASY tier.

---

### Task 1: Generic engine binding — `runContractTesting`

Migrate the validated QUTIL `runUpstream` thost logic into `@qinit/engine` as a first-class, contract-agnostic binding, and add the `getState()` state-sync. This is independently testable against the EXISTING QUTIL runner wasm (the one `qutil-bridge.ts` builds), so it can be verified before the header/build pieces exist.

**Files:**
- Modify: `packages/engine/src/gtest.ts` (add `runContractTesting`)
- Modify: `packages/engine/src/index.ts` (export it)
- Test: `packages/engine/tests/contract-testing.test.ts` (NEW)

**Interfaces (Produces):**
```typescript
export interface TestResult { name: string; passed: boolean; message: string } // already exists in gtest.ts
export async function runContractTesting(
  runnerWasm: Uint8Array,
  contracts: Record<number, Uint8Array>,
): Promise<TestResult[]>;
```

**Design — port from `packages/compile/tests/qutil-bridge.ts:runUpstream`, generalized + state-sync added:**
- Build a fresh `Sim({ mempool: false, fees: "off", liteTicking: true })`; `deployAll()` deploys every `[idx, wasm]` in `contracts` and clears per-run state (handles, spectrum tables, and the new `materialized` map).
- Bind the `thost` import object with the index-aware handlers already proven in `runUpstream`: `q_reset` (re-deploy all), `q_init`, `q_invoke` (debit invocator reward then `sim.procedure`), `q_query`, `q_sysproc`, `q_fund`, `q_balance`, `q_shares`, `q_possessed`, `q_spectrum`, `q_decrease`, and `t_report` (push `{name,passed,message}`). Copy these bodies verbatim from `runUpstream` (they are correct and tested).
- **Add state-sync** (NEW — the `getState()` support):
  - `const materialized = new Map<number, { dst: number; len: number }>()`, cleared in `deployAll()`.
  - `q_state_size: (i: number) => (handles[i]?.stateSize ?? 0) >>> 0`.
  - `q_state_in: (i, dst, len) => { const c = handles[i]; if (!c) return; write(dst, c.state().subarray(0, len >>> 0)); materialized.set(i, { dst, len: len >>> 0 }); }`.
  - `flushState()`: `for (const [i, m] of materialized) handles[i]?.writeState(read(m.dst, m.len));`.
  - `reReadState()`: `for (const [i, m] of materialized) { const c = handles[i]; if (c) write(m.dst, c.state().subarray(0, m.len)); }`.
  - Call `flushState()` as the FIRST line of `q_invoke`, `q_query`, `q_sysproc`. Call `reReadState()` as the LAST line of `q_invoke` and `q_sysproc` (after mutation; not after `q_query`).
  - `q_set_epoch: (e) => { sim.epochN = e >>> 0; }`, `q_get_epoch: () => sim.epochN >>> 0`.
- Instantiate the runner with `{ thost, env }` where `env` carries the `_rdrand64_step` PRNG + a no-op proxy fallback (copy from `runUpstream`). Use a Proxy that returns a no-op module for any unbound import name (copy from `runUpstream`).
- Run: `_initialize()`, then loop `run_test(i)` for `i in 0..test_count()`. Return the collected results.

- [ ] **Step 1: Write the binding.** Add `runContractTesting` to `gtest.ts` per the design; export from `index.ts`.

- [ ] **Step 2: Reuse the existing QUTIL runner to verify it.** In `packages/engine/tests/contract-testing.test.ts`, build the QUTIL runner + QUTIL/QX wasm the same way `qutil-bridge.ts` does is too heavy for engine tests — instead, import from the compile package is not allowed (engine must not depend on compile). So verify against a SAVED runner+contract wasm: in the test, skip if `wasi` unavailable; otherwise call into `@qinit/build` (an allowed dev dependency in tests) to build the QUTIL runner + `@qinit/compile` to build QUTIL+QX, then `runContractTesting(runner, {4: qutil, 1: qx})` and assert `passed >= 51`. If cross-package test deps are awkward, place this test in `packages/compile/tests/` instead (compile already depends on build + engine) and keep `runContractTesting` in engine. Decide based on the existing test deps; the binding still lives in engine.

- [ ] **Step 3: Run it.** `cd packages/<pkg> && bun test tests/contract-testing.test.ts` → QUTIL `>= 51 PASS` via the engine binding (proves the migrated logic + that nothing regressed vs the test-dir `runUpstream`).

- [ ] **Step 4: Commit.** `feat(engine): generic runContractTesting binding (multi-contract thost + getState state-sync)`

---

### Task 2: Shipped harness header — `wasm_contract_testing.h`

Author the qinit harness header mirroring the native `contract_testing.h` EASY surface, every op routed to the thost imports `runContractTesting` binds.

**Files:**
- Create: `packages/build/src/assets/wasm_contract_testing.h`
- Reference (read, do not edit): `core-lite/test/contract_testing.h` (the API spec), `packages/compile/tests/qutil-bridge.ts` SHIM (a working partial, for the thost signatures).

**Required surface (Stage A / EASY):**
- `extern "C"` thost import decls (module `"thost"`) matching Task 1's handlers: `q_reset, q_init, q_invoke, q_query, q_sysproc, q_fund, q_balance, q_shares, q_possessed, q_spectrum, q_decrease, q_state_size, q_state_in, q_set_epoch, q_get_epoch`. Use the exact signatures from the `qutil-bridge.ts` SHIM for the shared ones.
- `enum SystemProcedureID { INITIALIZE=0, BEGIN_EPOCH=1, END_EPOCH=2, BEGIN_TICK=3, END_TICK=4 };`
- A `contractStates` proxy whose `operator[](unsigned i)` returns a stable, lazily-`malloc`'d shadow buffer synced via `q_state_in` (size from `q_state_size`). (See `task brief` / registry scratch for the exact C; same as the killed-agent design.)
- `class ContractTesting` with: ctor → `q_reset`; `initEmptySpectrum()`/`initEmptyUniverse()` no-ops; templated `callFunction(contractIndex, fnInputType, input, output, ...)` → `q_query`; templated `invokeUserProcedure(contractIndex, procInputType, input, output, user, amount, ...)` → zero output then `q_invoke`; `callSystemProcedure(contractIndex, sysProcId, ...)` → `q_sysproc`. (Signatures verbatim from the SHIM, which already matches the corpora.)
- `#define system` → a `qubicSystemStruct`-style global whose `.epoch` proxies `q_get_epoch`/`q_set_epoch` (conversion `operator unsigned short` for reads, `operator=` for writes). Provide a `.tick` field as a plain settable value backed by a `q_set_tick` only if trivially addable; otherwise omit (HARD tier).
- Free helpers (file-scope `static inline`): `increaseEnergy(id, amount)`→`q_fund`; `getBalance(id)`→`q_balance`; `spectrumIndex(id)`→`q_spectrum`; `decreaseEnergy(idx, amount)`→`q_decrease`; `numberOfShares(Asset)`→`q_shares`; `numberOfPossessedShares(...)`→`q_possessed`; `assetNameFromString`/`assetNameFromInt64`; `checkContractExecCleanup()` no-op; macro `INIT_CONTRACT(name)` → `q_init(name##_CONTRACT_INDEX)`.
- Guard against double-include and ensure it relies only on types already in scope (qpi.h types via the wrapper; `lite_test.h` macros included by recipe BEFORE the corpus body, hence before this header's include point).

- [ ] **Step 1: Author the header** matching the native API surface for the EASY corpora. Cross-check the method/free-function signatures against `core-lite/test/contract_testing.h` so a corpus referencing them compiles unmodified.

- [ ] **Step 2: Smoke-compile check** is done via Task 3 (the build path) — there is no standalone compile here. Commit after Task 3 wiring proves it compiles, OR commit now and let Task 3 validate. Prefer: commit now (header only), Task 3 validates.

- [ ] **Step 3: Commit.** `feat(build): ship wasm_contract_testing.h harness (EASY surface → thost)`

---

### Task 3: Build path — corpus → runner wasm

Add a build entry that compiles a corpus verbatim against the qinit header.

**Files:**
- Modify: `packages/build/src/index.ts` (+ `recipe.ts` if needed)
- Test: covered by Task 4.

**Interface (Produces):**
```typescript
export async function buildCorpusRunner(o: {
  corpusPath: string;        // core-lite/test/contract_X.cpp
  contractPath: string;      // core-lite/src/contracts/X.h
  name: string; stateType: string; slot: number;
  corePath: string; outDir: string; arenaSz?: number;
}): Promise<BuildResult>;
```
**Design:**
- Read the corpus; produce `testSource` by replacing the line `#include "contract_testing.h"` with `#include "wasm_contract_testing.h"` (and strip any `#include "oracle_testing.h"` line — Stage A defers oracle). Leave the rest of the corpus verbatim. Use a regex like the QUTIL bridge's strip, but REPLACE rather than delete.
- Make `wasm_contract_testing.h` resolvable from the compile: write the asset (read from `packages/build/src/assets/wasm_contract_testing.h` via a path relative to `import.meta`/`__dirname`) into `outDir` so the quote-include resolves there; ensure `outDir` is on the clang include path the recipe uses for the temp wrapper (verify how recipe sets `-I`/the wrapper dir; if the wrapper compiles from `outDir`, co-locating the header suffices).
- Call `buildContract({ contractPath, name, stateType, slot, corePath, outDir, arenaSz, skipVerify: true, testSource, testPath: basename(corpusPath) })` and return its result.

- [ ] **Step 1: Implement `buildCorpusRunner`**; export it from `@qinit/build`.
- [ ] **Step 2: Verify include resolution** by building the QUTIL corpus through it in a scratch run inside Task 4. (No separate test here.)
- [ ] **Step 3: Commit.** `feat(build): buildCorpusRunner — compile upstream corpora verbatim against the qinit harness`

---

### Task 4: Driver + dual-backend sweep (validate QUTIL + EASY tier)

**Files:**
- Create: `packages/build/tests/sc-corpus.test.ts` (or `packages/compile/tests/` if cross-deps require)

**Design:**
- A `SPECS` registry of the EASY tier (table in Global Constraints): `{ corpus, contractPath header, name, stateType, slot, callees: [{name, header, stateType, slot}] }`.
- For each spec: `buildCorpusRunner(...)` → runner; build the contract-under-test + callees with BOTH backends (`buildContract` no-testSource = native; `compileContract` = ours) into a `Record<number, Uint8Array>`; `runContractTesting(runner, contracts)` for each backend.
- Record a scoreboard row `{ name, runnerBuild: ok|err, native: "N/M", ours: "N/M" }`; print a table. Wrap each spec in try/catch so one failure doesn't abort the sweep.
- A non-sweep `parity` test (no env guard) asserts QUTIL native AND ours both `>= 51` through this qinit path. The full EASY sweep is guarded by `SC_SWEEP=1`.

- [ ] **Step 1: Registry + driver + parity test.**
- [ ] **Step 2: Run parity.** `bun test tests/sc-corpus.test.ts` → QUTIL 51/51 native + ours through the qinit harness (proves the whole path end-to-end and that it subsumes the test-dir bridge).
- [ ] **Step 3: Run sweep.** `SC_SWEEP=1 bun test tests/sc-corpus.test.ts` → scoreboard for the 5 EASY corpora. Record results; do not fix failures here — native column = harness fidelity, ours column = compiler. Failures become the Stage-B/triage backlog.
- [ ] **Step 4: Commit.** `test(build): dual-backend corpus sweep — QUTIL parity + EASY-tier scoreboard via qinit harness`

---

## Self-Review

- Harness lives in qinit, once, generic (header + engine binding + build redirect) → Tasks 1-3. ✓
- Corpus compiles verbatim (include redirect, not per-contract SHIM) → Task 3. ✓
- `getState()` state-sync (the 24/25 universal surface) → Task 1 design. ✓
- Validates QUTIL parity + EASY tier dual-backend → Task 4. ✓
- Existing test-dir QUTIL bridge untouched as regression anchor → Global Constraints. ✓
- HARD surface (assets/tick/time/oracle) deferred; HARD corpora fail-to-link and are reported → noted (Stage B/C). ✓
- CLI wrapper deferred to a later stage (user chose harness-first) → Goal. ✓
- Out of scope: MEDIUM/HARD/oracle tiers, the `qinit gtest` CLI, retiring the test-dir bridge.
- Type consistency: `runContractTesting(runnerWasm, contracts: Record<number,Uint8Array>): Promise<TestResult[]>` used identically in Tasks 1 and 4; `buildCorpusRunner` opts/return consistent Task 3 ↔ 4; thost import names identical between the header (Task 2) and the binding (Task 1).
