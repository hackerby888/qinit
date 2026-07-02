// Run a contract's gtest-style tests that were compiled INTO its wasm (core-lite extensions/lite_test.h).
// The module exports a runner (test_count / test_name / run_test) and imports a "thost" (test-host) table; we
// bind thost to a FRESH, isolated Virtual Node (Sim) so tests never touch the live session, then drive each
// test. The contract under test is the same module: its own qpi.* calls resolve through lhost, while the test
// body drives it through thost (which re-enters the instance via Sim — a single-instance, non-reentrancy-prone
// path because run_test is not mid-dispatch when it calls thost). Runs in Bun and the browser; no native build.
import { Sim } from "./sim";
import { Contract, KIND, SP, dateFields, packDateAndTime } from "./runtime";
import { initK12, deriveKeysSync, k12Bytes } from "./k12";

export interface TestResult {
  name: string;     // "Suite.Name"
  passed: boolean;
  message: string;  // failure detail (empty when passed)
}

// The isolated node deploys the test module at a fixed slot; nothing else lives on this throwaway chain.
const TEST_SLOT = 1;
// For differential runs, the test runner module lives at its own slot and drives the contract at TEST_SLOT.
const RUNNER_SLOT = 2;

export async function runTests(testWasm: Uint8Array): Promise<TestResult[]> {
  await initK12();

  // A dedicated genesis node — empty spectrum + universe, no other contracts, fees off (tests assert logic,
  // not fee accounting). Discarded when this function returns.
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const results: TestResult[] = [];
  const dec = new TextDecoder();

  // `c` is assigned after deploy; the thost closures below capture it and only run later (during run_test),
  // so the deferred read is safe. Always take a fresh memory view — a dispatch can grow (detach) the buffer.
  let c: Contract;
  const view = () => new Uint8Array(c.mem.buffer);
  const read = (off: number, len: number) => view().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, bytes: Uint8Array) => view().set(bytes, off >>> 0);

  // Reset the contract under test to a fresh INITIALIZE'd state (its StateData lives in this module's memory).
  const reinit = (): void => {
    c.zeroState();
    if (c.hasSysproc(SP.INITIALIZE)) {
      c.invoke(KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
    }
  };

  const thost: Record<string, Function> = {
    // Fixture reset (the test's `ContractTest t;` ctor): clean ledger + fresh contract state + INITIALIZE.
    t_reset: () => {
      sim.resetLedger();
      reinit();
    },
    // Invoke a user procedure with an invocation reward + originator, through the real tx path (energy, fees,
    // POST_INCOMING_TRANSFER), then copy the output back into the test module's memory.
    t_invoke: (it: number, inPtr: number, inLen: number, amount: bigint, originPtr: number, outPtr: number, outCap: number): number => {
      const input = read(inPtr, inLen);
      const origin = read(originPtr, 32);
      const out = sim.procedure(TEST_SLOT, it >>> 0, input, { originator: origin, invocator: origin, reward: BigInt(amount) });
      const n = Math.min(out.length, outCap >>> 0);
      if (n) {
        write(outPtr, out.subarray(0, n));
      }
      return n >>> 0;
    },
    // Call a user function (read-only).
    t_query: (it: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
      const input = read(inPtr, inLen);
      const out = sim.query(TEST_SLOT, it >>> 0, input);
      const n = Math.min(out.length, outCap >>> 0);
      if (n) {
        write(outPtr, out.subarray(0, n));
      }
      return n >>> 0;
    },
    t_fund: (idPtr: number, amount: bigint): void => {
      sim.fund(read(idPtr, 32), BigInt(amount));
    },
    t_balance: (idPtr: number): bigint => {
      return sim.balance(read(idPtr, 32));
    },
    // Derive a FourQ public key from a seed string (the test funds + originates from derived identities).
    t_derive: (seedPtr: number, seedLen: number, outPtr: number): void => {
      const seed = dec.decode(read(seedPtr, seedLen));
      write(outPtr, deriveKeysSync(seed).publicKey);
    },
    t_tick: (n: number): void => {
      for (let i = 0; i < (n >>> 0); i++) {
        sim.advance();
      }
    },
    // One result per test, emitted by run_test before it returns.
    t_report: (namePtr: number, nameLen: number, passed: number, msgPtr: number, msgLen: number): void => {
      results.push({
        name: dec.decode(read(namePtr, nameLen)),
        passed: (passed >>> 0) !== 0,
        message: dec.decode(read(msgPtr, msgLen)),
      });
    },
  };

  c = sim.deploy(TEST_SLOT, testWasm, thost);
  if (typeof c.ex.test_count !== "function" || typeof c.ex.run_test !== "function") {
    throw new Error("not a gtest wasm: missing test_count/run_test exports (build with a testSource)");
  }
  return driveTests(c, sim, reinit, results, read, view);
}

// Differential run: deploy a SEPARATE contract wasm at TEST_SLOT (the one under test) and drive it with the
// test logic compiled into `testWasm`. Lets a contract built by an independent toolchain (e.g. @qinit/compile)
// be validated against the very tests that pin the native-clang build's behaviour.
export async function runTestsAgainst(testWasm: Uint8Array, contractWasm: Uint8Array): Promise<TestResult[]> {
  await initK12();
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const results: TestResult[] = [];
  const dec = new TextDecoder();

  // The contract under test at TEST_SLOT; the test runner (with thost) at RUNNER_SLOT.
  const contract = sim.deploy(TEST_SLOT, contractWasm);

  let runner: Contract;
  const view = () => new Uint8Array(runner.mem.buffer);
  const read = (off: number, len: number) => view().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, bytes: Uint8Array) => view().set(bytes, off >>> 0);

  // Reset the contract under test (its StateData lives in ITS module's memory, not the runner's).
  const reinit = (): void => {
    contract.zeroState();
    if (contract.hasSysproc(SP.INITIALIZE)) {
      contract.invoke(KIND.SYSPROC, SP.INITIALIZE, new Uint8Array(0), { entryPoint: SP.INITIALIZE });
    }
  };

  const thost: Record<string, Function> = {
    t_reset: () => { sim.resetLedger(); reinit(); },
    t_invoke: (it: number, inPtr: number, inLen: number, amount: bigint, originPtr: number, outPtr: number, outCap: number): number => {
      const input = read(inPtr, inLen);
      const origin = read(originPtr, 32);
      const out = sim.procedure(TEST_SLOT, it >>> 0, input, { originator: origin, invocator: origin, reward: BigInt(amount) });
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },
    t_query: (it: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
      const input = read(inPtr, inLen);
      const out = sim.query(TEST_SLOT, it >>> 0, input);
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },
    t_fund: (idPtr: number, amount: bigint): void => { sim.fund(read(idPtr, 32), BigInt(amount)); },
    t_balance: (idPtr: number): bigint => sim.balance(read(idPtr, 32)),
    t_derive: (seedPtr: number, seedLen: number, outPtr: number): void => {
      const seed = dec.decode(read(seedPtr, seedLen));
      write(outPtr, deriveKeysSync(seed).publicKey);
    },
    t_tick: (n: number): void => { for (let i = 0; i < (n >>> 0); i++) sim.advance(); },
    t_report: (namePtr: number, nameLen: number, passed: number, msgPtr: number, msgLen: number): void => {
      results.push({
        name: dec.decode(read(namePtr, nameLen)),
        passed: (passed >>> 0) !== 0,
        message: dec.decode(read(msgPtr, msgLen)),
      });
    },
  };

  runner = sim.deploy(RUNNER_SLOT, testWasm, thost);
  if (typeof runner.ex.test_count !== "function" || typeof runner.ex.run_test !== "function") {
    throw new Error("not a gtest wasm: missing test_count/run_test exports (build with a testSource)");
  }
  return driveTests(runner, sim, reinit, results, read, view);
}

// Generic multi-contract test host binding. The runner wasm is a separately-built upstream corpus (e.g.
// contract_qutil.cpp compiled with lite_test.h); `contracts` maps contract-index → deployable wasm. Every
// thost import is bound to an indexed Sim collaborator, so the runner can drive N contracts in one session.
// State-sync (q_state_in / q_state_size): the runner may pull a contract's state into its own memory for
// direct field inspection (getState<T>()), and may mutate it before the next call; we flush those mutations
// back before each dispatch and re-read the updated state afterwards so the runner always sees live values.
export async function runContractTesting(
  runnerWasm: Uint8Array,
  contracts: Record<number, Uint8Array>,
): Promise<TestResult[]> {
  const dec = new TextDecoder();
  const results: TestResult[] = [];

  let sim: Sim;
  let handles: Record<number, Contract> = {};
  let spectrumIds: string[] = [];
  let spectrumBytes: Uint8Array[] = [];
  let runner: WebAssembly.Instance;
  // State-sync between the runner's getState() shadow buffers and the engine's contract instances. The full
  // state can be hundreds of MB (e.g. QEARN ~214MB), so a per-dispatch full copy is fatal to dispatch-heavy
  // tests. Sync lazily instead:
  //   materialized: the runner shadow buffers (dst+len) the test has pulled at least once.
  //   engineDirty:  contracts whose engine state advanced past the shadow (set after a mutating dispatch);
  //                 the next getState() pull copies fresh, every other access skips the copy.
  //   touched:      shadows the test accessed since the last flush (it may have written them); only these are
  //                 pushed back, and only while still in sync with the engine (never over a newer engine write).
  const materialized = new Map<number, { dst: number; len: number }>();
  const engineDirty = new Set<number>();
  const touched = new Set<number>();

  const mem = () => new Uint8Array((runner.exports.memory as WebAssembly.Memory).buffer);
  const read = (off: number, len: number) => mem().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, b: Uint8Array) => mem().set(b, off >>> 0);
  const id32 = (p: number) => read(p, 32);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  // Opt-in instrumentation. QINIT_GTEST_TRACE logs entry/exit of every engine dispatch (a dispatch entered
  // but never exited is a contract procedure looping in the engine). QINIT_GTEST_PROF (implied by TRACE)
  // accumulates a cost breakdown — engine-dispatch time vs state-pull time/bytes — printed once at the end,
  // so a slow corpus run can be attributed to dispatch overhead, full-state copies, or test-side wasm.
  const env_ = (globalThis as any).process?.env ?? {};
  const dispTrace = !!env_.QINIT_GTEST_TRACE;
  const prof = dispTrace || !!env_.QINIT_GTEST_PROF;
  const now = () => (globalThis as any).performance?.now?.() ?? 0;
  const stat = { dispN: 0, dispMs: 0, pulls: 0, pullBytes: 0, pullMs: 0 };
  const traceDisp = <T>(label: string, fn: () => T): T => {
    if (!prof) return fn();
    const n = ++stat.dispN;
    if (dispTrace) (globalThis as any).process.stderr.write(`[disp #${n}] > ${label}\n`);
    const t0 = now();
    const r = fn();
    stat.dispMs += now() - t0;
    if (dispTrace) (globalThis as any).process.stderr.write(`[disp #${n}] < ${label}\n`);
    if (prof && n % 5000 === 0) {
      (globalThis as any).process.stderr.write(
        `[gtest-prof] @${n} dispatchMs=${Math.round(stat.dispMs)} pulls=${stat.pulls} pulledMB=${Math.round(stat.pullBytes / (1 << 20))} pullMs=${Math.round(stat.pullMs)}\n`,
      );
    }
    return r;
  };

  // Shared-memory contracts (linked with --import-memory, see recipe.ts sharedMemBase): the module lives
  // inside the runner's memory, so the runner's contractStates[i] pointer IS the live state — the shadow
  // sync machinery below never engages for them. Detected once from the module's import list.
  const sharedSlots = new Set<number>();
  for (const [idx, wasm] of Object.entries(contracts)) {
    const m = new WebAssembly.Module(wasm as BufferSource);
    if (WebAssembly.Module.imports(m).some((im) => im.module === "env" && im.kind === "memory")) sharedSlots.add(Number(idx));
  }
  const runnerMemory = (): WebAssembly.Memory | undefined =>
    (runner?.exports?.memory as WebAssembly.Memory | undefined);

  const deployAll = () => {
    // The corpus `system` proxy (epoch / tick / chain clock) mirrors real Qubic's persistent global `system`:
    // constructing a ContractTesting fixture resets spectrum/universe/contract states but never system.epoch/tick.
    // A corpus may set system.epoch BEFORE building the fixture (QBOND: `system.epoch = 192; ContractTestingQBond
    // qbond;`), so carry the clock across the rebuild instead of zeroing it on the fresh Sim.
    const prevEpoch = sim?.epochN, prevTick = sim?.tickN, prevTimeBase = sim?.timeBaseMs;
    const prevDigest = sim?.prevSpectrumDigestOverride;
    sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    // Native-harness clock semantics: etalonTick's date fields ARE the chain time and never move on their
    // own — a corpus advances time only by writing them (q_set_datetime). Freeze the per-tick advance.
    sim.tickDuration = 0;
    // Native etalonTick.prevSpectrumDigest is a zero-initialized global the corpus may pin; contracts read
    // exactly that value, not a live digest of the throwaway chain.
    sim.prevSpectrumDigestOverride = prevDigest ?? new Uint8Array(32);
    if (prevEpoch !== undefined) sim.epochN = prevEpoch;
    if (prevTick !== undefined) sim.tickN = prevTick;
    if (prevTimeBase !== undefined) sim.timeBaseMs = prevTimeBase;
    handles = {};
    spectrumIds = [];
    spectrumBytes = [];
    materialized.clear();
    engineDirty.clear();
    touched.clear();
    for (const [idx, wasm] of Object.entries(contracts)) {
      const shared = sharedSlots.has(Number(idx));
      if (shared && !runnerMemory()) throw new Error(`gtest: contract slot ${idx} is a shared-memory build but the runner is not instantiated yet`);
      handles[Number(idx)] = sim.deploy(Number(idx), wasm, undefined, shared ? runnerMemory() : undefined);
    }
  };

  // Push back only shadows the test touched since the last flush, and only while the shadow is still in sync
  // with the engine (not behind a mutating dispatch) — pushing a stale shadow would clobber newer engine
  // state. A touched shadow that has gone engineDirty is dropped from the push; the test re-pulls it fresh
  // on its next access.
  const flushState = () => {
    if (touched.size === 0) return;
    for (const i of touched) {
      const m = materialized.get(i);
      const c = handles[i];
      if (m && c && !engineDirty.has(i)) syncChunked(mem().subarray(m.dst, m.dst + m.len), c.stateView(m.len));
    }
    touched.clear();
  };

  // After a mutating dispatch the engine state has advanced past every materialized shadow. core-lite's
  // contractStates[i] is a live pointer, so a corpus may cache `auto s = getState()` and read s-> after a
  // dispatch without re-fetching. To preserve that, refresh a shadow in place now when it is small enough
  // to copy cheaply. For a very large shadow (hundreds of MB — QUTIL, QEARN) a per-dispatch copy is fatal,
  // so defer its refresh to the next getState() access via engineDirty; those corpora read through fresh
  // getState() calls rather than a cached pointer.
  // A corpus reads through cached getState() pointers in plain statements (loops, locals), not only inside
  // EXPECT/ASSERT operands, so a deferred refresh is not enough: every mutating dispatch refreshes each
  // materialized shadow in place. Small shadows take the straight copy; large ones (hundreds of MB) take the
  // chunked diff so the per-dispatch cost is the memcmp scan, not the copy. Tests that never call getState()
  // (dispatch-heavy stress loops) have nothing materialized and pay nothing. The refreshed shadow re-enters
  // `touched`: the test may write through its cached pointer before the next dispatch, and that write must
  // flush (the flush diff-scan of an unwritten shadow only costs the scan).
  const EAGER_SYNC_MAX = 4 << 20; // 4 MiB
  const markEngineMoved = () => {
    for (const [i, m] of materialized) {
      const c = handles[i];
      if (!c) continue;
      if (m.len <= EAGER_SYNC_MAX) {
        write(m.dst, c.stateView(m.len));
      } else {
        refreshShadow(m, c);
      }
      touched.add(i);
    }
    engineDirty.clear();
  };

  // Diff-copy between the runner shadow and the engine state (either direction): scan in chunks (native
  // memcmp via Buffer.compare when available) and copy only the chunks that actually changed. A dispatch or
  // a test-side write typically touches a few KB of a hundreds-of-MB state, so this collapses the copy to
  // the scan cost. Without Buffer (browser), fall back to the full copy. Both sides are live wasm-memory
  // views, so writing into dst lands directly in the target module.
  const SYNC_CHUNK = 1 << 20;
  const Buf = (globalThis as any).Buffer;
  const syncChunked = (src: Uint8Array, dst: Uint8Array) => {
    const len = Math.min(src.length, dst.length);
    const t0 = prof ? now() : 0;
    if (!Buf?.compare) {
      dst.set(src.subarray(0, len));
    } else {
      for (let off = 0; off < len; off += SYNC_CHUNK) {
        const n = Math.min(SYNC_CHUNK, len - off);
        const a = Buf.from(src.buffer, src.byteOffset + off, n);
        const b = Buf.from(dst.buffer, dst.byteOffset + off, n);
        if (Buf.compare(a, b) !== 0) dst.set(src.subarray(off, off + n), off);
      }
    }
    if (prof) { stat.pulls++; stat.pullBytes += len; stat.pullMs += now() - t0; }
  };
  const refreshShadow = (m: { dst: number; len: number }, c: Contract) => {
    syncChunked(c.stateView(m.len), mem().subarray(m.dst, m.dst + m.len));
  };

  const thost = {
    q_reset: () => { deployAll(); },
    q_init: (_idx: number) => { /* contracts pre-deployed in deployAll */ },

    q_invoke: (idx: number, it: number, inPtr: number, inLen: number, amount: bigint, originPtr: number, outPtr: number, outCap: number): number => {
      flushState();
      const input = read(inPtr, inLen);
      const origin = id32(originPtr);
      if (amount > 0n) sim.debit(origin, BigInt(amount));
      const out = traceDisp(`invoke[${idx >>> 0}:${it >>> 0}]`, () => sim.procedure(idx >>> 0, it >>> 0, input, { reward: BigInt(amount), invocator: origin, originator: origin }));
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      markEngineMoved();
      return n >>> 0;
    },

    q_query: (idx: number, it: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
      flushState();
      const out = traceDisp(`query[${idx >>> 0}:${it >>> 0}]`, () => sim.query(idx >>> 0, it >>> 0, read(inPtr, inLen)));
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },

    q_sysproc: (idx: number, sp: number) => {
      flushState();
      const c = handles[idx >>> 0];
      if (c && c.hasSysproc(sp >>> 0)) traceDisp(`sysproc[${idx >>> 0}:${sp >>> 0}]`, () => c.invoke(KIND.SYSPROC, sp >>> 0, new Uint8Array(0), { entryPoint: sp >>> 0 }));
      markEngineMoved();
      if (env_.QINIT_GTEST_DUMP_ASSETS) {
        (globalThis as any).process.stderr.write(`[assets after sysproc ${sp >>> 0}] ${JSON.stringify(sim.assetUniverse())}\n`);
      }
    },

    q_fund: (idPtr: number, amount: bigint) => { sim.fund(id32(idPtr), BigInt(amount)); },
    q_balance: (idPtr: number): bigint => { const b = sim.balance(id32(idPtr)); return typeof b === "bigint" ? b : 0n; },
    // notifyContractOfIncomingTransfer(source, dest, amount, type): credit dest + fire its POST_INCOMING_TRANSFER.
    q_notify_pit: (srcPtr: number, dstPtr: number, amount: bigint, type: number) => { sim.notifyIncomingTransfer(id32(srcPtr), id32(dstPtr), BigInt(amount), type >>> 0); },
    // issueAsset(issuer, name, decimals, unit, shares, mgmt): mint an asset (issuer == invocator path). Returns shares.
    q_issue_asset: (issuerPtr: number, name: bigint, decimals: number, shares: bigint, unit: bigint, slot: number): bigint => {
      const issuer = id32(issuerPtr);
      return (sim as any).assets.issueAsset(slot >>> 0, BigInt.asUintN(64, name), issuer, decimals, BigInt.asUintN(64, shares), BigInt.asUintN(64, unit), issuer) as bigint;
    },
    // issueContractShares(googletest): mint a contract's NULL_ID-issuer shares (qxSlot = QX), then move each
    // owner's slice from the NULL_ID holder to the owner. transferShareOwnershipAndPossession returns <0 on
    // failure (insufficient / not found); the shim asserts on that.
    q_mint_contract_shares: (name: bigint, shares: bigint, qxSlot: number): void => {
      (sim as any).assets.mintContractShares(qxSlot >>> 0, BigInt.asUintN(64, name), BigInt.asUintN(64, shares));
    },
    q_transfer_shares: (name: bigint, srcPtr: number, dstPtr: number, shares: bigint, qxSlot: number): bigint => {
      const src = id32(srcPtr);
      const zero = new Uint8Array(32);
      return (sim as any).assets.transferShareOwnershipAndPossession(qxSlot >>> 0, BigInt.asUintN(64, name), zero, src, src, BigInt.asUintN(64, shares), id32(dstPtr)) as bigint;
    },
    // transferShareOwnershipAndPossession free helper (index-based): move `shares` of asset (issuer, name) from the
    // owner/possessor holding to newOwner, managed by mgmt. Returns the source's remaining shares (<0 on failure).
    q_transfer_holding: (name: bigint, issuerPtr: number, ownerPtr: number, newOwnerPtr: number, shares: bigint, mgmt: number): bigint => {
      const issuer = id32(issuerPtr);
      const owner = id32(ownerPtr);
      return (sim as any).assets.transferShareOwnershipAndPossession(mgmt >>> 0, BigInt.asUintN(64, name), issuer, owner, owner, BigInt.asUintN(64, shares), id32(newOwnerPtr)) as bigint;
    },

    q_spectrum: (idPtr: number): number => {
      const h = hex(id32(idPtr));
      let i = spectrumIds.indexOf(h);
      if (i < 0) {
        i = spectrumIds.length;
        spectrumIds.push(h);
        spectrumBytes.push(id32(idPtr));
      }
      return i;
    },

    q_decrease: (idx: number, amount: bigint) => {
      const b = spectrumBytes[idx >>> 0];
      if (b) sim.debit(b, BigInt(amount));
    },

    q_shares: (issuerPtr: number, _assetName: bigint): bigint => {
      const issuerHex = hex(id32(issuerPtr));
      let sum = 0n;
      for (const a of sim.assetUniverse()) {
        if (a.issuer === issuerHex) {
          for (const h of a.holdings) sum += BigInt(h.shares);
        }
      }
      return sum;
    },

    q_possessed: (name: bigint, issuerPtr: number, ownerPtr: number, possessorPtr: number, om: number, pm: number): bigint => {
      const r = (sim as any).assets.numberOfPossessedShares(BigInt(name), id32(issuerPtr), id32(ownerPtr), id32(possessorPtr), om >>> 0, pm >>> 0) as bigint;
      if (env_.QINIT_GTEST_DUMP_ASSETS) {
        (globalThis as any).process.stderr.write(`[q_possessed] name=${name} issuerPtr=${issuerPtr >>> 0} issuer=${hex(id32(issuerPtr))} ownerPtr=${ownerPtr >>> 0} owner=${hex(id32(ownerPtr))} om=${om >>> 0} pm=${pm >>> 0} -> ${r}\n`);
      }
      return r;
    },

    q_state_size: (i: number): number => (handles[i]?.stateSize ?? 0) >>> 0,

    // Shared-memory mode: the contract's state lives in the runner's own memory — hand back its absolute
    // address so contractStates[i] is the live state (no shadow, no sync). 0 => shadow-buffer fallback.
    q_state_addr: (i: number): number => {
      const c = handles[i];
      return c && c.sharedMem ? c.stateAddr >>> 0 : 0;
    },

    q_state_in: (i: number, dst: number, len: number) => {
      const c = handles[i];
      if (!c) return;
      // Copy engine->shadow only on the first pull, after the engine advanced, or if the runner handed a new
      // buffer; otherwise the shadow at dst is already current and the (large) copy is skipped. Mark touched
      // so a later dispatch flushes any test-side write back to the engine.
      const prev = materialized.get(i);
      if (!prev || prev.dst !== dst) {
        const t0 = prof ? now() : 0;
        write(dst, c.stateView(len >>> 0));
        if (prof) { stat.pulls++; stat.pullBytes += len >>> 0; stat.pullMs += now() - t0; }
        engineDirty.delete(i);
      } else if (engineDirty.has(i)) {
        refreshShadow({ dst, len: len >>> 0 }, c);
        engineDirty.delete(i);
      }
      materialized.set(i, { dst, len: len >>> 0 });
      touched.add(i);
    },

    // Assertion-time refresh (see the shim's qbSyncThen): re-sync every engine-dirty shadow so a cached
    // getState() pointer reads live values, paying the diff scan only when a dispatch actually intervened.
    // A refreshed shadow re-enters `touched`: the test may write through its cached pointer right after the
    // assertion, and those writes must flush before the next dispatch (the flush is a diff-scan, so an
    // unwritten shadow costs only the scan).
    q_state_sync: () => {
      for (const i of engineDirty) {
        const m = materialized.get(i);
        const c = handles[i];
        if (m && c) {
          refreshShadow(m, c);
          touched.add(i);
        }
      }
      engineDirty.clear();
    },

    q_set_epoch: (e: number) => { sim.epochN = e >>> 0; },
    q_get_epoch: (): number => sim.epochN >>> 0,
    q_set_tick: (t: number) => { sim.tickN = t >>> 0; },
    q_get_tick: (): number => sim.tickN >>> 0,
    q_set_prev_spectrum_digest: (ptr: number) => { sim.prevSpectrumDigestOverride = read(ptr, 32); },
    // updateQpiTime() in the corpus harness pushes its utcTime fields here; set the chain clock so the qpi
    // date accessors (year/month/day/...) return them. timeBaseMs is chosen so nowMs() == the requested UTC.
    q_set_datetime: (y: number, mo: number, d: number, h: number, mi: number, s: number) => {
      const ms = Date.UTC(y >>> 0, (mo >>> 0) - 1, d >>> 0, h >>> 0, mi >>> 0, s >>> 0);
      sim.timeBaseMs = ms - sim.tickN * sim.tickDuration;
    },

    // The proposal-voting corpora seed their committee by writing broadcastedComputors.computors.publicKeys[i];
    // the harness header routes each write here so qpi.computor(i) in the engine returns the same identity.
    q_set_computor: (i: number, idPtr: number) => { sim.setComputorKey(i >>> 0, id32(idPtr)); },

    t_report: (namePtr: number, nameLen: number, passed: number, msgPtr: number, msgLen: number) => {
      results.push({
        name: dec.decode(read(namePtr, nameLen)),
        passed: (passed >>> 0) !== 0,
        message: dec.decode(read(msgPtr, msgLen)),
      });
    },
  };

  let rng = 0x9e3779b97f4a7c15n;
  const env = {
    _rdrand64_step: (outPtr: number): number => {
      rng = (rng * 6364136223846793005n + 1442695040888963407n) & 0xffffffffffffffffn;
      new DataView(mem().buffer).setBigUint64(outPtr >>> 0, rng, true);
      return 1;
    },
  };

  // Bun 1.3.14 has a Proxy + wasm i64-marshalling bug ("Invalid argument type in ToBigInt") when a Proxy
  // serves as the import object for a module with i64-param imports (WASI clock_time_get, lhost helpers).
  // Build the import objects WITHOUT proxies: compile first, then populate explicit stubs for every import
  // the module declares — no Proxy fallback needed.
  const mod = await WebAssembly.compile(runnerWasm);
  const noopVal = (..._args: unknown[]): number => 0;
  const noopBig = (..._args: unknown[]): bigint => 0n;

  // Runner-side scratchpad (shared-memory mode): the corpus may run qpi container maintenance directly on the
  // live shared state (e.g. QTRY's discountedFeeForUsers.cleanup()), whose __ScopedScratchpad acquires through
  // lhost. Serve it from a bump region above everything already placed in the runner's memory (runner data,
  // deployed shared contracts), growing on demand; releases nest LIFO (RAII), so release pops the bump.
  // In non-shared mode this stays inert (the acquire returns the noop stub's 0 as before).
  let scratchBase = 0, scratchBump = 0;
  const scratchAcquire = (size: bigint, initZero: number): number => {
    const m = runnerMemory()!;
    if (!scratchBase) scratchBase = scratchBump = m.buffer.byteLength;
    const n = Number((BigInt(size) + 7n) & ~7n);
    if (scratchBump + n > m.buffer.byteLength) m.grow(Math.ceil((scratchBump + n - m.buffer.byteLength) / 65536));
    const off = scratchBump;
    scratchBump += n;
    if (initZero) mem().fill(0, off, off + n);
    return off >>> 0;
  };

  // lhost: read-only surface backed by the live Sim (for in-runner qpi contexts like QDUEL's computeWinner),
  // with explicit safeNoop stubs for state-mutating imports the runner never legitimately calls.
  const lhost: Record<string, Function> = {
    k12: (inOff: number, len: number, outOff: number) => mem().set(k12Bytes(read(inOff, len)), outOff >>> 0),
    epoch: () => sim.epochN & 0xffff,
    tick: () => sim.tickN >>> 0,
    day: () => dateFields(sim.nowMs()).day,
    year: () => dateFields(sim.nowMs()).year,
    hour: () => dateFields(sim.nowMs()).hour,
    minute: () => dateFields(sim.nowMs()).minute,
    month: () => dateFields(sim.nowMs()).month,
    second: () => dateFields(sim.nowMs()).second,
    millisecond: () => dateFields(sim.nowMs()).milli,
    now: (out: number) => new DataView(mem().buffer).setBigUint64(out >>> 0, packDateAndTime(sim.nowMs()), true),
    prevSpectrumDigest: (out: number) => mem().set((sim.prevSpectrumDigestOverride ?? new Uint8Array(32)).subarray(0, 32), out >>> 0),
  };
  if (sharedSlots.size) {
    lhost.acquireScratch = scratchAcquire;
    lhost.releaseScratch = (off: number) => {
      const p = off >>> 0;
      if (p >= scratchBase && p <= scratchBump) scratchBump = p;
    };
  }

  // env: PRNG (global in the runner) + contract-specific symbols.
  const envObj: Record<string, Function> = { ...env };

  // wasi: fd_write with correct byte-count reporting (avoids ostream hang), clock_time_get for QTRY/Nostromo.
  const wasiObj: Record<string, Function> = {
    fd_write: (_fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
      const dv = new DataView(mem().buffer);
      let total = 0;
      for (let k = 0; k < (iovsLen >>> 0); k++) total += dv.getUint32((iovs >>> 0) + k * 8 + 4, true);
      dv.setUint32(nwritten >>> 0, total >>> 0, true);
      return 0;
    },
    // Real wall-clock: the native harness seeds etalonTick from std::chrono::system_clock::now() (QTRY's
    // updateEtalonTime); a zero stub would put the corpus clock at 1970 while the oracle runs at today.
    clock_time_get: (_id: number, _precision: bigint, timePtr: number): number => {
      new DataView(mem().buffer).setBigUint64(timePtr >>> 0, BigInt(Date.now()) * 1_000_000n, true);
      return 0;
    },
  };

  // Fill in explicit safeNoop stubs for every import the module declares that we haven't wired yet, so no
  // Proxy is needed in the import object that Bun sees.
  for (const imp of WebAssembly.Module.imports(mod)) {
    const entry = imp.module === "lhost" ? lhost
      : imp.module === "env" ? envObj
      : imp.module === "wasi_snapshot_preview1" ? wasiObj
      : null;
    if (entry && !(imp.name in entry)) {
      const results: string[] = ((imp as any).type?.results ?? []) as string[];
      (entry as any)[imp.name] = results.includes("i64") ? noopBig : noopVal;
    }
  }

  const imports: Record<string, Record<string, Function>> = { thost };
  if (Object.keys(lhost).length) imports.lhost = lhost;
  if (Object.keys(envObj).length) imports.env = envObj;
  imports.wasi_snapshot_preview1 = wasiObj;

  runner = await WebAssembly.instantiate(mod, imports as any);
  // Deploy between instantiation and _initialize: shared-memory contracts need the runner's Memory (live from
  // instantiate), while _initialize may already drive thost (a corpus registering a gtest Environment whose
  // SetUp builds a fixture) and so needs the contracts deployed.
  deployAll();
  (runner.exports._initialize as Function)?.();

  const count = (runner.exports.test_count as Function)() >>> 0;

  // Opt-in trace (QINIT_GTEST_TRACE): name each test on stderr before it runs. A corpus test can loop
  // forever inside the wasm (a tick/time/epoch precondition the harness doesn't satisfy), which blocks
  // this synchronous loop; the last name printed identifies the offending test for a killed subprocess.
  const trace = !!(globalThis as any).process?.env?.QINIT_GTEST_TRACE;
  // QINIT_GTEST_FILTER: comma-separated substrings — run only tests whose name contains one (skip the rest).
  // Iterating on a known-failing subset avoids paying for the already-green bulk of a heavy corpus.
  const filterRaw = ((globalThis as any).process?.env?.QINIT_GTEST_FILTER ?? "") as string;
  const filters = filterRaw.split(",").map((s) => s.trim()).filter(Boolean);
  // Name lookups write into the runner's io scratch; resolve a real io_base whenever we'll print names
  // (trace or prof) or match the filter. Writing to a bogus base (0) would corrupt the runner's memory.
  const ioBase = (trace || prof || filters.length) ? (((runner.exports.io_base as Function)?.() ?? 0) >>> 0) : 0;
  const traceName = (i: number): string => {
    if (!ioBase) return `#${i}`;
    const cap = 256;
    const n = (runner.exports.test_name as Function)(i, ioBase, cap) >>> 0;
    return dec.decode(read(ioBase, Math.min(n, cap)));
  };

  const t0run = now();
  for (let i = 0; i < count; i++) {
    if (filters.length) {
      const nm = traceName(i);
      if (!filters.some((f) => nm.includes(f))) continue;
    }
    if (trace) (globalThis as any).process.stderr.write(`[gtest] #${i} ${traceName(i)}\n`);
    const tt = prof ? now() : 0;
    (runner.exports.run_test as Function)(i);
    if (prof) (globalThis as any).process.stderr.write(`[gtest] #${i} ${traceName(i)} wall=${Math.round(now() - tt)}ms\n`);
  }
  if (prof) {
    const wall = Math.round(now() - t0run);
    const pullMB = Math.round(stat.pullBytes / (1 << 20));
    (globalThis as any).process.stderr.write(
      `[gtest-prof] wall=${wall}ms dispatches=${stat.dispN} dispatchMs=${Math.round(stat.dispMs)} ` +
        `pulls=${stat.pulls} pulledMB=${pullMB} pullMs=${Math.round(stat.pullMs)} ` +
        `other=${Math.round(wall - stat.dispMs - stat.pullMs)}ms\n`,
    );
  }
  return results;
}

// Shared driver: iterate the runner's tests, reset between each, attribute traps to the right name.
function driveTests(
  runner: Contract,
  sim: Sim,
  reinit: () => void,
  results: TestResult[],
  read: (off: number, len: number) => Uint8Array,
  view: () => Uint8Array,
): TestResult[] {
  const dec = new TextDecoder();
  const nameOf = (i: number): string => {
    const cap = 256;
    const n = (runner.ex.test_name(i >>> 0, runner.ioBase >>> 0, cap) as number) >>> 0;
    return dec.decode(read(runner.ioBase, Math.min(n, cap))) || `#${i}`;
  };

  const count = (runner.ex.test_count() as number) >>> 0;
  for (let i = 0; i < count; i++) {
    const name = nameOf(i);
    try { sim.resetLedger(); reinit(); } catch { /* a trapping INITIALIZE shouldn't abort the run */ }

    const before = results.length;
    let trap: string | null = null;
    try {
      runner.ex.run_test(i >>> 0);
    } catch (e) {
      trap = e instanceof Error ? e.message : String(e);
    }
    if (results.length === before) {
      results.push({ name, passed: false, message: trap ?? "trapped before reporting a result" });
    }
  }
  return results;
}

