// Standalone compile sweep over all loadable contracts (no engine needed). Reports wasm size +
// error/warning counts so body-codegen regressions (new errors) or stub-coverage gaps (warnings) show.
import { readFileSync } from "node:fs";
import { compileContract, loadQpiHeader } from "../src/index";

const CORE = "/home/kali/Projects/core-lite";
const HEADERS = loadQpiHeader(CORE);
const FIX = "/home/kali/Projects/Qinit/fixtures";
const SYS = `${CORE}/src/contracts`;

const targets: [string, string][] = [
  ["Counter", `${FIX}/Counter.h`], ["Bank", `${FIX}/Bank.h`], ["Token", `${FIX}/Token.h`],
  ["Vault", `${FIX}/Vault.h`], ["Dividend", `${FIX}/Dividend.h`], ["Proxy", `${FIX}/Proxy.h`],
  ["DigestProbe", `${FIX}/DigestProbe.h`],
  ["Random", `${SYS}/Random.h`], ["QEARN", `${SYS}/Qearn.h`], ["QIP", `${SYS}/QIP.h`],
  ["QBond", `${SYS}/QBond.h`], ["GGWP", `${SYS}/GGWP.h`], ["MsVault", `${SYS}/MsVault.h`],
  ["QDuel", `${SYS}/QDuel.h`], ["Qdraw", `${SYS}/Qdraw.h`], ["QReservePool", `${SYS}/QReservePool.h`],
  ["RandomLottery", `${SYS}/RandomLottery.h`], ["Pulse", `${SYS}/Pulse.h`], ["Escrow", `${SYS}/Escrow.h`],
  ["Nostromo", `${SYS}/Nostromo.h`], ["QThirtyFour", `${SYS}/QThirtyFour.h`], ["Qx", `${SYS}/Qx.h`],
  ["SupplyWatcher", `${SYS}/SupplyWatcher.h`], ["GeneralQuorumProposal", `${SYS}/GeneralQuorumProposal.h`],
  ["ComputorControlledFund", `${SYS}/ComputorControlledFund.h`],
];

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("CONTRACT", 24) + pad("WASM", 9) + pad("ERR", 5) + "WARN");
console.log("-".repeat(48));
let ok = 0, totalWarn = 0;
const warnHist: Record<string, number> = {};
for (const [name, path] of targets) {
  let src: string;
  try { src = readFileSync(path, "utf8"); } catch { console.log(pad(name, 24) + "no-file"); continue; }
  try {
    const r = await compileContract({ source: src, name, slot: 28, qpiHeader: HEADERS, arenaSz: 1024 * 1024 });
    const errs = r.diagnostics.filter((d) => d.severity === "error").length;
    const warns = r.diagnostics.filter((d) => d.severity === "warning");
    for (const w of warns) warnHist[w.message] = (warnHist[w.message] ?? 0) + 1;
    if (errs === 0 && r.wasm.byteLength > 0) ok++;
    totalWarn += warns.length;
    console.log(pad(name, 24) + pad(`${r.wasm.byteLength}`, 9) + pad(`${errs}`, 5) + `${warns.length}`);
  } catch (e: any) {
    console.log(pad(name, 24) + "THREW: " + (e.message ?? "").slice(0, 30));
  }
}
console.log("-".repeat(48));
console.log(`compiled clean: ${ok}/${targets.length}  ·  total warnings: ${totalWarn}`);
console.log("\nwarning histogram:");
for (const [m, c] of Object.entries(warnHist).sort((a, b) => b[1] - a[1])) console.log(`  ${c}×  ${m}`);
