// Production QPI acceptance: compile once with the TS compiler, run the exact
// bytes in Sim upload unchanged to the release-configured WAMR node.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initK12, k12Hex, LiteRpc } from "../packages/core/src/index";
import { compileContract, inspectLiteWasmModule, loadQpiHeader } from "../packages/compile/src/index";
import { Sim } from "../packages/engine/src/index";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { invokeProcedure, resolveSlot } from "../packages/proto/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");
const fixture = resolve("fixtures/QpiDual.h");
const source = readFileSync(fixture, "utf8");
const rpc = new LiteRpc(rpcBase);
function fail(message: string): never { throw new Error(`QPI DUAL FAIL: ${message}`); }
const same = (left: Uint8Array, right: Uint8Array, label: string) => {
  if (!Buffer.from(left).equals(Buffer.from(right))) {
    fail(`${label} differs (${left.byteLength}B vs ${right.byteLength}B)`);
  }
};

function cmakeProof(): Record<string, string> {
  const cache = readFileSync(resolve(core!, "build-node/CMakeCache.txt"), "utf8");
  const value = (key: string): string => {
    const match = cache.match(new RegExp(`^${key}:[^=]*=(.*)$`, "m"));
    if (!match) fail(`CMake cache is missing ${key}`);
    return match[1].trim();
  };
  const proof: Record<string, string> = {};
  const expected: Record<string, string> = {
    CMAKE_BUILD_TYPE: "RelWithDebInfo",
    BUILD_BINARY: "ON", BUILD_TESTS: "OFF", ENABLE_AVX512: "OFF", USE_SANITIZER: "OFF",
    TESTNET: "ON", TESTNET_LITE_RAM: "ON", TESTNET_PREFILL_QUS: "ON",
    LITE_WASM_SC: "ON", CMAKE_NO_USE_SWAP: "ON",
    ADDON_TX_STATUS_REQUEST: "ON", ONLY_LOGGING: "OFF",
  };
  for (const [key, want] of Object.entries(expected)) {
    proof[key] = value(key);
    if (proof[key] !== want) fail(`CMake ${key}=${proof[key]}, expected ${want}`);
  }
  proof.CMAKE_C_COMPILER = value("CMAKE_C_COMPILER");
  proof.CMAKE_CXX_COMPILER = value("CMAKE_CXX_COMPILER");
  if (!proof.CMAKE_C_COMPILER.endsWith("clang-18") || !proof.CMAKE_CXX_COMPILER.endsWith("clang++-18")) {
    fail(`node was not configured with clang/clang++ 18`);
  }
  return proof;
}

function verifyPinnedHeader(header: string): void {
  const manifest = JSON.parse(readFileSync(resolve("packages/compile/core-snapshot.json"), "utf8"));
  const hash = `sha256:${createHash("sha256").update(header).digest("hex")}`;
  if (hash !== manifest.snapshotHash) {
    fail(`core header hash ${hash} does not match pinned ${manifest.snapshotHash}`);
  }
  console.log(`pinned core ${manifest.core.commit} · snapshot ${hash}`);
}

function input(seed: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, seed, true);
  return bytes;
}

function registryShape(entries: Array<{ inputType: number; inputSize: number; outputSize: number }>) {
  return entries.map((entry) => [entry.inputType, entry.inputSize, entry.outputSize]).sort((a, b) => a[0] - b[0]);
}

await initK12();
const proof = cmakeProof();
console.log("release CMake proof", JSON.stringify(proof));

// Slot is part of the contract ABI (SELF_INDEX), so resolve it before the one
// and only compilation. deployContract receives the same explicit slot.
const { slot } = await resolveSlot(rpc, "QpiDual");
const qpiHeader = loadQpiHeader(core);
verifyPinnedHeader(qpiHeader);
const compiled = await compileContract({
  // Must match LITE_WASM_ARENA_SZ in the release node. A smaller module can run
  // in Sim but is correctly rejected by core's production IO-carve check.
  source, name: "QpiDual", slot, qpiHeader, arenaSz: 1024 * 1024 * 1024,
});
const errors = compiled.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
if (errors.length) fail(errors.map((diagnostic) => diagnostic.message).join("; "));
if (!compiled.wasm.byteLength) fail("compiler returned an empty artifact");

const inspection = inspectLiteWasmModule(compiled.wasm);
if (!inspection.ok) fail(inspection.diagnostics.map((diagnostic) => diagnostic.message).join("; "));
const hash = await k12Hex(compiled.wasm);
console.log(`compiled once: ${compiled.wasm.byteLength}B · k12 ${hash} · features [${inspection.features.join(",")}]`);

const seed = 0xfedcba9876543210n;
const payload = input(seed);
const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
const simUser = new Uint8Array(32).fill(7);
sim.fund(simUser, 1_000_000n);
sim.deploy(slot, compiled.wasm);
sim.procedure(slot, 1, payload, { invocator: simUser });
const simOutput = sim.query(slot, 1);
const simState = sim.contracts.get(slot)!.state();
const simDigest = sim.digest(slot);

const deployed = await deployContract({
  contractPath: fixture,
  name: "QpiDual",
  core,
  rpcBase,
  slotOverride: slot,
  artifact: {
    wasm: compiled.wasm,
    hash,
    registration: { functions: compiled.idl.functions.length, procedures: compiled.idl.procedures.length },
  },
}, (event: any) => {
  if ("note" in event) console.log(`  ${event.note}`);
  else console.log(`  ${event.step}: ${event.state}${event.detail ? ` — ${event.detail}` : ""}`);
});
if (!deployed.ok || !deployed.armed || !deployed.constructed) fail(`artifact deploy did not become ready: ${JSON.stringify(deployed)}`);

const registry = await rpc.dynRegistry();
const row = registry.contracts.find((contract) => contract.index === slot);
if (!row || !row.armed || !row.constructed) fail("registry row is absent or not ready");
if (row.codeHash.toLowerCase() !== hash.toLowerCase()) fail(`registry codeHash ${row.codeHash} != artifact ${hash}`);
const wantFns = registryShape(compiled.idl.functions.map((entry) => ({
  inputType: entry.inputType, inputSize: entry.inSize, outputSize: entry.outSize,
})));
const wantProcs = registryShape(compiled.idl.procedures.map((entry) => ({
  inputType: entry.inputType, inputSize: entry.inSize, outputSize: entry.outSize,
})));
if (JSON.stringify(registryShape(row.functions)) !== JSON.stringify(wantFns)) fail("function registry metadata differs");
if (JSON.stringify(registryShape(row.procedures)) !== JSON.stringify(wantProcs)) fail("procedure registry metadata differs");

const fundedSeed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tick = (await rpc.tickInfo()).tick + 6;
const invoked = await invokeProcedure({
  seed: fundedSeed, rpcBase, contractIndex: slot, procId: 1, amount: 0,
  inFmt: `${seed}uint64`, tick, confirm: true, confirmTimeoutMs: 60_000, rpc,
});
if (!invoked.ok || !invoked.confirmed || !invoked.included) fail(`Run was not included: ${JSON.stringify(invoked)}`);

const nodeOutput = await rpc.querySmartContract(slot, 1, new Uint8Array(0));
const firstState = await rpc.stateRead(slot, 0, 262_144);
if (firstState.stateSize !== compiled.idl.stateSize) {
  fail(`state size ${firstState.stateSize} != compiler ${compiled.idl.stateSize}`);
}
const nodeState = new Uint8Array(Buffer.from(firstState.hex, "hex"));
const nodeDigest = await rpc.contractDigest(slot);

same(nodeOutput, simOutput, "function output");
same(nodeState, simState, "resident state");
if (nodeDigest.digest.toLowerCase() !== simDigest.toLowerCase()) {
  fail(`state digest ${nodeDigest.digest} != Sim ${simDigest}`);
}
console.log(`QPI DUAL OK — exact artifact, registry, ${nodeState.byteLength} state bytes, output, and K12 digest match at slot ${slot}`);
