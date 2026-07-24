// Compile once, execute the exact artifact on the release-configured WAMR node,
// then replay the node's captured chain context in Sim and compare state bytes.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initK12, k12Hex, LiteRpc } from "../packages/core/src/index";
import {
  compileContract,
  DiagnosticSeverity,
  inspectWasmModule,
  loadQpiHeader,
} from "../packages/compile/src/index";
import { Sim } from "../packages/engine/src/index";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { invokeProcedure, resolveSlot } from "../packages/proto/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");
const fixture = resolve("fixtures/RandomDual.h");
const source = readFileSync(fixture, "utf8");
const rpc = new LiteRpc(rpcBase);
const fail = (message: string): never => {
  throw new Error(`RANDOM DUAL FAIL: ${message}`);
};
const bytes = (hex: string): Uint8Array => new Uint8Array(Buffer.from(hex, "hex"));
const same = (left: Uint8Array, right: Uint8Array, label: string) => {
  if (!Buffer.from(left).equals(Buffer.from(right))) fail(`${label} differs`);
};

function cmakeProof(): void {
  const cache = readFileSync(resolve(core!, "build-node/CMakeCache.txt"), "utf8");
  const value = (key: string): string =>
    cache.match(new RegExp(`^${key}:[^=]*=(.*)$`, "m"))?.[1]?.trim() ??
    fail(`CMake cache is missing ${key}`);
  const expected: Record<string, string> = {
    CMAKE_BUILD_TYPE: "RelWithDebInfo",
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
  for (const [key, want] of Object.entries(expected)) {
    if (value(key) !== want) fail(`CMake ${key}=${value(key)}, expected ${want}`);
  }
  if (!value("CMAKE_C_COMPILER").endsWith("clang-18") || !value("CMAKE_CXX_COMPILER").endsWith("clang++-18")) {
    fail("node was not configured with clang/clang++ 18");
  }
}

function verifyPinnedHeader(header: string): void {
  const manifest = JSON.parse(readFileSync(resolve("packages/compile/core-snapshot.json"), "utf8"));
  const hash = `sha256:${createHash("sha256").update(header).digest("hex")}`;
  if (hash !== manifest.snapshotHash) fail(`core header hash ${hash} does not match pinned ${manifest.snapshotHash}`);
}

function input(nonce: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, nonce, true);
  return out;
}

await initK12();
cmakeProof();
const { slot } = await resolveSlot(rpc, "RandomDual");
const qpiHeader = loadQpiHeader(core);
verifyPinnedHeader(qpiHeader);
const compiled = await compileContract({
  source,
  name: "RandomDual",
  slot,
  qpiHeader,
  arenaSz: 1024 * 1024 * 1024,
});
const errors = compiled.diagnostics.filter(
  (item) => item.severity === DiagnosticSeverity.ERROR,
);
if (errors.length || !compiled.wasm.length) {
  fail(errors.map((item) => item.message).join("; ") || "empty artifact");
}
const idl = compiled.idl;
if (!idl) {
  throw new Error("RANDOM DUAL FAIL: successful compile returned no IDL");
}
const inspection = inspectWasmModule(compiled.wasm);
if (!inspection.ok) {
  fail(inspection.diagnostics.map((item) => item.message).join("; "));
}
if (inspection.imports.some((item) => item.module !== "lhost")) {
  fail("artifact has a non-lhost import");
}

const hash = await k12Hex(compiled.wasm);
const deployed = await deployContract({
  contractPath: fixture,
  name: "RandomDual",
  core,
  rpcBase,
  slotOverride: slot,
  artifact: {
    wasm: compiled.wasm,
    hash,
    registration: { functions: idl.functions.length, procedures: idl.procedures.length },
  },
}, () => {});
if (!deployed.ok || !deployed.armed || !deployed.constructed) {
  fail(`deploy did not become ready: ${JSON.stringify(deployed)}`);
}

const preRead = await rpc.stateRead(slot, 0, idl.state.size);
const preState = bytes(preRead.hex);
await rpc.setDebug(true);
const beforeTrace = await rpc.debugTrace(0, 256);
const since = beforeTrace.entries.reduce((max, entry) => Math.max(max, entry.seq), 0);
const nonce = 0x1020304050607080n;
const payload = input(nonce);
const fundedSeed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tick = (await rpc.tickInfo()).tick + 6;
const invoked = await invokeProcedure({
  seed: fundedSeed,
  rpcBase,
  contractIndex: slot,
  procId: 1,
  amount: 0,
  inFmt: `${nonce}uint64`,
  tick,
  confirm: true,
  confirmTimeoutMs: 60_000,
  rpc,
});
if (!invoked.ok || !invoked.confirmed || !invoked.included) {
  fail(`Run was not included: ${JSON.stringify(invoked)}`);
}

const trace = (await rpc.debugTrace(since, 64)).entries
  .filter((entry) => entry.index === slot && entry.entry === 1 && entry.kind === 1 && entry.ok)
  .at(-1);
if (!trace) throw new Error("RANDOM DUAL FAIL: node emitted no successful procedure trace");
const postRead = await rpc.stateRead(slot, 0, idl.state.size);
const nodeState = bytes(postRead.hex);
const prevSpectrum = nodeState.slice(0, 32);
const invocator = bytes(trace.invocator);

const replay = (): Uint8Array => {
  const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
  sim.tickN = trace.tick;
  sim.prevSpectrumDigestOverride = prevSpectrum;
  const contract = sim.deploy(slot, compiled.wasm);
  contract.writeState(preState);
  sim.procedure(slot, 1, payload, {
    invocator,
    originator: invocator,
    reward: BigInt(trace.invocationReward),
  });
  return contract.state();
};

const simState = replay();
same(simState, nodeState, "resident state");
same(replay(), simState, "identical replay");
const first = simState.slice(32, 64);
const second = simState.slice(64, 96);
const third = simState.slice(96, 128);
if (
  first.every((value) => value === 0) ||
  second.every((value) => value === 0) ||
  third.every((value) => value === 0)
) {
  fail("random id is zero");
}
if (
  Buffer.from(first).equals(Buffer.from(second)) ||
  Buffer.from(second).equals(Buffer.from(third))
) {
  fail("random sequence did not advance");
}
const view = new DataView(simState.buffer, simState.byteOffset, simState.byteLength);
if (
  view.getUint32(160, true) !== 1 ||
  view.getUint32(164, true) !== 1 ||
  view.getUint32(168, true) !== 1
) {
  fail("rdrand success result differs");
}
await rpc.setDebug(false);
console.log(`RANDOM DUAL OK — exact ${compiled.wasm.length}B artifact, tick ${trace.tick}, ${nodeState.length} state bytes match in WAMR and Sim`);
