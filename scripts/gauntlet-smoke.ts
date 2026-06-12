// QPI edge-case gauntlet: deploy fixtures/Gauntlet.h to a live node and assert a broad QPI surface
// runs correctly on-chain — div/mod incl. divide-by-zero, unsigned/signed wrap, bit ops, Array index
// masking, HashMap set/get/population, qpi.invocator/invocationReward, and qpi.K12. Exits non-zero on
// any mismatch. Run by CI (test.yml deploy-smoke) against a freshly built node; needs QINIT_CORE + a
// ticking node on QINIT_RPC. Harder counterpart to ci-deploy-smoke.ts's Counter Get->Inc->Get.
import { resolve } from "node:path";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { callFunction, invokeProcedure } from "../packages/proto/src/index";
import { LiteRpc, k12Hex, deriveIdentity, identityToBytes } from "../packages/core/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) { console.error("QINIT_CORE not set"); process.exit(2); }
const rpc = new LiteRpc(rpcBase);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string) => { console.error("GAUNTLET FAIL: " + m); process.exit(1); };

let pass = 0;
const eq = (got: unknown, want: unknown, label: string) => {
  const g = typeof got === "bigint" ? got.toString() : String(got);
  const w = typeof want === "bigint" ? want.toString() : String(want);
  if (g !== w) fail(`${label}: got ${g}, want ${w}`);
  pass++; console.log(`  ✓ ${label}`);
};
const ok = (cond: boolean, label: string) => { if (!cond) fail(label); pass++; console.log(`  ✓ ${label}`); };
const bytesToHex = (b: Uint8Array) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
const le8 = (v: bigint) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, v, true); return b; };

let idx = 0;
const cf = (fnId: number, inFmt: string, outFmt: string) => callFunction(rpc, idx, fnId, inFmt, outFmt);
async function proc(procId: number, inFmt: string, opts: { amount?: number; seed?: string } = {}) {
  const seed = opts.seed ?? (await rpc.fundedSeed()) ?? "a".repeat(55);
  const ti: any = await rpc.tickInfo();
  const tick = (ti.tick ?? ti.currentTick ?? 0) + 6;
  const r: any = await invokeProcedure({ seed, rpcBase, contractIndex: idx, procId, amount: opts.amount ?? 0, inFmt, tick, confirm: true, rpc });
  if (!r.ok || !r.confirmed || !r.included) fail(`proc ${procId} not confirmed/included: ${JSON.stringify(r)}`);
}
// poll a single-field read until it equals want (procedures land a few ticks after confirm)
async function pollEq(fnId: number, inFmt: string, outFmt: string, want: bigint, label: string) {
  for (let i = 0; i < 12; i++) { try { if (BigInt((await cf(fnId, inFmt, outFmt)) as any) === want) { eq(want, want, label); return; } } catch {} await sleep(1500); }
  eq(await cf(fnId, inFmt, outFmt), want, label);   // final attempt -> precise failure message
}

console.log("deploy Gauntlet…");
const dep = await deployContract(
  { contractPath: resolve("fixtures/Gauntlet.h"), name: "Gauntlet", core, rpcBase },
  (e: any) => { if (!("note" in e)) console.log(`  ${e.step}: ${e.state}${e.detail ? " — " + e.detail : ""}`); },
);
if (!dep.ok || dep.slot == null) fail("deploy: " + JSON.stringify(dep));
idx = dep.slot!;
console.log("deployed slot", idx);
for (let i = 0; i < 15; i++) { try { if (BigInt((await cf(5, "", "uint64")) as any) === 0n) break; } catch {} await sleep(1500); }

console.log("arithmetic edge cases…");
{
  let [q, r] = (await cf(1, "7uint64, 3uint64", "uint64, uint64")) as bigint[];
  eq(q, 2n, "DivMod 7 div 3 = 2"); eq(r, 1n, "DivMod 7 mod 3 = 1");
  [q, r] = (await cf(1, "7uint64, 0uint64", "uint64, uint64")) as bigint[];
  eq(q, 0n, "div by zero -> 0"); eq(r, 0n, "mod by zero -> 0");
  const [sum, prod, xorv, shl] = (await cf(2, "2uint64, 3uint64", "uint64, uint64, uint64, uint64")) as bigint[];
  eq(sum, 5n, "Arith sum 2+3"); eq(prod, 6n, "Arith prod 2*3"); eq(xorv, 1n, "Arith 2^3"); eq(shl, 16n, "Arith 2<<3");
  const MAX = (1n << 64n) - 1n;
  const [wrap] = (await cf(2, `${MAX}uint64, 1uint64`, "uint64, uint64, uint64, uint64")) as bigint[];
  eq(wrap, 0n, "uint64 add wraps (MAX+1=0)");
  let [sq, sr, ssum] = (await cf(3, "-7sint64, 2sint64", "sint64, sint64, sint64")) as bigint[];
  eq(sq, -3n, "signed -7 div 2 = -3"); eq(sr, -1n, "signed -7 mod 2 = -1"); eq(ssum, -5n, "signed -7+2 = -5");
  [sq, sr, ssum] = (await cf(3, "5sint64, 0sint64", "sint64, sint64, sint64")) as bigint[];
  eq(sq, 0n, "signed div by zero -> 0"); eq(sr, 0n, "signed mod by zero -> 0");
}

console.log("qpi.K12 hashing…");
{
  const h1 = (await cf(4, "1uint64", "id")) as string;
  const h1b = (await cf(4, "1uint64", "id")) as string;
  const h2 = (await cf(4, "2uint64", "id")) as string;
  ok(h1 === h1b, "K12 deterministic");
  ok(h1 !== h2, "K12 distinct for distinct inputs");
  eq(bytesToHex(identityToBytes(h1)), await k12Hex(le8(1n)), "K12(x) == qinit k12Hex(le8(x))");
}

console.log("state: Add / HashMap / Array masking / context…");
{
  // delta-based (re-runnable: a redeploy reuses the slot + its state, so assert against a baseline).
  const t0 = BigInt((await cf(5, "", "uint64")) as any);
  await proc(1, "10uint64"); await pollEq(5, "", "uint64", t0 + 10n, "Add 10 -> Total +10");
  await proc(1, "5uint64");  await pollEq(5, "", "uint64", t0 + 15n, "Add 5 -> Total +15");

  const p0 = BigInt((await cf(6, "", "uint64")) as any);
  const K = (await deriveIdentity("k".repeat(55))).identity;
  const other = (await deriveIdentity("z".repeat(55))).identity;
  await proc(2, `${K}id, 42uint64`); await pollEq(7, `${K}id`, "uint64", 42n, "Put(K,42) -> Bal(K) 42");
  eq(await cf(7, `${other}id`, "uint64"), 0n, "Bal(unset key) -> 0");
  ok(BigInt((await cf(8, "", "uint64")) as any) >= 1n, "HashMap population >= 1");
  await pollEq(6, "", "uint64", p0 + 1n, "Put -> PutCount +1");

  await proc(3, "2uint64, 99uint64"); await pollEq(9, "2uint64", "uint64", 99n, "SetSlot(2,99) -> Slot(2) 99");
  eq(await cf(9, "10uint64", "uint64"), 99n, "Slot(10) == Slot(2) (index masked & 7)");

  const seedR = (await rpc.fundedSeed()) ?? "a".repeat(55);
  await proc(4, "", { amount: 7, seed: seedR });
  let who = "", reward = -1n;
  for (let i = 0; i < 12; i++) { const [w, rw] = (await cf(10, "", "id, sint64")) as [string, bigint]; if (rw === 7n) { who = w; reward = rw; break; } await sleep(1500); }
  eq(who, (await deriveIdentity(seedR)).identity, "Remember -> LastCaller.who == sender (qpi.invocator)");
  eq(reward, 7n, "Remember -> LastCaller.reward == amount (qpi.invocationReward)");
}

console.log(`\nGAUNTLET OK — ${pass} assertions passed on-chain (slot ${idx})`);
