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

  // Read a test's name into the io region (scratch, free between tests) — decoded to a JS string before reinit
  // reuses that region, so a trap mid-test still attributes the failure to the right name.
  const nameOf = (i: number): string => {
    const cap = 256;
    const n = (c.ex.test_name(i >>> 0, c.ioBase >>> 0, cap) as number) >>> 0;
    return dec.decode(read(c.ioBase, Math.min(n, cap))) || `#${i}`;
  };

  const count = (c.ex.test_count() as number) >>> 0;
  for (let i = 0; i < count; i++) {
    const name = nameOf(i);

    // Backstop a clean baseline before each test, so a test that forgets to construct a fixture still starts
    // isolated (matching core's per-test freshness without relying on the test author).
    try {
      sim.resetLedger();
      reinit();
    } catch {
      // a trapping INITIALIZE shouldn't abort the whole run — the test's own ContractTest ctor retries.
    }

    // A contract trap inside the test propagates out of run_test as a thrown wasm trap; catch it so one bad
    // test fails in isolation instead of aborting every later test. t_report fires last in run_test, so if no
    // result was pushed, the test trapped before reporting.
    const before = results.length;
    let trap: string | null = null;
    try {
      c.ex.run_test(i >>> 0);
    } catch (e) {
      trap = e instanceof Error ? e.message : String(e);
    }
    if (results.length === before) {
      results.push({ name, passed: false, message: trap ?? "trapped before reporting a result" });
    }
  }
  return results;
}
