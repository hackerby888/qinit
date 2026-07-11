import { Sim } from "./sim";
import { KIND, SP, type Contract } from "./runtime";
import type { TestResult } from "./gtest";

export interface CompiledGtestProgram {
  version: 2;
  contract: string;
  mainSlot: number;
  runnerSlot: number;
  mainConstructionEpoch?: number;
  tests: Array<{ name: string; inputType: number }>;
}

function accountId(name: string): Uint8Array {
  const id = new Uint8Array(32);
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  for (let i = 0; i < id.length; i++) {
    hash ^= i + 1;
    hash = Math.imul(hash, 16777619);
    id[i] = hash >>> 24;
  }
  return id;
}

const ASSERTION_NAMES = ["EXPECT_EQ", "EXPECT_NE", "EXPECT_LT", "EXPECT_LE", "EXPECT_GT", "EXPECT_GE", "EXPECT_TRUE", "EXPECT_FALSE"];

export async function runCompiledGtest(
  program: CompiledGtestProgram,
  runnerWasm: Uint8Array,
  contracts: Record<number, Uint8Array>,
  onResult?: (result: TestResult) => void | Promise<void>,
): Promise<TestResult[]> {
  if (program.version !== 2) throw new Error(`unsupported compiled gtest version ${String((program as { version?: unknown }).version)}`);
  const results: TestResult[] = [];

  for (const test of program.tests) {
    const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
    sim.epochN = (program.mainConstructionEpoch ?? 0) & 0xffff;
    const handles: Record<number, Contract> = {};
    const messages: string[] = [];
    let runner!: Contract;
    const initialized = new Set<number>();

    for (const [slot, wasm] of Object.entries(contracts)) {
      handles[Number(slot)] = sim.deploy(Number(slot), wasm);
      initialized.add(Number(slot));
    }

    const memory = () => new Uint8Array(runner.mem.buffer);
    const read = (offset: number, length: number) => memory().slice(offset >>> 0, (offset >>> 0) + (length >>> 0));
    const write = (offset: number, bytes: Uint8Array, capacity = bytes.length) => memory().set(bytes.subarray(0, capacity >>> 0), offset >>> 0);

    const qtest = {
      invoke: (slot: number, inputType: number, inputPtr: number, inputSize: number, outputPtr: number, amount: bigint, originPtr: number): number => {
        const origin = read(originPtr, 32);
        const reward = BigInt(amount);
        if (reward > 0n) sim.debit(origin, reward);
        const output = sim.procedure(slot >>> 0, inputType >>> 0, read(inputPtr, inputSize), {
          originator: origin,
          invocator: origin,
          reward,
        });
        write(outputPtr, output);
        return output.length >>> 0;
      },
      query: (slot: number, inputType: number, inputPtr: number, inputSize: number, outputPtr: number, outputSize: number): number => {
        const output = sim.query(slot >>> 0, inputType >>> 0, read(inputPtr, inputSize));
        write(outputPtr, output, outputSize);
        return output.length >>> 0;
      },
      fund: (idPtr: number, amount: bigint): void => sim.fund(read(idPtr, 32), BigInt(amount)),
      balance: (idPtr: number): bigint => sim.balance(read(idPtr, 32)),
      state: (slot: number, outputPtr: number, outputSize: number): number => {
        const contract = handles[slot >>> 0];
        if (!contract) return 0;
        const state = contract.state();
        write(outputPtr, state, outputSize);
        return Math.min(state.length, outputSize >>> 0) >>> 0;
      },
      system: (slot: number, procedure: number): number => {
        const contract = handles[slot >>> 0];
        if (!contract) return 0;
        // Sim.deploy already performed the fixture's first INITIALIZE.
        if ((procedure >>> 0) === SP.INITIALIZE && initialized.delete(slot >>> 0)) return 1;
        contract.invoke(KIND.SYSPROC, procedure >>> 0, new Uint8Array(0), { entryPoint: procedure >>> 0 });
        return 1;
      },
      setEpoch: (epoch: number): void => { sim.epochN = epoch & 0xffff; },
      setTick: (tick: number): void => { sim.tickN = tick >>> 0; },
      constructionEpoch: (slot: number): number => slot >>> 0 === program.mainSlot
        ? (program.mainConstructionEpoch ?? 0) & 0xffff
        : 0,
      fail: (code: number, fatal: number): void => {
        const assertion = ASSERTION_NAMES[code >>> 0] ?? "EXPECT";
        messages.push(`${assertion} failed${fatal ? " (fatal)" : ""}`);
      },
    };

    try {
      runner = sim.deployWithImports(program.runnerSlot, runnerWasm, { qtest } as unknown as WebAssembly.Imports);
      sim.procedure(program.runnerSlot, test.inputType, new Uint8Array(0), {
        originator: accountId("gtest-runner"),
        invocator: accountId("gtest-runner"),
        reward: 0n,
      });
    } catch (error) {
      messages.push(error instanceof Error ? error.message : String(error));
    }

    const result = { name: test.name, passed: messages.length === 0, message: messages.join("\n") };
    results.push(result);
    await onResult?.(result);
  }
  return results;
}
