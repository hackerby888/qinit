import { DiagnosticSeverity } from "../../src/enums";
import { beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContract } from "@qinit/build";
import { initK12 } from "@qinit/core";
import { Sim } from "@qinit/engine";
import ORACLE_PROBE_SOURCE from "../../../../fixtures/OracleProbe.h" with { type: "text" };
import { CORE_PATH } from "../../../../test-utils/paths";
import { compileContract, loadQpiHeader } from "../../src/index";

const SLOT = 29;

function wasiAvailable(): boolean {
  try {
    const { wasiSdkPaths } = require("@qinit/core/project");
    return existsSync(wasiSdkPaths().clang);
  } catch {
    return false;
  }
}

function contractId(): Uint8Array {
  const id = new Uint8Array(32);
  new DataView(id.buffer).setBigUint64(0, BigInt(SLOT), true);
  return id;
}

function subscribeInput(): Uint8Array {
  const input = new Uint8Array(112);
  input.set(new TextEncoder().encode("mock"), 0);
  input.set(new TextEncoder().encode("BTC"), 40);
  input.set(new TextEncoder().encode("USD"), 72);
  new DataView(input.buffer).setUint32(104, 60_000, true);
  return input;
}

function priceReply(): Uint8Array {
  const reply = new Uint8Array(16);
  const view = new DataView(reply.buffer);
  view.setBigInt64(0, 7n, true);
  view.setBigInt64(8, 2n, true);
  return reply;
}

function run(wasm: Uint8Array) {
  const sim = new Sim();
  sim.tickDuration = 60_000;
  sim.deploy(SLOT, wasm);
  sim.fund(contractId(), 1_000_000n);
  sim.setOracleProvider((interfaceIndex) => (interfaceIndex === 0 ? priceReply() : null));

  const output = sim.procedure(SLOT, 3, subscribeInput());
  const subscriptionId = new DataView(
    output.buffer,
    output.byteOffset,
    output.byteLength,
  ).getInt32(0, true);
  const pendingInterface = sim.pendingOracleQueries()[0]?.interfaceIndex;
  sim.advance();
  sim.advance();
  sim.advance();
  return {
    subscriptionId,
    pendingInterface,
    balance: sim.balance(contractId()),
    state: sim.query(SLOT, 1),
  };
}

beforeAll(async () => {
  await initK12();
});

test("Price subscription matches across TS and Clang artifacts in VirtualNode", async () => {
  if (!wasiAvailable()) {
    console.log("  (wasi-sdk clang not found — skipping)");
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), "oracle-subscription-diff-"));
  const contractPath = join(directory, "OracleProbe.h");
  writeFileSync(contractPath, ORACLE_PROBE_SOURCE);
  const clang = await buildContract({
    contractPath,
    name: "OracleProbe",
    slot: SLOT,
    corePath: CORE_PATH,
    outDir: join(directory, "clang"),
    skipVerify: true,
  });
  expect(clang.ok).toBe(true);

  const typescript = await compileContract({
    source: ORACLE_PROBE_SOURCE,
    name: "OracleProbe",
    slot: SLOT,
    qpiHeader: loadQpiHeader(CORE_PATH),
    arenaSz: 4 * 1024 * 1024,
  });
  expect(typescript.diagnostics.filter((diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR)).toEqual([]);
  if (!typescript.idl) {
    throw new Error("successful TypeScript compile returned no IDL");
  }
  expect(typescript.idl.procedures.find((entry) => entry.name === "Subscribe")?.inSize).toBe(
    112,
  );

  const nativeResult = run(new Uint8Array(readFileSync(clang.so!)));
  const typescriptResult = run(typescript.wasm);
  expect(nativeResult.subscriptionId).toBe(0);
  expect(typescriptResult).toEqual(nativeResult);
  expect(nativeResult.pendingInterface).toBe(0);
  expect(nativeResult.balance).toBe(990_000n);
});
