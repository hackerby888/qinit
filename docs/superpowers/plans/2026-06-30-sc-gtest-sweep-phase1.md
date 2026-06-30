# System-contract gtest sweep — Phase 1 (generic bridge + EASY tier)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Generalize the QUTIL-specific dual-backend gtest bridge into a contract-agnostic harness driven by a `ContractSpec`, then produce a dual-backend scoreboard (native vs ours) for the EASY tier of upstream system-contract corpora.

**Architecture:** One generic runner-build + run path parameterized over a `ContractSpec` (corpus file, contract `.h`, stateType, slot, callee specs). A superset SHIM adds, over the QUTIL SHIM, a synced `contractStates[]` proxy (the universal `getState()` surface), epoch control, and `checkContractExecCleanup`/`assetNameFromInt64` stubs. The contracts-under-test deploy in a Sim; the test's direct state reads/writes stay coherent via a flush-before-dispatch / re-read-after shadow-buffer sync.

**Tech Stack:** TypeScript, Bun test, `@qinit/compile`, `@qinit/build` (clang), `@qinit/engine` (Sim/Contract).

## Global Constraints

- No AI/Claude attribution in commits. No process/conversation comments in code. No one-line function bodies. Blank lines between logical sections.
- Branch `feat/ts-qpi-compiler`. core-lite read-only. `BuildResult.so` not renamed.
- The existing QUTIL bridge (`qutil-upstream.test.ts` / `qutil-dual.test.ts` / `qutil-bridge.ts`) must keep passing 51/51 unchanged — do not regress it. The generic harness is ADDITIVE.
- Run tests from `packages/compile`: `bun test tests/<file>.test.ts`. wasi-sdk clang present.
- CONTRACT_INDEX values (core-lite contract_def.h): QX=1, QUOTTERY=2, RANDOM=3, QUTIL=4, GQMPROP=6, CCF=8, QEARN=9, QVAULT=10, QRP=21, VOTTUNBRIDGE=25. GGWP→struct WOLFPACK@28.
- EASY-tier corpora + contracts (this phase): `contract_qrp`→QReservePool.h(QRP)@21; `contract_vottunbridge`→VottunBridge.h(VOTTUNBRIDGE)@25; `contract_qearn`→Qearn.h(QEARN)@9; `contract_gqmprop`→GeneralQuorumProposal.h(GQMPROP)@6; `contract_ccf`→ComputorControlledFund.h(CCF)@8. None have callees.

## File Structure

- `packages/compile/tests/gtest-bridge.ts` — **NEW** generic harness. `ContractSpec` type, generic `SHIM_SUPERSET`, `buildRunner(spec)`, `buildContractsOurs(spec)`, `buildContractsNative(spec)`, `runGtest(runnerWasm, contracts, opts)`, `wasiAvailable`, `type TR`.
- `packages/compile/tests/sc-registry.ts` — **NEW** the `ContractSpec[]` registry (EASY tier + QUTIL).
- `packages/compile/tests/sc-sweep.test.ts` — **NEW** dual-backend sweep over the registry → scoreboard; guarded by `SC_SWEEP` env (expensive). A non-guarded `parity` test asserts QUTIL stays 51/51 through the generic harness.
- Existing `qutil-bridge.ts` etc. — untouched.

---

### Task 1: Generic bridge core + QUTIL parity + first getState contract (qrp)

This is the crux: build the generic harness and prove (a) QUTIL still 51/51 through it (parity, exercises no `getState`) and (b) `contract_qrp` — the simplest `getState()` corpus — runs through the NATIVE backend (proves the state-sync mechanism end-to-end).

**Files:**
- Create: `packages/compile/tests/gtest-bridge.ts`
- Create (minimal, qrp+qutil only): `packages/compile/tests/sc-registry.ts`
- Create: `packages/compile/tests/gtest-bridge.test.ts` (parity + qrp-native smoke)

**Interfaces (Produces):**
```typescript
export interface CalleeSpec {
  name: string;        // e.g. "QX"
  header: string;      // contract .h filename under core-lite/src/contracts, e.g. "Qx.h"
  stateType: string;   // C++ struct type, e.g. "QX"
  slot: number;
}
export interface ContractSpec {
  corpus: string;      // test file under core-lite/test, e.g. "contract_qrp.cpp"
  header: string;      // contract .h filename, e.g. "QReservePool.h"
  name: string;        // ticker / build name, e.g. "QRP"
  stateType: string;   // C++ struct type (== name unless aliased, e.g. Quottery→QUOTTERY, GGWP→WOLFPACK)
  slot: number;
  callees: CalleeSpec[];
}
export interface TR { name: string; passed: boolean; message: string }
export function wasiAvailable(): boolean;
export function buildRunner(core: string, spec: ContractSpec): Promise<Uint8Array>;
export function buildContractsOurs(core: string, spec: ContractSpec): Promise<Record<number, Uint8Array>>;
export function buildContractsNative(core: string, spec: ContractSpec): Promise<Record<number, Uint8Array>>;
export function runGtest(runnerWasm: Uint8Array, contracts: Record<number, Uint8Array>): Promise<TR[]>;
```

**Design — port + generalize from `qutil-bridge.ts`:**

1. **`SHIM_SUPERSET`** = the existing QUTIL `SHIM` (ContractTesting class + free helpers + thost imports) PLUS:
   - **State access** (the universal `getState()` surface). Add thost imports and a `contractStates` proxy:
     ```cpp
     extern "C" {
     TQ(q_state_size) unsigned int qb_state_size(unsigned int i);
     TQ(q_state_in)   void         qb_state_in(unsigned int i, void* dst, unsigned int len);
     }
     static void* qb_bufs[64];
     static void* qb_state_ptr(unsigned int i) {
       if (!qb_bufs[i]) {
         qb_bufs[i] = malloc(qb_state_size(i));
       }
       qb_state_in(i, qb_bufs[i], qb_state_size(i));
       return qb_bufs[i];
     }
     struct QbStatesProxy {
       void* operator[](unsigned int i) const {
         return qb_state_ptr(i);
       }
     };
     static QbStatesProxy contractStates;
     ```
     (The corpora reference a global `contractStates[INDEX]`; this proxy satisfies it. `64` covers all indices ≤ 28.)
   - **Epoch control**: a `system`-like struct exposing a writable `epoch` that routes to a thost `q_set_epoch`. Corpora write `system.epoch = N`. Provide:
     ```cpp
     extern "C" { TQ(q_set_epoch) void qb_set_epoch(unsigned int e); TQ(q_get_epoch) unsigned int qb_get_epoch(); }
     struct QbEpochProxy {
       operator unsigned short() const { return (unsigned short)qb_get_epoch(); }
       void operator=(unsigned int e) { qb_set_epoch(e); }
     };
     struct QbSystem { QbEpochProxy epoch; };
     static QbSystem system;
     ```
     (If a corpus reads `system.epoch` in arithmetic, the conversion operator covers it. If a corpus also writes `system.tick`/`utcTime`, those are HARD-tier — out of scope this phase; leave undefined so HARD corpora simply fail to compile in the runner and are reported as such by the sweep, not silently mis-run.)
   - **Stubs**: `static void checkContractExecCleanup() {}` and `static unsigned long long assetNameFromInt64(long long v) { return (unsigned long long)v; }` (only if referenced; harmless to always define).

2. **`runGtest`** = the existing `runUpstream` body, generalized:
   - Keep the existing thost handlers (q_reset, q_init, q_invoke, q_query, q_sysproc, q_fund, q_balance, q_shares, q_possessed, q_spectrum, q_decrease).
   - `deployAll()` deploys EVERY index in `contracts` (already generic — it iterates the map).
   - **Add state-sync:**
     - Track `const materialized = new Map<number, { dst: number; len: number }>()`.
     - `q_state_size: (i) => handles[i]?.stateSize >>> 0` (0 if absent).
     - `q_state_in: (i, dst, len) => { const c = handles[i]; if (!c) return; const s = c.state(); write(dst, s.subarray(0, len)); materialized.set(i, { dst, len }); }`.
     - A `flushState()` helper: `for (const [i, {dst, len}] of materialized) handles[i]?.writeState(read(dst, len));`.
     - A `reReadState()` helper: `for (const [i, {dst, len}] of materialized) { const c = handles[i]; if (c) write(dst, c.state().subarray(0, len)); }`.
     - Call `flushState()` at the TOP of `q_invoke`, `q_query`, `q_sysproc` (before the Sim call). Call `reReadState()` at the END of `q_invoke` and `q_sysproc` (after mutation; not needed after `q_query`).
     - Reset `materialized.clear()` inside `deployAll()` (alongside the existing spectrum resets).
   - Epoch thost: `q_set_epoch: (e) => { sim.epochN = e >>> 0; }`, `q_get_epoch: () => sim.epochN >>> 0`.

3. **`buildRunner(core, spec)`** = the existing `buildRunner`, but: read `${core}/test/${spec.corpus}`, strip its `#include "contract_testing.h"` (and any `#include "oracle_testing.h"` line — defensive), prepend `SHIM_SUPERSET`, and build with `contractPath: ${core}/src/contracts/${spec.header}`, `name: spec.name`, `stateType: spec.stateType`, `slot: spec.slot`. The runner's host contract is the contract under test (for its types). On `!built.ok`, throw with the stderr digest (the sweep catches it → "runner build failed").

4. **`buildContractsOurs(core, spec)`** — compile `spec` + each callee with `compileContract`; wire callee IDL + calleeSources exactly as the QUTIL path does (loop over `spec.callees`). Return `{ [spec.slot]: main, ...callees }`.

5. **`buildContractsNative(core, spec)`** — `buildContract` (no testSource) for `spec` + each callee. Return the same map shape.

- [ ] **Step 1: Port the generic bridge.** Create `gtest-bridge.ts` per the design above (copy `qutil-bridge.ts`, parameterize over `ContractSpec`, add `SHIM_SUPERSET` extensions + state-sync). Create `sc-registry.ts` with two entries: QUTIL (`{corpus:"contract_qutil.cpp", header:"QUtil.h", name:"QUTIL", stateType:"QUTIL", slot:4, callees:[{name:"QX",header:"Qx.h",stateType:"QX",slot:1}]}`) and QRP (`{corpus:"contract_qrp.cpp", header:"QReservePool.h", name:"QRP", stateType:"QRP", slot:21, callees:[]}`).

- [ ] **Step 2: QUTIL parity test.** In `gtest-bridge.test.ts`, write a test (no env guard) that builds the QUTIL spec via the generic `buildRunner`+`buildContractsOurs`+`runGtest` and asserts `passed >= 51`. Run: `cd packages/compile && bun test tests/gtest-bridge.test.ts`. Expected: QUTIL 51 PASS through the generic harness. This proves generalization didn't break the proven path.

- [ ] **Step 3: qrp native smoke.** Add a test that builds the QRP spec via `buildRunner`+`buildContractsNative`+`runGtest`, logs `qrp native: N PASS / M`, and asserts `M > 0` (corpus ran) — do NOT assert all pass yet (this proves the state-sync mechanism end-to-end on the simplest getState corpus; native is the reference). If the runner fails to build or the run throws, report the error — that is the finding. Run the same test file.

- [ ] **Step 4: Commit.**
  ```bash
  git add packages/compile/tests/gtest-bridge.ts packages/compile/tests/sc-registry.ts packages/compile/tests/gtest-bridge.test.ts
  git commit -m "feat(compile): generic dual-backend gtest bridge (ContractSpec + state-sync); QUTIL parity + qrp native smoke"
  ```

---

### Task 2: EASY-tier registry + dual-backend sweep scoreboard

**Files:**
- Modify: `packages/compile/tests/sc-registry.ts` (add the 4 remaining EASY specs)
- Create: `packages/compile/tests/sc-sweep.test.ts`

- [ ] **Step 1: Registry.** Add specs for vottunbridge, qearn, gqmprop, ccf (all `callees: []`), per the Global Constraints mapping. Keep QUTIL + QRP.

- [ ] **Step 2: Sweep test.** Create `sc-sweep.test.ts`, guarded `if (!process.env.SC_SWEEP) return;`. For each EASY spec (exclude QUTIL from the sweep body — it's covered by parity; optionally include), build the runner once, then run BOTH backends through `runGtest`, and record a row `{ name, compileOurs: ok|err, compileNative: ok|err, native: "N/M", ours: "N/M" }`. Wrap each spec in try/catch so one contract's build failure doesn't abort the sweep — a thrown build/compile error becomes that row's `err`. Print a table and a summary. Assert nothing strict (this is a scoreboard); just `expect(rows.length).toBe(<count>)`.
  Example row print: `console.log(\`  ${name.padEnd(14)} compile[o:${compileOurs} n:${compileNative}]  native ${native}  ours ${ours}\`)`.

- [ ] **Step 3: Run the sweep.** `cd packages/compile && SC_SWEEP=1 bun test tests/sc-sweep.test.ts`. Capture the scoreboard table in the report. Each contract's native column = bridge/harness fidelity; ours column = our compiler. Do not fix failures in this task — record them.

- [ ] **Step 4: Commit.**
  ```bash
  git add packages/compile/tests/sc-registry.ts packages/compile/tests/sc-sweep.test.ts
  git commit -m "test(compile): EASY-tier system-contract dual-backend sweep scoreboard"
  ```

---

## Self-Review

- Generic harness parameterized over `ContractSpec` (corpus/header/name/stateType/slot/callees) → Task 1. ✓
- State-sync (`getState()` coherence) via malloc'd shadow + flush-before / re-read-after → Task 1 design. ✓
- QUTIL parity (no regression) → Task 1 Step 2. ✓
- First getState corpus proven on native → Task 1 Step 3. ✓
- EASY-tier scoreboard, both backends, build-failure-tolerant → Task 2. ✓
- HARD surface (tick/time) intentionally left undefined → HARD corpora fail-to-build and are reported, not mis-run → noted in SHIM design. ✓
- Out of scope: MEDIUM/HARD tiers, oracle, testex, contract_core. ✓
- No placeholders; the state-sync C and JS are given in full. Types consistent (`ContractSpec`, `CalleeSpec`, `TR`, the five builder/run signatures used identically in both tasks).
