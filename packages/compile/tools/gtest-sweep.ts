import { CORE_PATH, QINIT_ROOT } from "../../../test-utils/paths";
// Build and run differential gtests for each compilable contract.
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCorpusRunner, genStdGtest, extractIdl, qpiPrelude } from "@qinit/build";
import { runContractTesting } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, DiagnosticSeverity, loadQpiHeader } from "../src/index";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const FIX = QINIT_ROOT + "/fixtures";
const SYS = `${CORE}/src/contracts`;

// (display, file dir, file) for the contracts that loaded in the layout sweep.
const TARGETS: [string, string, string][] = [
  ["Counter", FIX, "Counter.h"], ["Bank", FIX, "Bank.h"], ["Token", FIX, "Token.h"],
  ["Vault", FIX, "Vault.h"], ["Dividend", FIX, "Dividend.h"], ["Proxy", FIX, "Proxy.h"],
  ["DigestProbe", FIX, "DigestProbe.h"],
  ["Random", SYS, "Random.h"], ["QEARN", SYS, "Qearn.h"], ["QIP", SYS, "QIP.h"],
  ["QBond", SYS, "QBond.h"], ["GGWP", SYS, "GGWP.h"], ["MsVault", SYS, "MsVault.h"],
  ["QDuel", SYS, "QDuel.h"], ["Qdraw", SYS, "Qdraw.h"], ["QReservePool", SYS, "QReservePool.h"],
  ["RandomLottery", SYS, "RandomLottery.h"], ["Pulse", SYS, "Pulse.h"], ["Escrow", SYS, "Escrow.h"],
  ["Nostromo", SYS, "Nostromo.h"], ["QThirtyFour", SYS, "QThirtyFour.h"], ["Qx", SYS, "Qx.h"],
  ["SupplyWatcher", SYS, "SupplyWatcher.h"], ["GeneralQuorumProposal", SYS, "GeneralQuorumProposal.h"],
  ["ComputorControlledFund", SYS, "ComputorControlledFund.h"],
];

function structName(src: string): string {
  const m = src.match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/);
  return m ? m[1] : "Contract";
}

await initK12();
const dir = mkdtempSync(join(tmpdir(), "gtest-sweep-"));
const prelude = qpiPrelude(CORE);

const rows: string[] = [];
const pad = (s: string, n: number) => s.padEnd(n);
console.log("\n" + pad("CONTRACT", 22) + pad("NATIVE", 9) + pad("MINE", 9) + pad("TESTS", 8) + "RESULT");
console.log("-".repeat(64));

let passContracts = 0, totalTests = 0, passTests = 0;

for (const [disp, base, file] of TARGETS) {
  const src = readFileSync(join(base, file), "utf8");
  const name = structName(src);
  let native = "-", mine = "-", testsStr = "-", result = "-";

  // 1. auto-generate the smoke gtest from the IDL
  let testSrc = "";
  try {
    const idl = extractIdl(src, name, { prelude });
    testSrc = genStdGtest(idl, name, name);
  } catch (e: any) {
    console.log(pad(disp, 22) + pad("idl-fail", 9) + "-");
    continue;
  }

  // 2. native build of contract + test → the runner
  let runner: Uint8Array | null = null;
  try {
    const cp = join(dir, `${name}.h`);
    writeFileSync(cp, src);
    const testPath = join(dir, `${name}.test.cpp`);
    writeFileSync(testPath, testSrc);
    const b = await buildCorpusRunner({ corpusPath: testPath, contractPath: cp, name, stateType: name, slot: 28, corePath: CORE, outDir: dir });
    if (b.ok && b.so) { runner = new Uint8Array(readFileSync(b.so)); native = "ok"; }
    else native = "FAIL";
  } catch { native = "THROW"; }

  // 3. my build of the contract
  let mineWasm: Uint8Array | null = null;
  try {
    const r = await compileContract({ source: src, name, slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    if (
        r.wasm.byteLength &&
        !r.diagnostics.some((d) => d.severity === DiagnosticSeverity.ERROR)
    ) {
        mineWasm = r.wasm;
        mine = "ok";
    }
    else mine = "err";
  } catch { mine = "THROW"; }

  // 4. drive my contract with the native test logic
  if (runner && mineWasm) {
    try {
      const res = await runContractTesting(runner, { 28: mineWasm });
      const p = res.filter((r) => r.passed).length;
      testsStr = `${p}/${res.length}`;
      totalTests += res.length; passTests += p;
      result = p === res.length && res.length > 0 ? "ALL PASS" : `${res.length - p} fail`;
      if (p === res.length && res.length > 0) passContracts++;
    } catch (e: any) {
      result = "run-throw: " + (e.message ?? "").slice(0, 24);
    }
  }

  console.log(pad(disp, 22) + pad(native, 9) + pad(mine, 9) + pad(testsStr, 8) + result);
}

console.log("-".repeat(64));
console.log(`contracts all-pass: ${passContracts}/${TARGETS.length}  ·  smoke tests: ${passTests}/${totalTests}`);
console.log("(pass == executed without trapping; genStdGtest emits no value assertions)\n");
