// Protocol drift guard: assert qinit's cross-boundary constants (packages/proto/src/protocol.ts) still match
// core-lite. These are hand-mirrored across two repos with no compile-time link, so a core change can silently
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm-slot-layout";
import { loadCoreWasmSlotLayout } from "../packages/core/src/wasm-slot-layout-node";
import { LITE_TX, LOG_SEVERITY, MAX_INPUT_SIZE, CHUNK_DATA_MAX } from "../packages/proto/src/protocol";

const core = process.env.QINIT_CORE;
if (!core) { console.error("QINIT_CORE not set"); process.exit(2); }

const fails: string[] = [];
try {
  const coreLayout = loadCoreWasmSlotLayout(core);
  if (
    coreLayout.slotBase !== DEFAULT_WASM_SLOT_LAYOUT.slotBase ||
    coreLayout.slotCount !== DEFAULT_WASM_SLOT_LAYOUT.slotCount
  ) {
    fails.push(
      `Wasm slot layout: core=${JSON.stringify(coreLayout)} qinit=${JSON.stringify(DEFAULT_WASM_SLOT_LAYOUT)}`,
    );
  }
} catch (error) {
  fails.push(`Wasm slot layout: ${error instanceof Error ? error.message : String(error)}`);
}
// read `#define NAME <int>` from a core header (ignores suffixes like ULL)
const def = (file: string, name: string): number | null => {
  try {
    const m = readFileSync(join(core, file), "utf8").match(new RegExp(`#define\\s+${name}\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
// read `constexpr <type> NAME = <int>;` from a core header (oracle status codes etc. are constexpr, not #define)
const cexpr = (file: string, name: string): number | null => {
  try {
    const m = readFileSync(join(core, file), "utf8").match(new RegExp(`constexpr\\s+\\w+\\s+${name}\\s*=\\s*(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
const eq = (label: string, got: number | null, want: number) => { if (got !== want) fails.push(`${label}: core=${got} qinit=${want}`); };

const DEPLOYMENT_PROTOCOL = join("src", CORE_WASM_HEADERS.runtime.deploymentProtocol);
const LOG = "src/logging/logging.h";
const NET = "src/network_messages/common_def.h";

// LITE_TX deploy inputTypes
eq(
  "LITE_TX_UPLOAD_BEGIN",
  def(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_UPLOAD_BEGIN_INPUT_TYPE"),
  LITE_TX.UPLOAD_BEGIN,
);
eq(
  "LITE_TX_UPLOAD_CHUNK",
  def(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_UPLOAD_CHUNK_INPUT_TYPE"),
  LITE_TX.UPLOAD_CHUNK,
);
eq(
  "LITE_TX_DEPLOY",
  def(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_DEPLOY_INPUT_TYPE"),
  LITE_TX.DEPLOY,
);

// contract LOG_* severity codes (core define value must equal the qinit map key, and the name be present)
for (const [code, sym, name] of [[4, "CONTRACT_ERROR_MESSAGE", "ERROR"], [5, "CONTRACT_WARNING_MESSAGE", "WARN"], [6, "CONTRACT_INFORMATION_MESSAGE", "INFO"], [7, "CONTRACT_DEBUG_MESSAGE", "DEBUG"]] as const) {
  eq(sym, def(LOG, sym), code);
  if (LOG_SEVERITY[code] !== name) fails.push(`LOG_SEVERITY[${code}] = ${LOG_SEVERITY[code]} != ${name}`);
}

// transaction input sizing: MAX_INPUT_SIZE must match; CHUNK_DATA_MAX must stay within core's limit.
eq("MAX_INPUT_SIZE", def(NET, "MAX_INPUT_SIZE"), MAX_INPUT_SIZE);
if (CHUNK_DATA_MAX > MAX_INPUT_SIZE - 14) fails.push(`CHUNK_DATA_MAX ${CHUNK_DATA_MAX} exceeds MAX_INPUT_SIZE-header ${MAX_INPUT_SIZE - 14}`);

// oracle query status codes — the engine's ORACLE_STATUS (sim.ts) is hand-mirrored from these constexprs.
for (const [name, val] of [["ORACLE_QUERY_STATUS_UNKNOWN", 0], ["ORACLE_QUERY_STATUS_PENDING", 1], ["ORACLE_QUERY_STATUS_COMMITTED", 2], ["ORACLE_QUERY_STATUS_SUCCESS", 3], ["ORACLE_QUERY_STATUS_TIMEOUT", 4], ["ORACLE_QUERY_STATUS_UNRESOLVABLE", 5]] as const) {
  eq(name, cexpr(NET, name), val);
}

if (fails.length) { console.error("PROTOCOL DRIFT vs core-lite:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("protocol-drift OK — Wasm slots, LITE_TX, log severity, MAX_INPUT_SIZE, ORACLE_QUERY_STATUS match core");
