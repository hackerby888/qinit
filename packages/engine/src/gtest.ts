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

