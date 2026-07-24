// Deploy Counter to a live node and prove its read, write, debug, and log paths.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { callFunction, invokeProcedure, decodeLog } from "../packages/proto/src/index";
import { extractIdl } from "../packages/build/src/index";
import { loadQpiHeader } from "../packages/compile/src/index";
import { LiteRpc } from "../packages/core/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) {
  console.error("QINIT_CORE not set");
  process.exit(2);
}
const rpc = new LiteRpc(rpcBase);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string) => {
  console.error("SMOKE FAIL: " + message);
  process.exit(1);
};

// Read Counter.Get while tolerating both scalar and named output shapes.
const readCounterValue = async (slot: number): Promise<bigint> => {
  const output: any = await callFunction(rpc, slot, 1, "", "uint64");
  const value = output && typeof output === "object" ? Object.values(output)[0] : output;
  return BigInt(value as any);
};

console.log("deploy Counter…");
const counterDeployment = await deployContract(
  { contractPath: resolve("fixtures/Counter.h"), name: "Counter", core, rpcBase },
  (event: any) => {
    if (!("note" in event)) {
      console.log(
        `  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`,
      );
    }
  },
);
if (!counterDeployment.ok || counterDeployment.slot == null) {
  fail("deploy: " + JSON.stringify(counterDeployment));
}
const counterSlot = counterDeployment.slot!;
console.log("deployed slot", counterSlot);

// INITIALIZE runs at a deferred construct tick → poll until Get resolves to 0.
let initialValue = -1n;
for (let i = 0; i < 15; i++) {
  try {
    initialValue = await readCounterValue(counterSlot);
    if (initialValue === 0n) {
      break;
    }
  } catch {}
  await sleep(1500);
}
console.log("Get after deploy =", initialValue.toString());
if (initialValue !== 0n) {
  fail(`expected 0 after deploy, got ${initialValue}`);
}

// Enable debugging before Inc to exercise dirty-page capture and trace transport.
console.log("enable debug…");
await rpc.setDebug(true);

const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tickInfo: any = await rpc.tickInfo();
const tick = (tickInfo.tick ?? tickInfo.currentTick ?? 0) + 6;
console.log("Inc @tick", tick);
const invocation: any = await invokeProcedure({
  seed,
  rpcBase,
  contractIndex: counterSlot,
  procId: 1,
  amount: 0,
  inFmt: "",
  tick,
  confirm: true,
  rpc,
});
if (!invocation.ok || !invocation.confirmed || !invocation.included) {
  fail("Inc not confirmed/included: " + JSON.stringify(invocation));
}

let updatedValue = -1n;
for (let i = 0; i < 10; i++) {
  updatedValue = await readCounterValue(counterSlot);
  if (updatedValue === 1n) {
    break;
  }
  await sleep(1500);
}
console.log("Get after Inc =", updatedValue.toString());
if (updatedValue !== 1n) {
  fail(`expected 1 after Inc, got ${updatedValue}`);
}

// debug gate: the Inc proc must appear in the trace with the counter state diff (00 -> 01).
let debugOk = false;
for (let i = 0; i < 8; i++) {
  const trace = await rpc.debugTrace(0, 50);
  const inc = (trace.entries ?? [])
    .filter(
      (entry) =>
        entry.index === counterSlot && entry.kind === 1 && entry.stateDiff.length,
    )
    .pop();
  if (inc) {
    console.log("debug: Inc stateDiff " + JSON.stringify(inc.stateDiff));
    debugOk = inc.stateDiff.some(
      (diff) => diff.off === 0 && diff.before === "00" && diff.after === "01",
    );
    break;
  }
  await sleep(1500);
}
if (!debugOk) {
  fail("debug trace missing the Inc state diff (counter 00->01) — mprotect capture broken?");
}

// Deploy Logger and verify that Emit(2) produces a decoded INFO log.
console.log("deploy Logger…");
const loggerDeployment = await deployContract(
  { contractPath: resolve("fixtures/Logger.h"), name: "Logger", core, rpcBase },
  (event: any) => {
    if (!("note" in event)) {
      console.log(
        `  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`,
      );
    }
  },
);
if (!loggerDeployment.ok || loggerDeployment.slot == null) {
  fail("deploy Logger: " + JSON.stringify(loggerDeployment));
}
const loggerSlot = loggerDeployment.slot!;
console.log("deployed Logger slot", loggerSlot);
const loggerIdl = extractIdl(
  readFileSync(resolve("fixtures/Logger.h"), "utf8"),
  "Logger",
  {
    slot: loggerSlot,
    qpiHeader: loadQpiHeader(core),
  },
);
const enumNames: Record<string, string> = {};
for (const entry of loggerIdl.enums ?? []) {
  Object.assign(enumNames, entry.members);
}
const loggerTickInfo: any = await rpc.tickInfo();
const loggerTick = (loggerTickInfo.tick ?? loggerTickInfo.currentTick ?? 0) + 6;
console.log("Emit(2) @tick", loggerTick);
const loggerInvocation: any = await invokeProcedure({
  seed,
  rpcBase,
  contractIndex: loggerSlot,
  procId: 1,
  amount: 0,
  inFmt: "2uint64",
  tick: loggerTick,
  confirm: true,
  rpc,
});
if (!loggerInvocation.ok || !loggerInvocation.confirmed) {
  fail("Emit not confirmed: " + JSON.stringify(loggerInvocation));
}
let decodedLogOk = false;
for (let i = 0; i < 10; i++) {
  const trace = await rpc.debugTrace(0, 200);
  const emit = (trace.entries ?? []).find(
    (entry) =>
      entry.index === loggerSlot && entry.kind === 1 && (entry.logs?.length ?? 0) > 0,
  );
  if (emit) {
    const log = emit.logs[0];
    const decoded = await decodeLog(
      log.type,
      log.size,
      log.hex,
      loggerIdl.logs,
      enumNames,
    );
    console.log(
      "log decode: " +
        JSON.stringify(decoded, (_key, value) =>
          typeof value === "bigint" ? value.toString() : value,
        ),
    );
    decodedLogOk =
      decoded.severity === "INFO" &&
      decoded.name === "LogMsg" &&
      decoded.fields?.value !== undefined &&
      decoded.typeName === "LogValue";
    break;
  }
  await sleep(1500);
}
if (!decodedLogOk) {
  fail("debug trace missing decoded LOG_* (logs[] wire / decode / enum-name broken?)");
}

await rpc.setDebug(false);
// Confirm the node survived the dirty-page capture path.
if (!(await rpc.tickInfo())) {
  fail("node unresponsive after debug");
}

console.log(
  `SMOKE OK — deploy + read + write + debug-trace + log-decode verified on-chain (slots ${counterSlot},${loggerSlot})`,
);
