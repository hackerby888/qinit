// CI deploy smoke: deploy the Counter contract (wasm) to a live node and prove read + write run
// on-chain — Get()=0 after INITIALIZE, Inc() tx, Get()=1. Exits non-zero on any mismatch. Run by
// .github/workflows/test.yml against a freshly built node. Needs QINIT_CORE + a ticking node on QINIT_RPC.
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { callFunction, invokeProcedure, decodeLog } from "../packages/proto/src/index";
import { extractIdl } from "../packages/build/src/index";
import { LiteRpc } from "../packages/core/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) { console.error("QINIT_CORE not set"); process.exit(2); }
const rpc = new LiteRpc(rpcBase);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string) => { console.error("SMOKE FAIL: " + m); process.exit(1); };

// callFunction(idx,1,"","uint64") returns the single uint64 (bigint); tolerate an object shape too.
const getVal = async (idx: number): Promise<bigint> => {
  const o: any = await callFunction(rpc, idx, 1, "", "uint64");
  const v = o && typeof o === "object" ? Object.values(o)[0] : o;
  return BigInt(v as any);
};

console.log("deploy Counter…");
const dep = await deployContract(
  { contractPath: resolve("fixtures/Counter.h"), name: "Counter", core, rpcBase },
  (e: any) => { if (!("note" in e)) console.log(`  ${e.step}: ${e.state}${e.detail ? " — " + e.detail : ""}`); },
);
if (!dep.ok || dep.slot == null) fail("deploy: " + JSON.stringify(dep));
const idx = dep.slot!;
console.log("deployed slot", idx);

// INITIALIZE runs at a deferred construct tick → poll until Get resolves to 0.
let v0 = -1n;
for (let i = 0; i < 15; i++) { try { v0 = await getVal(idx); if (v0 === 0n) break; } catch {} await sleep(1500); }
console.log("Get after deploy =", v0.toString());
if (v0 !== 0n) fail(`expected 0 after deploy, got ${v0}`);

// enable the debugger before the write so the Inc is captured — this exercises the mprotect dirty-page
// SIGSEGV handler in CI (a regression there crashes the node), the toggle RPC, and the trace pipeline.
console.log("enable debug…");
await rpc.setDebug(true);

const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const ti: any = await rpc.tickInfo();
const tick = (ti.tick ?? ti.currentTick ?? 0) + 6;
console.log("Inc @tick", tick);
const r: any = await invokeProcedure({ seed, rpcBase, contractIndex: idx, procId: 1, amount: 0, inFmt: "", tick, confirm: true, rpc });
if (!r.ok || !r.confirmed || !r.included) fail("Inc not confirmed/included: " + JSON.stringify(r));

let v1 = -1n;
for (let i = 0; i < 10; i++) { v1 = await getVal(idx); if (v1 === 1n) break; await sleep(1500); }
console.log("Get after Inc =", v1.toString());
if (v1 !== 1n) fail(`expected 1 after Inc, got ${v1}`);

// debug gate: the Inc proc must appear in the trace with the counter state diff (00 -> 01).
let dbgOk = false;
for (let i = 0; i < 8; i++) {
  const t = await rpc.debugTrace(0, 50);
  const inc = (t.entries ?? []).filter((e) => e.index === idx && e.kind === 1 && e.stateDiff.length).pop();
  if (inc) { console.log("debug: Inc stateDiff " + JSON.stringify(inc.stateDiff)); dbgOk = inc.stateDiff.some((d) => d.off === 0 && d.before === "00" && d.after === "01"); break; }
  await sleep(1500);
}
if (!dbgOk) fail("debug trace missing the Inc state diff (counter 00->01) — mprotect capture broken?");

// log-decode gate: deploy Logger, Emit(2) -> the trace must carry INFO logs decoded against the struct
// catalog WITH the _type enum name (LogValue). Exercises the node logs[] capture + client size-match decode.
console.log("deploy Logger…");
const depL = await deployContract(
  { contractPath: resolve("fixtures/Logger.h"), name: "Logger", core, rpcBase },
  (e: any) => { if (!("note" in e)) console.log(`  ${e.step}: ${e.state}${e.detail ? " — " + e.detail : ""}`); },
);
if (!depL.ok || depL.slot == null) fail("deploy Logger: " + JSON.stringify(depL));
const lidx = depL.slot!;
console.log("deployed Logger slot", lidx);
const idlL = extractIdl(readFileSync(resolve("fixtures/Logger.h"), "utf8"), "Logger");
const emapL: Record<string, string> = {};
for (const en of idlL.enums ?? []) Object.assign(emapL, en.members);
const tiL: any = await rpc.tickInfo();
const tickL = (tiL.tick ?? tiL.currentTick ?? 0) + 6;
console.log("Emit(2) @tick", tickL);
const rL: any = await invokeProcedure({ seed, rpcBase, contractIndex: lidx, procId: 1, amount: 0, inFmt: "2uint64", tick: tickL, confirm: true, rpc });
if (!rL.ok || !rL.confirmed) fail("Emit not confirmed: " + JSON.stringify(rL));
let logOk = false;
for (let i = 0; i < 10; i++) {
  const t = await rpc.debugTrace(0, 200);
  const emit = (t.entries ?? []).find((e) => e.index === lidx && e.kind === 1 && (e.logs?.length ?? 0) > 0);
  if (emit) {
    const l = emit.logs[0];
    const d = await decodeLog(l.type, l.size, l.hex, idlL.logStructs ?? [], emapL);
    console.log("log decode: " + JSON.stringify(d, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
    logOk = d.severity === "INFO" && d.name === "LogMsg" && d.fields?.value !== undefined && d.typeName === "LogValue";
    break;
  }
  await sleep(1500);
}
if (!logOk) fail("debug trace missing decoded LOG_* (logs[] wire / decode / enum-name broken?)");

await rpc.setDebug(false);
if (!(await rpc.tickInfo())) fail("node unresponsive after debug");   // node survived the SIGSEGV-handler path

console.log("SMOKE OK — deploy + read + write + debug-trace + log-decode verified on-chain (slots " + idx + "," + lidx + ")");
