import { CORE_PATH, QINIT_ROOT } from "../../../test-utils/paths";
// Standalone sweep tool: compile contracts without engine.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { compileContract, loadQpiHeader, type CompileResult, type CalleeIdl } from "../src/index";
import { systemContracts, type SystemContract } from "../../build/src/system-contracts";

const CORE = CORE_PATH;
const HEADERS = loadQpiHeader(CORE);
const FIX = QINIT_ROOT + "/fixtures";
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
  // unblocked by the Tier-1 parser robustness work
  ["Qbay", `${SYS}/Qbay.h`], ["QRaffle", `${SYS}/QRaffle.h`], ["VottunBridge", `${SYS}/VottunBridge.h`],
  ["QVAULT", `${SYS}/QVAULT.h`], ["Qswap", `${SYS}/Qswap.h`], ["Qusino", `${SYS}/Qusino.h`],
  ["Quottery", `${SYS}/Quottery.h`],
  ["QUTIL", `${SYS}/QUtil.h`], ["QRWA", `${SYS}/qRWA.h`],
];

const catalog = systemContracts(CORE);

// Fixture-to-fixture callees (not in the system catalog): Proxy CALLs the Counter fixture.
const FIXTURE_DEPS: Record<string, Array<{ name: string; path: string; slot: number }>> = {
  Proxy: [{ name: "Counter", path: `${FIX}/Counter.h`, slot: 28 }],
};
const FIXTURE_MAIN_SLOT: Record<string, number> = { Proxy: 29 };

// Sibling system contracts the source references — same detection as corpus-run's depSpecs.
function depsOf(src: string, selfFile: string): SystemContract[] {
  return catalog.filter((c) => {
    if (c.file === selfFile) return false;
    return new RegExp(`\\b(${c.name}|${c.stateType})(::|_[A-Z0-9])`).test(src);
  });
}

const depCache = new Map<string, { entry: CalleeIdl; source: string } | null>();

async function calleeFor(c: SystemContract): Promise<{ entry: CalleeIdl; source: string } | null> {
  if (depCache.has(c.name)) return depCache.get(c.name)!;
  // Break possible catalog cycles while recursively giving a callee the IDLs it
  // itself needs (QThirtyFour -> QRP -> RL is the current real chain).
  depCache.set(c.name, null);

  let result: { entry: CalleeIdl; source: string } | null = null;
  try {
    const source = readFileSync(`${SYS}/${c.file}`, "utf8");
    const callees: CalleeIdl[] = [];
    const calleeSources: Array<{ name: string; source: string }> = [];
    for (const dependency of depsOf(source, c.file)) {
      const nested = await calleeFor(dependency);
      if (!nested) continue;
      callees.push(nested.entry);
      calleeSources.push({ name: nested.entry.name, source: nested.source });
    }
    const r = await compileContract({
      source, name: c.stateType, slot: c.index, qpiHeader: HEADERS, arenaSz: 1024 * 1024, strict: false,
      callees: callees.length ? callees : undefined,
      calleeSources: calleeSources.length ? calleeSources : undefined,
    });
    result = {
      source,
      entry: {
        name: c.stateType,
        index: c.index,
        functions: Object.fromEntries(r.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }])),
        procedures: Object.fromEntries(r.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }])),
      },
    };
  } catch {
    result = null;
  }

  depCache.set(c.name, result);
  return result;
}

const pad = (s: string, n: number) => s.padEnd(n);
console.log(pad("CONTRACT", 24) + pad("WASM", 9) + pad("ERR", 5) + pad("WARN", 6) + "CALLEES");
console.log("-".repeat(64));
let ok = 0, totalWarn = 0, totalErr = 0;
const warnHist: Record<string, number> = {};
for (const [name, path] of targets) {
  let src: string;
  try { src = readFileSync(path, "utf8"); } catch { console.log(pad(name, 24) + "no-file"); continue; }
  try {
    const deps = depsOf(src, basename(path));
    const callees: CalleeIdl[] = [];
    const calleeSources: Array<{ name: string; source: string }> = [];
    for (const d of deps) {
      const cr = await calleeFor(d);
      if (!cr) continue;
      callees.push(cr.entry);
      calleeSources.push({ name: cr.entry.name, source: cr.source });
    }
    for (const fd of FIXTURE_DEPS[name] ?? []) {
      const fsrc = readFileSync(fd.path, "utf8");
      const fr = await compileContract({ source: fsrc, name: fd.name, slot: fd.slot, qpiHeader: HEADERS, arenaSz: 1024 * 1024, strict: false });
      callees.push({
        name: fd.name,
        index: fd.slot,
        functions: Object.fromEntries(fr.idl.functions.map((f) => [f.name, { inputType: f.inputType, inSize: f.inSize, outSize: f.outSize }])),
        procedures: Object.fromEntries(fr.idl.procedures.map((p) => [p.name, { inputType: p.inputType, inSize: p.inSize, outSize: p.outSize }])),
      });
      calleeSources.push({ name: fd.name, source: fsrc });
    }

    const slot = FIXTURE_MAIN_SLOT[name] ?? catalog.find((c) => c.file === basename(path))?.index ?? 28;
    const r = await compileContract({
      source: src, name, slot, qpiHeader: HEADERS, arenaSz: 1024 * 1024,
      callees: callees.length ? callees : undefined,
      calleeSources: calleeSources.length ? calleeSources : undefined,
    });

    const errs = r.diagnostics.filter((d) => d.severity === "error").length;
    const warns = r.diagnostics.filter((d) => d.severity === "warning");
    for (const d of r.diagnostics) warnHist[d.message] = (warnHist[d.message] ?? 0) + 1;
    if (errs === 0 && r.wasm.byteLength > 0) ok++;
    totalWarn += warns.length;
    totalErr += errs;
    console.log(pad(name, 24) + pad(`${r.wasm.byteLength}`, 9) + pad(`${errs}`, 5) + pad(`${warns.length}`, 6) + deps.map((d) => d.name).join(","));
  } catch (e: any) {
    console.log(pad(name, 24) + "THREW: " + (e.message ?? "").slice(0, 30));
  }
}
console.log("-".repeat(64));
console.log(`compiled clean: ${ok}/${targets.length}  ·  total errors: ${totalErr}  ·  total warnings: ${totalWarn}`);
console.log("\ndiagnostic histogram:");
for (const [m, c] of Object.entries(warnHist).sort((a, b) => b[1] - a[1])) console.log(`  ${c}×  ${m}`);
if (ok !== targets.length || totalErr !== 0 || totalWarn !== 0) process.exitCode = 1;
