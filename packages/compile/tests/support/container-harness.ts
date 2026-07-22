import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { Sim } from "@qinit/engine";
import { compileContract } from "../../src/index";

export const CONTAINER_SLOT = 27;
export const CONTAINER_ARENA_SIZE = 4 * 1024 * 1024;

export interface ContainerOperation {
  operator: bigint;
  a?: bigint;
  b?: bigint;
  c?: bigint;
  d?: bigint;
  e?: bigint;
}

export interface ContainerFixture {
  family: string;
  name: string;
  source: string;
  boundary: ContainerOperation[];
}

export interface ExecutionResult {
  operations: OperationResult[];
  outputs: Uint8Array[];
  state: Uint8Array;
}

export interface OperationResult {
  status: "ok" | "trap" | "rejected";
  output?: Uint8Array;
}

export function encodeContainerOperation(operation: ContainerOperation): Uint8Array {
  const values = [
    operation.operator,
    operation.a ?? 0n,
    operation.b ?? 0n,
    operation.c ?? 0n,
    operation.d ?? 0n,
    operation.e ?? 0n,
  ];
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setBigUint64(index * 8, BigInt.asUintN(64, value), true);
  });
  return bytes;
}

export function decodeWords(bytes: Uint8Array): bigint[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return Array.from({ length: Math.floor(bytes.byteLength / 8) }, (_, index) =>
    view.getBigUint64(index * 8, true),
  );
}

export function executeContainerScript(
  wasm: Uint8Array,
  operations: readonly ContainerOperation[],
): ExecutionResult {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  const user = new Uint8Array(32).fill(7);
  sim.fund(user, 1_000_000n);
  const contract = sim.deploy(CONTAINER_SLOT, wasm);
  const results: OperationResult[] = [];
  for (const operation of operations) {
    try {
      results.push({
        status: "ok",
        output: sim
          .procedure(CONTAINER_SLOT, 1, encodeContainerOperation(operation), { invocator: user })
          .slice(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ status: /reject|invalid|not found/i.test(message) ? "rejected" : "trap" });
      break;
    }
  }
  return {
    operations: results,
    outputs: results.flatMap((result) => (result.output ? [result.output] : [])),
    state: contract.state().slice(),
  };
}

export async function compileTsFixture(
  fixture: ContainerFixture,
  qpiHeader: string,
): Promise<Uint8Array> {
  const result = await compileContract({
    source: fixture.source,
    name: fixture.name,
    slot: CONTAINER_SLOT,
    qpiHeader,
    arenaSz: CONTAINER_ARENA_SIZE,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length || !result.wasm.byteLength) {
    throw new Error(
      `${fixture.family} TS compile failed: ${errors.map((error) => error.message).join(" | ") || "empty artifact"}`,
    );
  }
  return result.wasm;
}

export async function compileNativeFixture(
  fixture: ContainerFixture,
  corePath: string,
): Promise<{ wasm: Uint8Array; dispose: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), `qinit-container-${fixture.family.toLowerCase()}-`));
  const contractPath = join(dir, `${fixture.name}.h`);
  writeFileSync(contractPath, fixture.source);
  const result = await buildContract({
    contractPath,
    name: fixture.name,
    slot: CONTAINER_SLOT,
    corePath,
    outDir: dir,
    arenaSz: CONTAINER_ARENA_SIZE,
    skipVerify: true,
  });
  if (!result.ok || !result.so) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(
      `${fixture.family} native WASI compile failed: ${result.stderr ?? "no artifact"}`,
    );
  }
  return {
    wasm: new Uint8Array(readFileSync(result.so)),
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function compareExecutions(left: ExecutionResult, right: ExecutionResult): string | null {
  if (left.operations.length !== right.operations.length) {
    return `operation count ${left.operations.length} != ${right.operations.length}`;
  }
  for (let index = 0; index < left.operations.length; index++) {
    const leftOperation = left.operations[index];
    const rightOperation = right.operations[index];
    if (leftOperation.status !== rightOperation.status) {
      return `operation ${index} status differs: ${leftOperation.status} != ${rightOperation.status}`;
    }
    if (
      leftOperation.status === "ok" &&
      !Buffer.from(leftOperation.output!).equals(Buffer.from(rightOperation.output!))
    ) {
      const leftHex = Buffer.from(leftOperation.output!).toString("hex");
      const rightHex = Buffer.from(rightOperation.output!).toString("hex");
      return `operation ${index} output differs: ${leftHex} != ${rightHex}`;
    }
  }
  if (!Buffer.from(left.state).equals(Buffer.from(right.state))) {
    const firstDifference = left.state.findIndex(
      (value, index) => value !== right.state[index],
    );
    return `final state differs at byte ${firstDifference}: ${left.state[firstDifference]} != ${right.state[firstDifference]}`;
  }
  return null;
}

export function wamrScript(operations: readonly ContainerOperation[]): string {
  return operations
    .map((operation) => `1:${Buffer.from(encodeContainerOperation(operation)).toString("hex")}`)
    .join(";");
}

export function executeWamr(
  gtestPath: string,
  wasm: Uint8Array,
  operations: readonly ContainerOperation[],
  expectedSlot = CONTAINER_SLOT,
): ExecutionResult {
  const dir = mkdtempSync(join(tmpdir(), "qinit-container-wamr-"));
  const artifact = join(dir, "fixture.wasm");
  try {
    writeFileSync(artifact, wasm);
    const child = Bun.spawnSync(
      [gtestPath, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"],
      {
        cwd: dir,
        env: {
          ...globalThis.process.env,
          QINIT_WASM: artifact,
          QINIT_SCRIPT: wamrScript(operations),
          QINIT_EXPECTED_SLOT: String(expectedSlot),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = child.stdout.toString();
    const stderr = child.stderr.toString();
    if (child.exitCode !== 0) {
      throw new Error(`WAMR gtest exited ${child.exitCode}:\n${stdout}\n${stderr}`);
    }
    const stateMatch = stdout.match(/CROSSHOST_STATE=([0-9a-f]+)/);
    if (!stateMatch) {
      throw new Error(`WAMR gtest emitted no state:\n${stdout}\n${stderr}`);
    }
    const operationResults: OperationResult[] = [];
    for (const match of stdout.matchAll(
      /CROSSHOST_OP=(\d+):(ok|trap|rejected)(?::([0-9a-f]*))?/g,
    )) {
      const index = Number(match[1]);
      if (index !== operationResults.length) {
        throw new Error(`WAMR gtest emitted out-of-order operation ${index}`);
      }
      operationResults.push({
        status: match[2] as OperationResult["status"],
        ...(match[2] === "ok"
          ? { output: new Uint8Array(Buffer.from(match[3] ?? "", "hex")) }
          : {}),
      });
    }
    if (operationResults.length !== operations.length && operationResults.at(-1)?.status === "ok") {
      throw new Error(
        `WAMR gtest emitted ${operationResults.length}/${operations.length} operation results:\n${stdout}`,
      );
    }
    return {
      operations: operationResults,
      outputs: operationResults.flatMap((result) => (result.output ? [result.output] : [])),
      state: new Uint8Array(Buffer.from(stateMatch[1], "hex")),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function seededOperations(
  family: string,
  seed: number,
  count: number,
): ContainerOperation[] {
  let state = (seed ^ 0x9e3779b9) >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const opcodeCounts: Record<string, number> = {
    Array: 8,
    BitArray: 8,
    HashMap: 13,
    HashSet: 12,
    Collection: 13,
    LinkedList: 10,
  };
  const opcodeCount = opcodeCounts[family];
  if (!opcodeCount) {
    throw new Error(`unknown container family ${family}`);
  }
  return Array.from({ length: count }, () => {
    const operation: ContainerOperation = {
      operator: BigInt(next() % opcodeCount),
      a: BigInt(next()),
      b: BigInt(next()),
      c: BigInt(next()),
      d: BigInt(next()),
      e: BigInt(next()),
    };
    const opcode = Number(operation.operator);
    // Random scripts stay inside each method's documented preconditions. Dedicated boundary scripts
    // carry the invalid-index/range cases, so stress runs do not turn native undefined behavior into
    // a false compiler differential or accidentally create billion-iteration Array::setRange calls.
    if (family === "Array" && (opcode === 2 || opcode === 3)) {
      operation.a = operation.a! % 10n;
      operation.b = operation.b! % 10n;
    } else if (family === "HashMap" && opcode === 6) {
      operation.a = BigInt.asUintN(64, (operation.a! % 18n) - 1n);
    } else if (family === "HashSet" && opcode === 4) {
      operation.a = BigInt.asUintN(64, (operation.a! % 18n) - 1n);
    } else if (family === "Collection" && (opcode === 1 || opcode === 2)) {
      operation.a = operation.a! % 19n;
    } else if (family === "Collection" && (opcode === 4 || opcode === 5)) {
      operation.a = operation.a! % 16n;
    } else if (family === "Collection" && opcode === 12) {
      operation.a = operation.a! % 49n;
    } else if (family === "LinkedList" && opcode >= 2 && opcode <= 5) {
      operation.a = operation.a! % 11n;
    }
    return operation;
  });
}
