// Check that qinit's hand-mirrored protocol constants still match core-lite.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_WASM_HEADERS } from "@qinit/core/wasm-headers";
import {
  CONTRACT_ENTRY_POINTS,
  SYSTEM_PROCEDURE_COUNT,
} from "@qinit/core/lhost-abi";
import { DEFAULT_WASM_SLOT_LAYOUT } from "@qinit/core/wasm-slot-layout";
import { loadCoreWasmSlotLayout } from "@qinit/core/wasm-slot-layout-node";
import { LITE_DEPLOY_ADDRESS } from "@qinit/core/tx";
import {
  DeployMessage,
  UploadBegin,
  UploadChunkHeader,
} from "@qinit/proto/deploy";
import {
  ASSETS_DEPTH,
  CHUNK_DATA_MAX,
  LITE_TX,
  LOG_SEVERITY,
  QUBIC_LOG_TYPE,
  MAINNET_COMPUTOR_COUNT,
  MAX_INPUT_SIZE,
  MAX_NUMBER_OF_CONTRACTS,
  MAX_ORACLE_QUERY_SIZE,
  MAX_ORACLE_REPLY_SIZE,
  ORACLE_STATUS,
  SPECTRUM_DEPTH,
  TXS_PER_TICK,
} from "@qinit/proto/protocol";

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
const readDefine = (
  file: string,
  name: string,
  occurrence: "first" | "last" = "first",
): number | null => {
  try {
    const matches = [
      ...readFileSync(join(core, file), "utf8").matchAll(
        new RegExp(`#define\\s+${name}\\s+(\\d+)`, "g"),
      ),
    ];
    const match = occurrence === "last" ? matches.at(-1) : matches[0];
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

// Read `constexpr <type> NAME = <int>;` declarations from a core header.
const readConstexpr = (
  file: string,
  name: string,
  symbols: Readonly<Record<string, number>> = {},
): number | null => {
  try {
    const expression = readFileSync(join(core, file), "utf8").match(
      new RegExp(`constexpr\\s+\\w+\\s+${name}\\s*=\\s*([^;]+)`),
    )?.[1].trim();
    if (!expression) return null;
    if (/^\d+$/.test(expression)) return Number(expression);

    for (const [symbol, value] of Object.entries(symbols)) {
      const offset = expression.match(new RegExp(`^${symbol}\\s*-\\s*(\\d+)$`))?.[1];
      if (offset) return value - Number(offset);
    }
    return null;
  } catch {
    return null;
  }
};

const readDeploymentAddress = (file: string): number | null => {
  try {
    const match = readFileSync(join(core, file), "utf8").match(
      /const\s+m256i\s+DeploymentAddress\s*\(\s*(\d+)(?:ULL)?\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/,
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

const readStructSize = (file: string, name: string): number | null => {
  try {
    const match = readFileSync(join(core, file), "utf8").match(
      new RegExp(`static_assert\\(sizeof\\(${name}\\)\\s*==\\s*(\\d+)`),
    );
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
};

const readEnumBody = (file: string, name: string): string | null => {
  try {
    return readFileSync(join(core, file), "utf8").match(
      new RegExp(`enum\\s+${name}\\s*\\{([\\s\\S]*?)\\}`),
    )?.[1] ?? null;
  } catch {
    return null;
  }
};

const readSystemProcedureCount = (file: string): number | null => {
  const body = readEnumBody(file, "SystemProcedureID");
  if (!body) return null;
  return body
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value && value !== "contractSystemProcedureCount")
    .length;
};

const readEntryPoint = (file: string, name: string): number | null => {
  const body = readEnumBody(file, "OtherEntryPointIDs");
  const offset = body?.match(
    new RegExp(`${name}\\s*=\\s*contractSystemProcedureCount\\s*\\+\\s*(\\d+)`),
  )?.[1];
  return offset ? SYSTEM_PROCEDURE_COUNT + Number(offset) : null;
};

const expectEqual = (label: string, actual: number | null, expected: number) => {
  if (actual !== expected) {
    failures.push(`${label}: core=${actual} qinit=${expected}`);
  }
};

const DEPLOYMENT_PROTOCOL = join("src", CORE_WASM_HEADERS.runtime.deploymentProtocol);
const LOG = "src/logging/logging.h";
const NET = "src/network_messages/common_def.h";
const CONTRACT_DEF = "src/contract_core/contract_def.h";

expectEqual(
  "contractSystemProcedureCount",
  readSystemProcedureCount(CONTRACT_DEF),
  SYSTEM_PROCEDURE_COUNT,
);
for (const [name, expected] of [
  ["USER_PROCEDURE_CALL", CONTRACT_ENTRY_POINTS.userProcedure],
  ["USER_FUNCTION_CALL", CONTRACT_ENTRY_POINTS.userFunction],
  [
    "REGISTER_USER_FUNCTIONS_AND_PROCEDURES_CALL",
    CONTRACT_ENTRY_POINTS.registerUserFunctionsAndProcedures,
  ],
  ["USER_PROCEDURE_NOTIFICATION_CALL", CONTRACT_ENTRY_POINTS.userProcedureNotification],
  ["MIGRATE_PROCEDURE_CALL", CONTRACT_ENTRY_POINTS.migrateProcedure],
] as const) {
  expectEqual(name, readEntryPoint(CONTRACT_DEF, name), expected);
}

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

const deployAddressView = new DataView(
  LITE_DEPLOY_ADDRESS.buffer,
  LITE_DEPLOY_ADDRESS.byteOffset,
  LITE_DEPLOY_ADDRESS.byteLength,
);
expectEqual(
  "LITE_DEPLOY_ADDRESS",
  readDeploymentAddress(DEPLOYMENT_PROTOCOL),
  Number(deployAddressView.getBigUint64(0, true)),
);
if (LITE_DEPLOY_ADDRESS.subarray(8).some((byte) => byte !== 0)) {
  failures.push("LITE_DEPLOY_ADDRESS: lanes 1-3 must be zero");
}

expectEqual(
  "UPLOAD_BEGIN_SIZE",
  readStructSize(DEPLOYMENT_PROTOCOL, "UploadBeginMessage"),
  UploadBegin.SIZE,
);
expectEqual(
  "UPLOAD_CHUNK_HEADER_SIZE",
  readStructSize(DEPLOYMENT_PROTOCOL, "UploadChunkHeader"),
  UploadChunkHeader.SIZE,
);
expectEqual(
  "DEPLOY_HEADER_SIZE",
  readStructSize(DEPLOYMENT_PROTOCOL, "DeployHeader"),
  DeployMessage.OFFSETS.name,
);
expectEqual(
  "DEPLOY_MESSAGE_SIZE",
  readStructSize(DEPLOYMENT_PROTOCOL, "DeployMessage"),
  DeployMessage.SIZE,
);

for (const [symbol, code] of Object.entries(QUBIC_LOG_TYPE)) {
  expectEqual(symbol, readDefine(LOG, symbol), code);
}

for (const [code, name] of [
  [QUBIC_LOG_TYPE.CONTRACT_ERROR_MESSAGE, "ERROR"],
  [QUBIC_LOG_TYPE.CONTRACT_WARNING_MESSAGE, "WARN"],
  [QUBIC_LOG_TYPE.CONTRACT_INFORMATION_MESSAGE, "INFO"],
  [QUBIC_LOG_TYPE.CONTRACT_DEBUG_MESSAGE, "DEBUG"],
] as const) {
  if (LOG_SEVERITY[code] !== name) {
    failures.push(`LOG_SEVERITY[${code}] = ${LOG_SEVERITY[code]} != ${name}`);
  }
}

// transaction input sizing: MAX_INPUT_SIZE must match; CHUNK_DATA_MAX must stay within core's limit.
expectEqual("MAX_INPUT_SIZE", readDefine(NET, "MAX_INPUT_SIZE"), MAX_INPUT_SIZE);
expectEqual(
  "MAX_NUMBER_OF_CONTRACTS",
  readDefine(NET, "MAX_NUMBER_OF_CONTRACTS"),
  MAX_NUMBER_OF_CONTRACTS,
);
expectEqual(
  "NUMBER_OF_TRANSACTIONS_PER_TICK",
  readDefine(NET, "NUMBER_OF_TRANSACTIONS_PER_TICK", "last"),
  TXS_PER_TICK,
);
expectEqual(
  "NUMBER_OF_COMPUTORS (mainnet)",
  readDefine(NET, "NUMBER_OF_COMPUTORS", "last"),
  MAINNET_COMPUTOR_COUNT,
);
expectEqual(
  "SPECTRUM_DEPTH (mainnet)",
  readDefine(NET, "SPECTRUM_DEPTH", "last"),
  SPECTRUM_DEPTH,
);
expectEqual(
  "ASSETS_DEPTH (mainnet)",
  readDefine(NET, "ASSETS_DEPTH", "last"),
  ASSETS_DEPTH,
);
if (CHUNK_DATA_MAX > MAX_INPUT_SIZE - UploadChunkHeader.SIZE) {
  failures.push(
    `CHUNK_DATA_MAX ${CHUNK_DATA_MAX} exceeds MAX_INPUT_SIZE-header ${MAX_INPUT_SIZE - UploadChunkHeader.SIZE}`,
  );
}

expectEqual(
  "MAX_ORACLE_QUERY_SIZE",
  readConstexpr(NET, "MAX_ORACLE_QUERY_SIZE", { MAX_INPUT_SIZE }),
  MAX_ORACLE_QUERY_SIZE,
);
expectEqual(
  "MAX_ORACLE_REPLY_SIZE",
  readConstexpr(NET, "MAX_ORACLE_REPLY_SIZE", { MAX_INPUT_SIZE }),
  MAX_ORACLE_REPLY_SIZE,
);

// Oracle query statuses are mirrored by the simulator.
for (const [name, value] of [
  ["ORACLE_QUERY_STATUS_UNKNOWN", ORACLE_STATUS.UNKNOWN],
  ["ORACLE_QUERY_STATUS_PENDING", ORACLE_STATUS.PENDING],
  ["ORACLE_QUERY_STATUS_COMMITTED", ORACLE_STATUS.COMMITTED],
  ["ORACLE_QUERY_STATUS_SUCCESS", ORACLE_STATUS.SUCCESS],
  ["ORACLE_QUERY_STATUS_TIMEOUT", ORACLE_STATUS.TIMEOUT],
  ["ORACLE_QUERY_STATUS_UNRESOLVABLE", ORACLE_STATUS.UNRESOLVABLE],
] as const) {
  expectEqual(name, readConstexpr(NET, name), value);
}

if (failures.length) {
  console.error("PROTOCOL DRIFT vs core-lite:\n  " + failures.join("\n  "));
  process.exit(1);
}
console.log("protocol-drift OK — ABI, deployment, logging, network limits, and oracle constants match core");
