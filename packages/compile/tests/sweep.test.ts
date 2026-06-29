// Honest conformance sweep: compile every contract through the local TS compiler and report
// parse / wasm / engine-load / state-size results. NOT a pass/fail gate — a measurement.
import { test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { compileContract, loadQpiHeader } from "../src/index";

const QPI = loadQpiHeader("/home/kali/Projects/core-lite");

const FIXTURES = "/home/kali/Projects/Qinit/fixtures";
const SYSTEM = "/home/kali/Projects/core-lite/src/contracts";

// system contract files (exclude headers/templates/old/test variants)
const SYSTEM_FILES = [
  "Qx.h", "Quottery.h", "Random.h", "QUtil.h", "QEARN=Qearn.h", "QVAULT.h", "MsVault.h",
  "GGWP.h", "QIP.h", "QBond.h", "QDuel.h", "Qbay.h", "Qdraw.h", "Qswap.h", "QThirtyFour.h",
  "Qusino.h", "qRWA.h", "QReservePool.h", "RandomLottery.h", "Pulse.h", "Escrow.h",
  "Nostromo.h", "QRaffle.h", "MyLastMatch.h", "SupplyWatcher.h", "VottunBridge.h",
  "ComputorControlledFund.h", "GeneralQuorumProposal.h",
];

// simple user-level fixtures
const FIXTURE_FILES = ["Counter.h", "Counter5.h", "Bank.h", "Token.h", "Vault.h", "Dividend.h", "Proxy.h", "DigestProbe.h", "BigState.h"];

function structName(src: string): string {
  const m = src.match(/struct\s+(\w+)\s*:\s*public\s+ContractBase/);
  return m ? m[1] : "Contract";
}

interface Row {
  name: string;
  parse: string;
  wasm: string;
  load: string;
  state: string;
}

async function sweepOne(path: string, displayName: string): Promise<Row> {
  const row: Row = { name: displayName, parse: "-", wasm: "-", load: "-", state: "-" };
  if (!existsSync(path)) {
    row.parse = "MISSING";
    return row;
  }
  const src = readFileSync(path, "utf8");
  const name = structName(src);

  let r;
  try {
    r = await compileContract({ source: src, name, slot: 28, qpiHeader: QPI, arenaSz: 64 * 1024 });
  } catch (e: any) {
    row.parse = "THROW:" + (e.message ?? "").slice(0, 30);
    return row;
  }

  const errs = r.diagnostics.filter((d) => d.severity === "error");
  row.parse = errs.length === 0 ? "ok" : `${errs.length} err`;
  row.wasm = r.wasm.byteLength > 0 ? `${r.wasm.byteLength}b` : "0";

  if (r.wasm.byteLength === 0) return row;

  try {
    const sim = new Sim();
    const c = sim.deploy(28, r.wasm);
    row.load = "ok";
    row.state = `${c.ex.state_size()}b`;
  } catch (e: any) {
    row.load = "FAIL";
  }
  return row;
}

beforeAll(async () => {
  await initK12();
});

test("conformance sweep — fixtures + system contracts", async () => {
  const rows: Row[] = [];

  for (const f of FIXTURE_FILES) {
    rows.push(await sweepOne(join(FIXTURES, f), f.replace(".h", "")));
  }
  rows.push({ name: "---", parse: "---", wasm: "---", load: "---", state: "---" });
  for (const spec of SYSTEM_FILES) {
    const [disp, file] = spec.includes("=") ? spec.split("=") : [spec.replace(".h", ""), spec];
    rows.push(await sweepOne(join(SYSTEM, file), disp));
  }

  // Print the table
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log("\n" + pad("CONTRACT", 22) + pad("PARSE", 10) + pad("WASM", 10) + pad("LOAD", 8) + "STATE");
  console.log("-".repeat(62));
  for (const r of rows) {
    console.log(pad(r.name, 22) + pad(r.parse, 10) + pad(r.wasm, 10) + pad(r.load, 8) + r.state);
  }

  const real = rows.filter((r) => r.name !== "---");
  const parsed = real.filter((r) => r.parse === "ok").length;
  const wasmd = real.filter((r) => r.wasm.endsWith("b")).length;
  const loaded = real.filter((r) => r.load === "ok").length;
  console.log("-".repeat(62));
  console.log(`TOTAL ${real.length}  ·  parsed ${parsed}  ·  wasm ${wasmd}  ·  engine-loaded ${loaded}\n`);

  // Always passes — this is a measurement, not a gate.
  expect(real.length).toBeGreaterThan(0);
});
