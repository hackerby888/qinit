// Compile the fixture corpus and QX/QEARN against core-lite to catch ABI drift.
import { resolve } from "node:path";
import { buildContract } from "../packages/build/src/index";

const core = process.env.QINIT_CORE;
if (!core) {
  console.error("QINIT_CORE not set");
  process.exit(2);
}

// Generated wrappers include this path verbatim, so it must be absolute.
const fixturePath = (name: string) => resolve("fixtures", name);

type Callees = Record<string, { header: string; index: number }>;
const corpus: { name: string; path: string; dynCallees?: Callees; skipVerify?: boolean }[] = [
  { name: "Counter", path: fixturePath("Counter.h") },
  { name: "Token", path: fixturePath("Token.h") },
  // compile-only: exercises the SET_SHAREHOLDER_PROPOSAL sysproc macro, which the upstream verifier can't parse.
  { name: "ShareReceiver", path: fixturePath("ShareReceiver.h"), skipVerify: true },
  // exercises the acquireShares lhost binding (the share management-rights wasm import).
  { name: "ShareManager", path: fixturePath("ShareManager.h"), skipVerify: true },
  // the approve side: implements the PRE_RELEASE_SHARES callback.
  { name: "ShareApprover", path: fixturePath("ShareApprover.h"), skipVerify: true },
  // exercises the rest of the newly-exposed qpi wasm imports (dayOfWeek, signatureValidity, IPO/mining/oracle).
  { name: "ApiProbe", path: fixturePath("ApiProbe.h"), skipVerify: true },
  { name: "OracleProbe", path: fixturePath("OracleProbe.h"), skipVerify: true },
  { name: "BigState", path: fixturePath("BigState.h") },
  {
    name: "Proxy",
    path: fixturePath("Proxy.h"),
    dynCallees: { Counter: { header: fixturePath("Counter.h"), index: 28 } },
  },
  { name: "QX", path: core + "/src/contracts/Qx.h" },
  { name: "QEARN", path: core + "/src/contracts/Qearn.h" },
];

let failed = 0;
for (const contract of corpus) {
  // Proxy (slot 29) calls Counter (slot 28): caller index must be > callee.
  const result = await buildContract({
    contractPath: contract.path,
    name: contract.name,
    slot: 29,
    corePath: core,
    outDir: "/tmp/corpus",
    dynCallees: contract.dynCallees,
    skipVerify: contract.skipVerify,
  });
  if (result.ok) {
    console.log(`OK   ${contract.name}  ${result.size ?? "?"}B`);
  } else {
    failed++;
    console.log(`FAIL ${contract.name}`);
    console.log(
      (result.stderr ?? "")
        .split("\n")
        .filter((line) => /error:|protocol|fatal/.test(line))
        .slice(0, 8)
        .map((line) => "     " + line)
        .join("\n"),
    );
  }
}
if (failed) {
  console.error(`\n${failed} contract(s) failed to build against core — drift?`);
  process.exit(1);
}
console.log("\ncorpus OK — all contracts build against core");
