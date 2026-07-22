// Deploy the QPI edge-case fixture and verify its behavior on-chain.
import { resolve } from "node:path";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { callFunction, invokeProcedure } from "../packages/proto/src/index";
import { LiteRpc, k12Hex, deriveIdentity, identityToBytes } from "../packages/core/src/index";

const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const core = process.env.QINIT_CORE;
if (!core) {
  console.error("QINIT_CORE not set");
  process.exit(2);
}
const rpc = new LiteRpc(rpcBase);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fail = (message: string) => {
  console.error("GAUNTLET FAIL: " + message);
  process.exit(1);
};

let passedAssertions = 0;
const expectEqual = (got: unknown, want: unknown, label: string) => {
  const g = typeof got === "bigint" ? got.toString() : String(got);
  const w = typeof want === "bigint" ? want.toString() : String(want);
  if (g !== w) {
    fail(`${label}: got ${g}, want ${w}`);
  }
  passedAssertions++;
  console.log(`  ✓ ${label}`);
};
const expectTrue = (condition: boolean, label: string) => {
  if (!condition) {
    fail(label);
  }
  passedAssertions++;
  console.log(`  ✓ ${label}`);
};
const bytesToHex = (bytes: Uint8Array) =>
  Array.from(bytes)
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
const le8 = (value: bigint) => {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, value, true);
  return bytes;
};

let contractSlot = 0;
const call = (fnId: number, inFmt: string, outFmt: string) =>
  callFunction(rpc, contractSlot, fnId, inFmt, outFmt);
async function invoke(procId: number, inFmt: string, opts: { amount?: number; seed?: string } = {}) {
  const seed = opts.seed ?? (await rpc.fundedSeed()) ?? "a".repeat(55);
  const tickInfo: any = await rpc.tickInfo();
  const tick = (tickInfo.tick ?? tickInfo.currentTick ?? 0) + 6;
  const result: any = await invokeProcedure({
    seed,
    rpcBase,
    contractIndex: contractSlot,
    procId,
    amount: opts.amount ?? 0,
    inFmt,
    tick,
    confirm: true,
    rpc,
  });
  if (!result.ok || !result.confirmed || !result.included) {
    fail(`proc ${procId} not confirmed/included: ${JSON.stringify(result)}`);
  }
}

// poll a single-field read until it equals want (procedures land a few ticks after confirm)
async function pollUntilEqual(
  fnId: number,
  inFmt: string,
  outFmt: string,
  want: bigint,
  label: string,
) {
  for (let i = 0; i < 12; i++) {
    try {
      if (BigInt((await call(fnId, inFmt, outFmt)) as any) === want) {
        expectEqual(want, want, label);
        return;
      }
    } catch {}
    await sleep(1500);
  }

  // The final attempt produces the precise failure message.
  expectEqual(await call(fnId, inFmt, outFmt), want, label);
}

console.log("deploy Gauntlet…");
const dep = await deployContract(
  { contractPath: resolve("fixtures/Gauntlet.h"), name: "Gauntlet", core, rpcBase },
  (event: any) => {
    if (!("note" in event)) {
      console.log(
        `  ${event.step}: ${event.state}${event.detail ? " — " + event.detail : ""}`,
      );
    }
  },
);
if (!dep.ok || dep.slot == null) fail("deploy: " + JSON.stringify(dep));
contractSlot = dep.slot!;
console.log("deployed slot", contractSlot);
for (let i = 0; i < 15; i++) {
  try {
    if (BigInt((await call(5, "", "uint64")) as any) === 0n) {
      break;
    }
  } catch {}
  await sleep(1500);
}

console.log("arithmetic edge cases…");
{
  let [q, r] = (await call(1, "7uint64, 3uint64", "uint64, uint64")) as bigint[];
  expectEqual(q, 2n, "DivMod 7 div 3 = 2");
  expectEqual(r, 1n, "DivMod 7 mod 3 = 1");
  [q, r] = (await call(1, "7uint64, 0uint64", "uint64, uint64")) as bigint[];
  expectEqual(q, 0n, "div by zero -> 0");
  expectEqual(r, 0n, "mod by zero -> 0");
  const [sum, prod, xorv, shl] = (await call(
    2,
    "2uint64, 3uint64",
    "uint64, uint64, uint64, uint64",
  )) as bigint[];
  expectEqual(sum, 5n, "Arith sum 2+3");
  expectEqual(prod, 6n, "Arith prod 2*3");
  expectEqual(xorv, 1n, "Arith 2^3");
  expectEqual(shl, 16n, "Arith 2<<3");
  const maxUint64 = (1n << 64n) - 1n;
  const [wrap] = (await call(
    2,
    `${maxUint64}uint64, 1uint64`,
    "uint64, uint64, uint64, uint64",
  )) as bigint[];
  expectEqual(wrap, 0n, "uint64 add wraps (MAX+1=0)");
  let [sq, sr, ssum] = (await call(
    3,
    "-7sint64, 2sint64",
    "sint64, sint64, sint64",
  )) as bigint[];
  expectEqual(sq, -3n, "signed -7 div 2 = -3");
  expectEqual(sr, -1n, "signed -7 mod 2 = -1");
  expectEqual(ssum, -5n, "signed -7+2 = -5");
  [sq, sr, ssum] = (await call(
    3,
    "5sint64, 0sint64",
    "sint64, sint64, sint64",
  )) as bigint[];
  expectEqual(sq, 0n, "signed div by zero -> 0");
  expectEqual(sr, 0n, "signed mod by zero -> 0");
}

console.log("qpi.K12 hashing…");
{
  const h1 = (await call(4, "1uint64", "id")) as string;
  const h1b = (await call(4, "1uint64", "id")) as string;
  const h2 = (await call(4, "2uint64", "id")) as string;
  expectTrue(h1 === h1b, "K12 deterministic");
  expectTrue(h1 !== h2, "K12 distinct for distinct inputs");
  expectEqual(
    bytesToHex(identityToBytes(h1)),
    await k12Hex(le8(1n)),
    "K12(x) == qinit k12Hex(le8(x))",
  );
}

console.log("state: Add / HashMap / Array masking / context…");
{
  // delta-based (re-runnable: a redeploy reuses the slot + its state, so assert against a baseline).
  const totalBefore = BigInt((await call(5, "", "uint64")) as any);
  await invoke(1, "10uint64");
  await pollUntilEqual(5, "", "uint64", totalBefore + 10n, "Add 10 -> Total +10");
  await invoke(1, "5uint64");
  await pollUntilEqual(5, "", "uint64", totalBefore + 15n, "Add 5 -> Total +15");

  const putCountBefore = BigInt((await call(6, "", "uint64")) as any);
  const key = (await deriveIdentity("k".repeat(55))).identity;
  const other = (await deriveIdentity("z".repeat(55))).identity;
  await invoke(2, `${key}id, 42uint64`);
  await pollUntilEqual(7, `${key}id`, "uint64", 42n, "Put(K,42) -> Bal(K) 42");
  expectEqual(await call(7, `${other}id`, "uint64"), 0n, "Bal(unset key) -> 0");
  expectTrue(
    BigInt((await call(8, "", "uint64")) as any) >= 1n,
    "HashMap population >= 1",
  );
  await pollUntilEqual(6, "", "uint64", putCountBefore + 1n, "Put -> PutCount +1");

  await invoke(3, "2uint64, 99uint64");
  await pollUntilEqual(9, "2uint64", "uint64", 99n, "SetSlot(2,99) -> Slot(2) 99");
  expectEqual(
    await call(9, "10uint64", "uint64"),
    99n,
    "Slot(10) == Slot(2) (index masked & 7)",
  );

  const senderSeed = (await rpc.fundedSeed()) ?? "a".repeat(55);
  await invoke(4, "", { amount: 7, seed: senderSeed });
  let who = "";
  let reward = -1n;
  for (let i = 0; i < 12; i++) {
    const [currentWho, currentReward] = (await call(10, "", "id, sint64")) as [
      string,
      bigint,
    ];
    if (currentReward === 7n) {
      who = currentWho;
      reward = currentReward;
      break;
    }
    await sleep(1500);
  }
  expectEqual(
    who,
    (await deriveIdentity(senderSeed)).identity,
    "Remember -> LastCaller.who == sender (qpi.invocator)",
  );
  expectEqual(reward, 7n, "Remember -> LastCaller.reward == amount (qpi.invocationReward)");
}

console.log(
  `\nGAUNTLET OK — ${passedAssertions} assertions passed on-chain (slot ${contractSlot})`,
);
