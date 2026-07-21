// Compile the same driver/callee sources with Qinit and Clang, deploy every
// exact artifact through both node RPC paths, and compare complete state.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildContract } from "../packages/build/src/index";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { compileContract, inspectWasmModule, loadQpiHeader } from "../packages/compile/src/index";
import { initK12, k12Hex, LiteRpc } from "../packages/core/src/index";
import { VirtualNode } from "../packages/engine/src/index";
import { EngineServer } from "../packages/engine/src/server";
import { invokeProcedure } from "../packages/proto/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");

const ARENA_SIZE = 1024 * 1024 * 1024;
const USER_SEED = "a".repeat(55);
const driverPath = resolve("fixtures/QpiDual.h");
const calleePath = resolve("fixtures/QpiDualCallee.h");
const driverSource = readFileSync(driverPath, "utf8");
const calleeSource = readFileSync(calleePath, "utf8");
const scratch = mkdtempSync(join(tmpdir(), "qinit-qpi-matrix-"));
process.once("exit", () => rmSync(scratch, { recursive: true, force: true }));

type Compiler = "TS" | "Clang";
type Role = "driver" | "callee";
interface TsIdlShape {
  functions: Array<{ name: string; inputType: number; inSize: number; outSize: number }>;
  procedures: Array<{ name: string; inputType: number; inSize: number; outSize: number }>;
}
interface Registration {
  functions: number;
  procedures: number;
}
interface Artifact {
  compiler: Compiler;
  role: Role;
  slot: number;
  wasm: Uint8Array;
  hash: string;
  registration: Registration;
}
interface Result {
  driverStateSize: number;
  calleeStateSize: number;
  driverState: Uint8Array;
  calleeState: Uint8Array;
  driverOutput: Uint8Array;
  calleeOutput: Uint8Array;
  driverDigest: string;
  calleeDigest: string;
}

function fail(message: string): never {
  throw new Error(`QPI MATRIX FAIL: ${message}`);
}

function same(left: Uint8Array, right: Uint8Array, label: string): void {
  if (Buffer.from(left).equals(Buffer.from(right))) return;
  const first = left.findIndex((value, index) => value !== right[index]);
  fail(`${label} differs at byte ${first} (${left.byteLength}B vs ${right.byteLength}B)`);
}

function cmakeProof(): Record<string, string> {
  const cachePath = ["build-node", "build-win"]
    .map((directory) => resolve(core!, directory, "CMakeCache.txt"))
    .find(existsSync);
  if (!cachePath) fail("core build is missing CMakeCache.txt");
  const cache = readFileSync(cachePath, "utf8");
  const value = (key: string): string => {
    const match = cache.match(new RegExp(`^${key}:[^=]*=(.*)$`, "m"));
    if (!match) fail(`CMake cache is missing ${key}`);
    return match[1].trim();
  };
  const expected: Record<string, string> = {
    BUILD_BINARY: "ON",
    BUILD_TESTS: "OFF",
    ENABLE_AVX512: "OFF",
    USE_SANITIZER: "OFF",
    TESTNET: "ON",
    TESTNET_LITE_RAM: "ON",
    TESTNET_PREFILL_QUS: "ON",
    LITE_WASM_SC: "ON",
    CMAKE_NO_USE_SWAP: "ON",
    ADDON_TX_STATUS_REQUEST: "ON",
    ONLY_LOGGING: "OFF",
  };
  const proof: Record<string, string> = {};
  for (const [key, wanted] of Object.entries(expected)) {
    proof[key] = value(key);
    if (proof[key] !== wanted) fail(`CMake ${key}=${proof[key]}, expected ${wanted}`);
  }
  proof.CMAKE_CACHE = cachePath;
  proof.CMAKE_C_COMPILER = value("CMAKE_C_COMPILER");
  proof.CMAKE_CXX_COMPILER = value("CMAKE_CXX_COMPILER");
  return proof;
}

function verifyPinnedHeader(header: string): void {
  const manifest = JSON.parse(readFileSync(resolve("packages/compile/core-snapshot.json"), "utf8"));
  const hash = `sha256:${createHash("sha256").update(header).digest("hex")}`;
  if (hash !== manifest.snapshotHash) {
    fail(`core header hash ${hash} does not match pinned ${manifest.snapshotHash}`);
  }
}

function calleeMetadata(idl: TsIdlShape, index: number) {
  const entries = (items: TsIdlShape["functions"]) =>
    Object.fromEntries(
      items.map((item) => [
        item.name,
        { inputType: item.inputType, inSize: item.inSize, outSize: item.outSize },
      ]),
    );
  return {
    name: "QpiDualCallee",
    index,
    functions: entries(idl.functions),
    procedures: entries(idl.procedures),
  };
}

async function artifact(
  compiler: Compiler,
  role: Role,
  slot: number,
  wasm: Uint8Array,
  registration: Registration,
): Promise<Artifact> {
  const inspection = inspectWasmModule(wasm);
  if (!inspection.ok) fail(`${compiler} ${role}: ${inspection.diagnostics.map((item) => item.message).join("; ")}`);
  if (inspection.imports.some((item) => item.module !== "lhost")) {
    fail(`${compiler} ${role} has a non-lhost import`);
  }
  return { compiler, role, slot, wasm, registration, hash: await k12Hex(wasm) };
}

async function compileTsPair(calleeSlot: number, driverSlot: number, qpiHeader: string): Promise<Artifact[]> {
  const callee = await compileContract({
    source: calleeSource,
    name: "QpiDualCallee",
    slot: calleeSlot,
    qpiHeader,
    arenaSz: ARENA_SIZE,
  });
  const calleeErrors = callee.diagnostics.filter((item) => item.severity === "error");
  if (calleeErrors.length || !callee.wasm.length) {
    fail(`TS callee compile: ${calleeErrors.map((item) => item.message).join("; ") || "empty artifact"}`);
  }
  const driver = await compileContract({
    source: driverSource,
    name: "QpiDual",
    slot: driverSlot,
    qpiHeader,
    arenaSz: ARENA_SIZE,
    callees: [calleeMetadata(callee.idl, calleeSlot)],
    calleeSources: [{ name: "QpiDualCallee", source: calleeSource }],
  });
  const driverErrors = driver.diagnostics.filter((item) => item.severity === "error");
  if (driverErrors.length || !driver.wasm.length) {
    fail(`TS driver compile: ${driverErrors.map((item) => item.message).join("; ") || "empty artifact"}`);
  }
  return [
    await artifact("TS", "callee", calleeSlot, callee.wasm, {
      functions: callee.idl.functions.length,
      procedures: callee.idl.procedures.length,
    }),
    await artifact("TS", "driver", driverSlot, driver.wasm, {
      functions: driver.idl.functions.length,
      procedures: driver.idl.procedures.length,
    }),
  ];
}

async function compileClangPair(calleeSlot: number, driverSlot: number): Promise<Artifact[]> {
  const callee = await buildContract({
    contractPath: calleePath,
    name: "QpiDualCallee",
    slot: calleeSlot,
    corePath: core!,
    outDir: join(scratch, "clang-callee"),
    arenaSz: ARENA_SIZE,
    skipVerify: true,
  });
  if (!callee.ok || !callee.so || !callee.idl) fail(`Clang callee compile: ${callee.stderr ?? "no artifact"}`);
  const driver = await buildContract({
    contractPath: driverPath,
    name: "QpiDual",
    slot: driverSlot,
    corePath: core!,
    outDir: join(scratch, "clang-driver"),
    arenaSz: ARENA_SIZE,
    dynCallees: { QpiDualCallee: { header: calleePath, index: calleeSlot } },
    skipVerify: true,
  });
  if (!driver.ok || !driver.so || !driver.idl) fail(`Clang driver compile: ${driver.stderr ?? "no artifact"}`);
  return [
    await artifact("Clang", "callee", calleeSlot, new Uint8Array(readFileSync(callee.so)), {
      functions: Object.keys(callee.idl.functions).length,
      procedures: Object.keys(callee.idl.procedures).length,
    }),
    await artifact("Clang", "driver", driverSlot, new Uint8Array(readFileSync(driver.so)), {
      functions: Object.keys(driver.idl.functions).length,
      procedures: Object.keys(driver.idl.procedures).length,
    }),
  ];
}

async function deployAll(base: string, rpc: LiteRpc, artifacts: Artifact[]): Promise<void> {
  for (const item of artifacts) {
    const pairCallee = artifacts.find(
      (candidate) => candidate.compiler === item.compiler && candidate.role === "callee",
    )!;
    const deployed = await deployContract(
      {
        contractPath: item.role === "driver" ? driverPath : calleePath,
        name: `Qpi${item.compiler}${item.role === "driver" ? "Driver" : "Callee"}`,
        core: core!,
        rpcBase: base,
        rpc,
        seed: USER_SEED,
        slotOverride: item.slot,
        dynCallees:
          item.role === "driver"
            ? { QpiDualCallee: { header: calleePath, index: pairCallee.slot } }
            : undefined,
        artifact: {
          wasm: item.wasm,
          hash: item.hash,
          registration: item.registration,
        },
      },
      (event) => {
        if ("step" in event && event.state === "fail") {
          console.error(`  ${item.compiler} ${item.role} ${event.step}: ${event.detail ?? "failed"}`);
        }
      },
    );
    if (!deployed.ok || !deployed.armed || !deployed.constructed) {
      fail(`${base} ${item.compiler} ${item.role} deploy: ${JSON.stringify(deployed)}`);
    }
  }

  const registry = await rpc.dynRegistry();
  for (const item of artifacts) {
    const row = registry.contracts.find((contract) => contract.index === item.slot);
    if (!row?.armed || !row.constructed) fail(`${base} slot ${item.slot} is not ready`);
    if (row.codeHash.toLowerCase() !== item.hash.toLowerCase()) {
      fail(`${base} slot ${item.slot} code hash ${row.codeHash} != ${item.hash}`);
    }
  }
}

async function invoke(base: string, rpc: LiteRpc, slot: number, inputSeed: bigint): Promise<void> {
  const tick = (await rpc.tickInfo()).tick + 6;
  const result = await invokeProcedure({
    seed: USER_SEED,
    rpcBase: base,
    rpc,
    contractIndex: slot,
    procId: 1,
    amount: 2,
    inFmt: `${inputSeed}uint64, ${slot}uint64`,
    tick,
    confirm: true,
    confirmTimeoutMs: 60_000,
  });
  if (!result.ok || !result.confirmed || !result.included) {
    fail(`${base} slot ${slot} Run was not included: ${JSON.stringify(result)}`);
  }
}

async function execute(base: string, rpc: LiteRpc, artifacts: Artifact[], compiler: Compiler): Promise<Result> {
  const driver = artifacts.find((item) => item.compiler === compiler && item.role === "driver")!;
  const callee = artifacts.find((item) => item.compiler === compiler && item.role === "callee")!;
  await invoke(base, rpc, driver.slot, 17n);
  await invoke(base, rpc, driver.slot, 33n);

  const driverOutput = await rpc.querySmartContract(driver.slot, 1, new Uint8Array(0));
  const calleeOutput = await rpc.querySmartContract(callee.slot, 1, new Uint8Array(0));
  const driverDigest = await rpc.contractDigest(driver.slot);
  const calleeDigest = await rpc.contractDigest(callee.slot);
  const driverRead = await rpc.stateRead(driver.slot, 0, driverDigest.stateSize);
  const calleeRead = await rpc.stateRead(callee.slot, 0, calleeDigest.stateSize);
  const driverState = new Uint8Array(Buffer.from(driverRead.hex, "hex"));
  const calleeState = new Uint8Array(Buffer.from(calleeRead.hex, "hex"));
  if (driverRead.stateSize !== driverDigest.stateSize || driverState.byteLength !== driverDigest.stateSize) {
    fail(`${base} ${compiler} driver state read is incomplete`);
  }
  if (calleeRead.stateSize !== calleeDigest.stateSize || calleeState.byteLength !== calleeDigest.stateSize) {
    fail(`${base} ${compiler} callee state read is incomplete`);
  }
  return {
    driverStateSize: driverDigest.stateSize,
    calleeStateSize: calleeDigest.stateSize,
    driverState,
    calleeState,
    driverOutput,
    calleeOutput,
    driverDigest: driverDigest.digest.toLowerCase(),
    calleeDigest: calleeDigest.digest.toLowerCase(),
  };
}

function assertExpected(result: Result, label: string): void {
  const driver = new DataView(result.driverOutput.buffer, result.driverOutput.byteOffset, result.driverOutput.byteLength);
  const expected = [63n, 4n, 16n, 16n, 16n, 11n, 57n, 2n, 2n, 0x51494e4954574153n];
  expected.forEach((value, index) => {
    const actual = driver.getBigUint64((index + 1) * 8, true);
    if (actual !== value) fail(`${label} driver output word ${index + 1}: ${actual} != ${value}`);
  });
  const callee = new DataView(result.calleeOutput.buffer, result.calleeOutput.byteOffset, result.calleeOutput.byteLength);
  const calleeExpected = [57n, 2n, 0x43414c4c45455741n];
  calleeExpected.forEach((value, index) => {
    const actual = callee.getBigUint64(index * 8, true);
    if (actual !== value) fail(`${label} callee output word ${index}: ${actual} != ${value}`);
  });
}

await initK12();
console.log("CMake proof", JSON.stringify(cmakeProof()));
const coreRpc = new LiteRpc(rpcBase);
const registry = await coreRpc.dynRegistry();
if (registry.contracts.some((contract) => contract.armed)) fail("core node must start with empty dynamic slots");
if (registry.slotCount < 4) fail(`need four dynamic slots, node exposes ${registry.slotCount}`);
const slots = [0, 1, 2, 3].map((offset) => registry.slotBase + offset);

const qpiHeader = loadQpiHeader(core);
verifyPinnedHeader(qpiHeader);
const artifacts = [
  ...(await compileTsPair(slots[0], slots[1], qpiHeader)),
  ...(await compileClangPair(slots[2], slots[3])),
];
for (const item of artifacts) {
  console.log(`${item.compiler.padEnd(5)} ${item.role.padEnd(6)} slot ${item.slot}: ${item.wasm.length}B · ${item.hash}`);
}

const virtualServer = new EngineServer(
  new VirtualNode({ slotBase: registry.slotBase, slotCount: registry.slotCount }),
);
const virtual = await virtualServer.start(0, 25);
try {
  const virtualRpc = new LiteRpc(virtual.rpcBase);
  await deployAll(virtual.rpcBase, virtualRpc, artifacts);
  await deployAll(rpcBase, coreRpc, artifacts);

  const results = new Map<string, Result>();
  for (const [name, base, rpc] of [
    ["virtual", virtual.rpcBase, virtualRpc],
    ["core", rpcBase, coreRpc],
  ] as const) {
    for (const compiler of ["TS", "Clang"] as const) {
      const result = await execute(base, rpc, artifacts, compiler);
      assertExpected(result, `${compiler}/${name}`);
      results.set(`${compiler}/${name}`, result);
    }
  }

  const canonical = results.get("TS/virtual")!;
  for (const [name, result] of results) {
    if (result.driverStateSize !== canonical.driverStateSize) {
      fail(`${name} driver state size ${result.driverStateSize} != ${canonical.driverStateSize}`);
    }
    if (result.calleeStateSize !== canonical.calleeStateSize) {
      fail(`${name} callee state size ${result.calleeStateSize} != ${canonical.calleeStateSize}`);
    }
    same(result.driverState, canonical.driverState, `${name} driver state`);
    same(result.calleeState, canonical.calleeState, `${name} callee state`);
    same(result.driverOutput, canonical.driverOutput, `${name} driver output`);
    same(result.calleeOutput, canonical.calleeOutput, `${name} callee output`);
    if (result.driverDigest !== canonical.driverDigest) {
      fail(`${name} driver digest ${result.driverDigest} != ${canonical.driverDigest}`);
    }
    if (result.calleeDigest !== canonical.calleeDigest) {
      fail(`${name} callee digest ${result.calleeDigest} != ${canonical.calleeDigest}`);
    }
  }
  if (process.env.QINIT_QPI_DIGEST_FILE) {
    writeFileSync(
      process.env.QINIT_QPI_DIGEST_FILE,
      `${canonical.driverDigest} ${canonical.calleeDigest}\n`,
    );
  }
  console.log(
    `QPI MATRIX OK — TS/Clang × virtual/core: ${canonical.driverState.length}B driver ${canonical.driverDigest}, ${canonical.calleeState.length}B callee ${canonical.calleeDigest}`,
  );
} finally {
  virtual.stop();
  rmSync(scratch, { recursive: true, force: true });
}
