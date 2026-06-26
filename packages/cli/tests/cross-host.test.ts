// Cross-host state equivalence — the capstone fidelity check. qinit's engine is a TS port of the node's C++
// wasm host; the only thing that proves the port is faithful (and keeps it faithful) is showing both produce
// byte-identical contract state for the same wasm + the same ops. Here: build the DigestProbe fixture (a rich
// mixed-width StateData) to ONE wasm, run INITIALIZE + Inc on BOTH the node's WAMR (the qubic_core_tests
// `WasmContracts.CrossHostStateEquivalence` gtest) and qinit's Sim, and assert the StateData bytes match. Equal
// bytes => equal K12 state digest across hosts, which is the consensus-critical invariant. This replaces the
// stale hand-captured digest oracle in engine.test.ts with a LIVE both-hosts comparison.
// Skipped unless the core tree + the prebuilt gtest binary are present (build-wtests).
import { test, expect } from "bun:test";
import { existsSync } from "node:fs";
import { buildContract } from "@qinit/build";
import { Sim, initK12, toHex } from "@qinit/engine";

const CORE = "/home/kali/Projects/core-lite";
const GTEST = `${CORE}/build-wtests/test/qubic_core_tests`;
const PROBE = `${import.meta.dir}/../../../fixtures/DigestProbe.h`;
const haveBoth = existsSync(GTEST) && existsSync(PROBE);

test.skipIf(!haveBoth)("cross-host: DigestProbe state is byte-identical on the node WAMR and qinit's engine", async () => {
  await initK12();
  const r = await buildContract({ contractPath: PROBE, name: "DigestProbe", slot: 29, corePath: CORE, outDir: "/tmp/qinit-xhost", skipVerify: true });
  expect(r.ok).toBe(true);
  const wasmPath = r.so!;

  // qinit side: deploy (runs INITIALIZE) then one Inc, read the raw StateData
  const sim = new Sim();
  const c = sim.deploy(29, new Uint8Array(await Bun.file(wasmPath).arrayBuffer()));
  sim.procedure(29, 1);
  const qinitHex = toHex(c.state());
  expect(qinitHex.length).toBe(64 * 2); // DigestProbe's 64-byte rich layout (uint8/16/32/64, sint64, two arrays)

  // node side: the same wasm under WAMR, same op sequence, via the gtest that prints CROSSHOST_STATE=<hex>
  const proc = Bun.spawnSync([GTEST, "--gtest_filter=WasmContracts.CrossHostStateEquivalence"], {
    env: { ...process.env, QINIT_WASM: wasmPath, QINIT_OPS: "1" },
  });
  const out = proc.stdout.toString();
  const m = out.match(/CROSSHOST_STATE=([0-9a-f]+)/);
  expect(m, `gtest did not emit CROSSHOST_STATE; output:\n${out}\n${proc.stderr.toString()}`).not.toBeNull();
  const coreHex = m![1];

  // the proof: byte-identical contract state across the two independent host implementations
  expect(coreHex).toBe(qinitHex);
}, 120_000);
