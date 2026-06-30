// Run a contract's gtest-style tests that were compiled INTO its wasm (core-lite extensions/lite_test.h).
// The module exports a runner (test_count / test_name / run_test) and imports a "thost" (test-host) table; we
// bind thost to a FRESH, isolated Virtual Node (Sim) so tests never touch the live session, then drive each
// test. The contract under test is the same module: its own qpi.* calls resolve through lhost, while the test
// body drives it through thost (which re-enters the instance via Sim — a single-instance, non-reentrancy-prone
// path because run_test is not mid-dispatch when it calls thost). Runs in Bun and the browser; no native build.
import { Sim } from "./sim";
import { Contract, KIND, SP } from "./runtime";
import { initK12, deriveKeysSync } from "./k12";

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
  const materialized = new Map<number, { dst: number; len: number }>();

  const mem = () => new Uint8Array((runner.exports.memory as WebAssembly.Memory).buffer);
  const read = (off: number, len: number) => mem().slice(off >>> 0, (off >>> 0) + (len >>> 0));
  const write = (off: number, b: Uint8Array) => mem().set(b, off >>> 0);
  const id32 = (p: number) => read(p, 32);
  const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

  const deployAll = () => {
    sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    handles = {};
    spectrumIds = [];
    spectrumBytes = [];
    materialized.clear();
    for (const [idx, wasm] of Object.entries(contracts)) {
      handles[Number(idx)] = sim.deploy(Number(idx), wasm);
    }
  };
  deployAll();

  const flushState = () => {
    for (const [i, m] of materialized) handles[i]?.writeState(read(m.dst, m.len));
  };

  const reReadState = () => {
    for (const [i, m] of materialized) {
      const c = handles[i];
      if (c) write(m.dst, c.state().subarray(0, m.len));
    }
  };

  const thost = {
    q_reset: () => { deployAll(); },
    q_init: (_idx: number) => { /* contracts pre-deployed in deployAll */ },

    q_invoke: (idx: number, it: number, inPtr: number, inLen: number, amount: bigint, originPtr: number, outPtr: number, outCap: number): number => {
      flushState();
      const input = read(inPtr, inLen);
      const origin = id32(originPtr);
      if (amount > 0n) sim.debit(origin, BigInt(amount));
      const out = sim.procedure(idx >>> 0, it >>> 0, input, { reward: BigInt(amount), invocator: origin, originator: origin });
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      reReadState();
      return n >>> 0;
    },

    q_query: (idx: number, it: number, inPtr: number, inLen: number, outPtr: number, outCap: number): number => {
      flushState();
      const out = sim.query(idx >>> 0, it >>> 0, read(inPtr, inLen));
      const n = Math.min(out.length, outCap >>> 0);
      if (n) write(outPtr, out.subarray(0, n));
      return n >>> 0;
    },

    q_sysproc: (idx: number, sp: number) => {
      flushState();
      const c = handles[idx >>> 0];
      if (c && c.hasSysproc(sp >>> 0)) c.invoke(KIND.SYSPROC, sp >>> 0, new Uint8Array(0), { entryPoint: sp >>> 0 });
      reReadState();
    },

    q_fund: (idPtr: number, amount: bigint) => { sim.fund(id32(idPtr), BigInt(amount)); },
    q_balance: (idPtr: number): bigint => sim.balance(id32(idPtr)),

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

    q_possessed: (name: bigint, issuerPtr: number, ownerPtr: number, possessorPtr: number, om: number, pm: number): bigint =>
      (sim as any).assets.numberOfPossessedShares(BigInt(name), id32(issuerPtr), id32(ownerPtr), id32(possessorPtr), om >>> 0, pm >>> 0),

    q_state_size: (i: number): number => (handles[i]?.stateSize ?? 0) >>> 0,

    q_state_in: (i: number, dst: number, len: number) => {
      const c = handles[i];
      if (!c) return;
      write(dst, c.state().subarray(0, len >>> 0));
      materialized.set(i, { dst, len: len >>> 0 });
    },

    q_set_epoch: (e: number) => { sim.epochN = e >>> 0; },
    q_get_epoch: (): number => sim.epochN >>> 0,

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

  const noopModule = new Proxy({}, { get: () => () => 0 });
  const envProxy = new Proxy(env, { get: (t, k: string) => (k in t ? (t as any)[k] : () => 0), has: () => true });
  const imports = new Proxy({ thost, env: envProxy } as Record<string, unknown>, {
    get: (t, m: string) => (m in t ? (t as any)[m] : noopModule),
    has: () => true,
  });

  const mod = await WebAssembly.compile(runnerWasm);
  runner = await WebAssembly.instantiate(mod, imports as any);
  (runner.exports._initialize as Function)?.();

  const count = (runner.exports.test_count as Function)() >>> 0;
  for (let i = 0; i < count; i++) {
    (runner.exports.run_test as Function)(i);
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

