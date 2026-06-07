// Protocol drift guard: assert qinit's cross-boundary constants (packages/proto/src/protocol.ts) still match
// core-lite. These are hand-mirrored across two repos with no compile-time link, so a core change can silently
// break the wire. Run in CI where core is checked out (QINIT_CORE). Exits non-zero on any mismatch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LITE_TX, LOG_SEVERITY, MAX_INPUT_SIZE, CHUNK_DATA_MAX } from "../packages/proto/src/protocol";

const core = process.env.QINIT_CORE;
if (!core) { console.error("QINIT_CORE not set"); process.exit(2); }

const fails: string[] = [];
// read `#define NAME <int>` from a core header (ignores suffixes like ULL)
const def = (file: string, name: string): number | null => {
  try {
    const m = readFileSync(join(core, file), "utf8").match(new RegExp(`#define\\s+${name}\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  } catch { return null; }
};
const eq = (label: string, got: number | null, want: number) => { if (got !== want) fails.push(`${label}: core=${got} qinit=${want}`); };

const DYN = "src/extensions/lite_dynamic_contracts.h";
const LOG = "src/logging/logging.h";
const NET = "src/network_messages/common_def.h";

// LITE_TX deploy inputTypes
eq("LITE_TX_UPLOAD_BEGIN", def(DYN, "LITE_TX_UPLOAD_BEGIN"), LITE_TX.UPLOAD_BEGIN);
eq("LITE_TX_UPLOAD_CHUNK", def(DYN, "LITE_TX_UPLOAD_CHUNK"), LITE_TX.UPLOAD_CHUNK);
eq("LITE_TX_DEPLOY", def(DYN, "LITE_TX_DEPLOY"), LITE_TX.DEPLOY);

// contract LOG_* severity codes (core define value must equal the qinit map key, and the name be present)
for (const [code, sym, name] of [[4, "CONTRACT_ERROR_MESSAGE", "ERROR"], [5, "CONTRACT_WARNING_MESSAGE", "WARN"], [6, "CONTRACT_INFORMATION_MESSAGE", "INFO"], [7, "CONTRACT_DEBUG_MESSAGE", "DEBUG"]] as const) {
  eq(sym, def(LOG, sym), code);
  if (LOG_SEVERITY[code] !== name) fails.push(`LOG_SEVERITY[${code}] = ${LOG_SEVERITY[code]} != ${name}`);
}

// transaction input sizing: MAX_INPUT_SIZE must match; CHUNK_DATA_MAX must stay within core's limit.
eq("MAX_INPUT_SIZE", def(NET, "MAX_INPUT_SIZE"), MAX_INPUT_SIZE);
if (CHUNK_DATA_MAX > MAX_INPUT_SIZE - 14) fails.push(`CHUNK_DATA_MAX ${CHUNK_DATA_MAX} exceeds MAX_INPUT_SIZE-header ${MAX_INPUT_SIZE - 14}`);

if (fails.length) { console.error("PROTOCOL DRIFT vs core-lite:\n  " + fails.join("\n  ")); process.exit(1); }
console.log("protocol-drift OK — LITE_TX, log severity, MAX_INPUT_SIZE match core");
