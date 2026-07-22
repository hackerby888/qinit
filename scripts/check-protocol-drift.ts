// Check that qinit's hand-mirrored protocol constants still match core-lite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm-slot-layout";
import { loadCoreWasmSlotLayout } from "../packages/core/src/wasm-slot-layout-node";
import {
  CHUNK_DATA_MAX,
  LITE_TX,
  LOG_SEVERITY,
  MAX_INPUT_SIZE,
} from "../packages/proto/src/protocol";

const core = process.env.QINIT_CORE;
if (!core) {
  console.error("QINIT_CORE not set");
  process.exit(2);
}

const failures: string[] = [];
try {
  const coreLayout = loadCoreWasmSlotLayout(core);
  if (
    coreLayout.slotBase !== DEFAULT_WASM_SLOT_LAYOUT.slotBase ||
    coreLayout.slotCount !== DEFAULT_WASM_SLOT_LAYOUT.slotCount
  ) {
    failures.push(
      `Wasm slot layout: core=${JSON.stringify(coreLayout)} qinit=${JSON.stringify(DEFAULT_WASM_SLOT_LAYOUT)}`,
    );
  }
} catch (error) {
  failures.push(`Wasm slot layout: ${error instanceof Error ? error.message : String(error)}`);
}

// Read `#define NAME <int>` while ignoring suffixes such as ULL.
const readDefine = (file: string, name: string): number | null => {
  try {
    const match = readFileSync(join(core, file), "utf8").match(
      new RegExp(`#define\\s+${name}\\s+(\\d+)`),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

// Read `constexpr <type> NAME = <int>;` declarations from a core header.
const readConstexpr = (file: string, name: string): number | null => {
  try {
    const match = readFileSync(join(core, file), "utf8").match(
      new RegExp(`constexpr\\s+\\w+\\s+${name}\\s*=\\s*(\\d+)`),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

const expectEqual = (label: string, actual: number | null, expected: number) => {
  if (actual !== expected) {
    failures.push(`${label}: core=${actual} qinit=${expected}`);
  }
};

const DEPLOYMENT_PROTOCOL = join("src", CORE_WASM_HEADERS.runtime.deploymentProtocol);
const LOG = "src/logging/logging.h";
const NET = "src/network_messages/common_def.h";

// LITE_TX deploy inputTypes
expectEqual(
  "LITE_TX_UPLOAD_BEGIN",
  readDefine(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_UPLOAD_BEGIN_INPUT_TYPE"),
  LITE_TX.UPLOAD_BEGIN,
);
expectEqual(
  "LITE_TX_UPLOAD_CHUNK",
  readDefine(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_UPLOAD_CHUNK_INPUT_TYPE"),
  LITE_TX.UPLOAD_CHUNK,
);
expectEqual(
  "LITE_TX_DEPLOY",
  readDefine(DEPLOYMENT_PROTOCOL, "WASM_DEPLOYMENT_DEPLOY_INPUT_TYPE"),
  LITE_TX.DEPLOY,
);

// contract LOG_* severity codes (core define value must equal the qinit map key, and the name be present)
for (const [code, symbol, name] of [
  [4, "CONTRACT_ERROR_MESSAGE", "ERROR"],
  [5, "CONTRACT_WARNING_MESSAGE", "WARN"],
  [6, "CONTRACT_INFORMATION_MESSAGE", "INFO"],
  [7, "CONTRACT_DEBUG_MESSAGE", "DEBUG"],
] as const) {
  expectEqual(symbol, readDefine(LOG, symbol), code);
  if (LOG_SEVERITY[code] !== name) {
    failures.push(`LOG_SEVERITY[${code}] = ${LOG_SEVERITY[code]} != ${name}`);
  }
}

// transaction input sizing: MAX_INPUT_SIZE must match; CHUNK_DATA_MAX must stay within core's limit.
expectEqual("MAX_INPUT_SIZE", readDefine(NET, "MAX_INPUT_SIZE"), MAX_INPUT_SIZE);
if (CHUNK_DATA_MAX > MAX_INPUT_SIZE - 14) {
  failures.push(
    `CHUNK_DATA_MAX ${CHUNK_DATA_MAX} exceeds MAX_INPUT_SIZE-header ${MAX_INPUT_SIZE - 14}`,
  );
}

// oracle query status codes — the engine's ORACLE_STATUS (sim.ts) is hand-mirrored from these constexprs.
for (const [name, value] of [
  ["ORACLE_QUERY_STATUS_UNKNOWN", 0],
  ["ORACLE_QUERY_STATUS_PENDING", 1],
  ["ORACLE_QUERY_STATUS_COMMITTED", 2],
  ["ORACLE_QUERY_STATUS_SUCCESS", 3],
  ["ORACLE_QUERY_STATUS_TIMEOUT", 4],
  ["ORACLE_QUERY_STATUS_UNRESOLVABLE", 5],
] as const) {
  expectEqual(name, readConstexpr(NET, name), value);
}

if (failures.length) {
  console.error("PROTOCOL DRIFT vs core-lite:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("protocol-drift OK — Wasm slots, LITE_TX, log severity, MAX_INPUT_SIZE, ORACLE_QUERY_STATUS match core");
