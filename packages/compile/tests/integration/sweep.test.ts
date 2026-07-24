import { DiagnosticSeverity } from "../../src/enums";
import { CORE_PATH, QINIT_ROOT } from "../../../../test-utils/paths";
// Measures parse, Wasm, engine-load, and state-size coverage across the corpus.
import { test, expect, beforeAll } from "bun:test";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";
import { parseContractIdl } from "../../../proto/src/contract-idl";
import {
  compileContract,
  loadQpiHeader,
  type ContractIdl,
  type CompileResult,
} from "../../src/index";

const QPI = loadQpiHeader(CORE_PATH);

const FIXTURES = QINIT_ROOT + "/fixtures";
const SYSTEM = CORE_PATH + "/src/contracts";

// system contract files (exclude headers/templates/old/test variants)
const SYSTEM_FILES = [
  "Qx.h",
  "Quottery.h",
  "Random.h",
  "QUtil.h",
  "QEARN=Qearn.h",
  "QVAULT.h",
  "MsVault.h",
  "GGWP.h",
  "QIP.h",
  "QBond.h",
  "QDuel.h",
  "Qbay.h",
  "Qdraw.h",
  "Qswap.h",
  "QThirtyFour.h",
  "Qusino.h",
  "qRWA.h",
  "QReservePool.h",
  "RandomLottery.h",
  "Pulse.h",
  "Escrow.h",
  "Nostromo.h",
  "QRaffle.h",
  "MyLastMatch.h",
  "SupplyWatcher.h",
  "VottunBridge.h",
  "ComputorControlledFund.h",
  "GeneralQuorumProposal.h",
];

// simple user-level fixtures
const FIXTURE_FILES = [
  "Counter.h",
  "Counter5.h",
  "Bank.h",
  "Token.h",
  "Vault.h",
  "Dividend.h",
  "Proxy.h",
  "DigestProbe.h",
  "BigState.h",
];

interface DependencySpec {
  name: string;
  path: string;
  slot: number;
}

const DEPENDENCIES: Record<string, DependencySpec> = {
  Counter: { name: "Counter", path: join(FIXTURES, "Counter.h"), slot: 28 },
  QX: { name: "QX", path: join(SYSTEM, "Qx.h"), slot: 1 },
  RANDOM: { name: "RANDOM", path: join(SYSTEM, "Random.h"), slot: 3 },
  QEARN: { name: "QEARN", path: join(SYSTEM, "Qearn.h"), slot: 9 },
  RL: { name: "RL", path: join(SYSTEM, "RandomLottery.h"), slot: 16 },
  QRP: { name: "QRP", path: join(SYSTEM, "QReservePool.h"), slot: 21 },
  QTF: { name: "QTF", path: join(SYSTEM, "QThirtyFour.h"), slot: 22 },
};

// Inter-contract source needs both the callee IDL (ABI sizes/entry IDs) and source (qualified constants/helpers).
// Keep dependency order topological because later callees may themselves call earlier ones.
const LINKED_DEPENDENCIES: Record<string, string[]> = {
  Proxy: ["Counter"],
  QUtil: ["QX"],
  QVAULT: ["QX", "QEARN"],
  MsVault: ["QX"],
  QBond: ["QEARN"],
  QDuel: ["RANDOM", "RL"],
  Qbay: ["QX"],
  Qswap: ["QX"],
  QThirtyFour: ["RANDOM", "RL", "QRP"],
  QReservePool: ["RANDOM", "RL"],
  RandomLottery: ["RANDOM"],
  Pulse: ["RANDOM", "RL", "QRP", "QTF", "QX"],
  Nostromo: ["QX"],
};

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
  errors: string[];
}

function calleeIdlFrom(name: string, slot: number, result: CompileResult): ContractIdl {
  if (!result.idl) {
    throw new Error(`missing IDL for callee '${name}'`);
  }

  return {
    ...result.idl,
    name,
    slot,
  };
}

async function sweepOne(path: string, displayName: string): Promise<Row> {
  const row: Row = { name: displayName, parse: "-", wasm: "-", load: "-", state: "-", errors: [] };
  if (!existsSync(path)) {
    row.parse = "MISSING";
    row.errors.push(`missing source: ${path}`);
    return row;
  }
  const src = readFileSync(path, "utf8");
  const name = structName(src);
  const dependencyNames = LINKED_DEPENDENCIES[displayName] ?? [];
  const dependencyResults: CompileResult[] = [];

  let r;
  try {
    for (const dependencyName of dependencyNames) {
      const dependency = DEPENDENCIES[dependencyName];
      if (!dependency) throw new Error(`unknown sweep dependency '${dependencyName}'`);
      const priorNames = dependencyNames.slice(0, dependencyResults.length);
      const priorIdl = priorNames.map((priorName, index) => {
        const prior = DEPENDENCIES[priorName];
        return calleeIdlFrom(prior.name, prior.slot, dependencyResults[index]);
      });
      const priorSources = priorNames.map((priorName) => {
        const prior = DEPENDENCIES[priorName];
        return { name: prior.name, source: readFileSync(prior.path, "utf8") };
      });
      const dependencyResult = await compileContract({
        source: readFileSync(dependency.path, "utf8"),
        name: dependency.name,
        slot: dependency.slot,
        qpiHeader: QPI,
        arenaSz: 64 * 1024,
        callees: priorIdl.length ? priorIdl : undefined,
        calleeSources: priorSources.length ? priorSources : undefined,
      });
      const dependencyErrors = dependencyResult.diagnostics.filter(
        (diagnostic) => diagnostic.severity === DiagnosticSeverity.ERROR,
      );
      if (dependencyErrors.length) {
        throw new Error(
          `${dependency.name}: ${dependencyErrors.map((diagnostic) => `L${diagnostic.span.line} ${diagnostic.message}`).join("; ")}`,
        );
      }
      dependencyResults.push(dependencyResult);
    }
    const callees = dependencyNames.map((dependencyName, index) => {
      const dependency = DEPENDENCIES[dependencyName];
      return calleeIdlFrom(dependency.name, dependency.slot, dependencyResults[index]);
    });
    const calleeSources = dependencyNames.map((dependencyName) => {
      const dependency = DEPENDENCIES[dependencyName];
      return { name: dependency.name, source: readFileSync(dependency.path, "utf8") };
    });
    r = await compileContract({
      source: src,
      name,
      slot: 28,
      qpiHeader: QPI,
      arenaSz: 64 * 1024,
      callees: callees.length ? callees : undefined,
      calleeSources: calleeSources.length ? calleeSources : undefined,
    });
  } catch (e: any) {
    row.parse = "THROW:" + (e.message ?? "").slice(0, 30);
    row.errors.push(e.message ?? String(e));
    return row;
  }

  const errs = r.diagnostics.filter((d) => d.severity === DiagnosticSeverity.ERROR);
  row.errors.push(...errs.map((diagnostic) => `L${diagnostic.span.line} ${diagnostic.message}`));
  if (errs.length > 0) {
    row.parse = `${errs.length} err`;
  } else {
    try {
      parseContractIdl(r.idl);
      row.parse = "ok";
    } catch (error: any) {
      row.parse = "IDL err";
      row.errors.push(`IDL: ${error.message ?? String(error)}`);
    }
  }
  row.wasm = r.wasm.byteLength > 0 ? `${r.wasm.byteLength}b` : "0";

  if (r.wasm.byteLength === 0) return row;

  try {
    const sim = new Sim();
    const c = sim.deploy(28, r.wasm);
    row.load = "ok";
    row.state = `${c.ex.state_size()}b`;
  } catch (e: any) {
    row.load = "FAIL";
    row.errors.push(`engine load: ${e.message ?? String(e)}`);
  }
  return row;
}

beforeAll(async () => {
  await initK12();
});

test("conformance sweep — fixtures + system contracts", async () => {
  const rows: Row[] = [];

  const declaredTargets = new Set([
    ...FIXTURE_FILES.map((file) => file.replace(".h", "")),
    ...SYSTEM_FILES.map((spec) =>
      spec.includes("=") ? spec.split("=")[0] : spec.replace(".h", ""),
    ),
  ]);
  expect(Object.keys(LINKED_DEPENDENCIES).filter((name) => !declaredTargets.has(name))).toEqual([]);
  expect(
    Object.values(LINKED_DEPENDENCIES)
      .flat()
      .filter((name) => !(name in DEPENDENCIES)),
  ).toEqual([]);

  for (const f of FIXTURE_FILES) {
    rows.push(await sweepOne(join(FIXTURES, f), f.replace(".h", "")));
  }
  rows.push({ name: "---", parse: "---", wasm: "---", load: "---", state: "---", errors: [] });
  for (const spec of SYSTEM_FILES) {
    const [disp, file] = spec.includes("=") ? spec.split("=") : [spec.replace(".h", ""), spec];
    rows.push(await sweepOne(join(SYSTEM, file), disp));
  }

  // Print the table
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    "\n" + pad("CONTRACT", 22) + pad("PARSE", 10) + pad("WASM", 10) + pad("LOAD", 8) + "STATE",
  );
  console.log("-".repeat(62));
  for (const r of rows) {
    console.log(pad(r.name, 22) + pad(r.parse, 10) + pad(r.wasm, 10) + pad(r.load, 8) + r.state);
  }

  const real = rows.filter((r) => r.name !== "---");
  const parsed = real.filter((r) => r.parse === "ok").length;
  const wasmd = real.filter((r) => r.wasm.endsWith("b")).length;
  const loaded = real.filter((r) => r.load === "ok").length;
  const failures = real.filter(
    (row) => row.parse !== "ok" || !row.wasm.endsWith("b") || row.load !== "ok",
  );
  const failureReport = failures
    .map((row) => `${row.name}: ${row.errors.join("; ") || `${row.parse}/${row.wasm}/${row.load}`}`)
    .join("\n");
  console.log("-".repeat(62));
  console.log(
    `TOTAL ${real.length}  ·  parsed ${parsed}  ·  wasm ${wasmd}  ·  engine-loaded ${loaded}\n`,
  );

  // Dependency-aware coverage is deterministic, so drift is now a gating failure rather than a table-only measurement.
  expect(
    failures.map((row) => row.name),
    failureReport,
  ).toEqual([]);
  expect({ parsed, wasmd, loaded }).toEqual({
    parsed: real.length,
    wasmd: real.length,
    loaded: real.length,
  });
}, 30_000);
