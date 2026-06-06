// CI: compile the fixture corpus (+ the real QX/QEARN) to wasm against $QINIT_CORE. Fails if any contract no
// longer builds — catches core header / qpi.h / ABI drift from the qinit side. Run by .github/workflows/test.yml.
// Needs: QINIT_CORE (a core-lite checkout), WASM_CLANG + WASI_SYSROOT (wasi-sdk).
import { resolve } from "node:path";
import { buildContract } from "../packages/build/src/index";

const core = process.env.QINIT_CORE;
if (!core) { console.error("QINIT_CORE not set"); process.exit(2); }
const fx = (n: string) => resolve("fixtures", n);   // wrapper #includes the path verbatim -> must be absolute

type Callees = Record<string, { header: string; index: number }>;
const corpus: { name: string; path: string; dynCallees?: Callees; skipVerify?: boolean }[] = [
  { name: "Counter", path: fx("Counter.h") },
  { name: "Token", path: fx("Token.h") },
  // compile-only: exercises the SET_SHAREHOLDER_PROPOSAL sysproc macro, which the upstream verifier can't parse.
  { name: "ShareReceiver", path: fx("ShareReceiver.h"), skipVerify: true },
  { name: "BigState", path: fx("BigState.h") },
  { name: "Proxy", path: fx("Proxy.h"), dynCallees: { Counter: { header: fx("Counter.h"), index: 28 } } },
  { name: "QX", path: core + "/src/contracts/Qx.h" },
  { name: "QEARN", path: core + "/src/contracts/Qearn.h" },
];

let failed = 0;
for (const c of corpus) {
  // Proxy (slot 29) calls Counter (slot 28): caller index must be > callee.
  const r = await buildContract({ contractPath: c.path, name: c.name, slot: 29, corePath: core, outDir: "/tmp/corpus", dynCallees: c.dynCallees, skipVerify: c.skipVerify });
  if (r.ok) {
    console.log(`OK   ${c.name}  ${r.size ?? "?"}B`);
  } else {
    failed++;
    console.log(`FAIL ${c.name}`);
    console.log((r.stderr ?? "").split("\n").filter((l) => /error:|protocol|fatal/.test(l)).slice(0, 8).map((l) => "     " + l).join("\n"));
  }
}
if (failed) { console.error(`\n${failed} contract(s) failed to build against core — drift?`); process.exit(1); }
console.log("\ncorpus OK — all contracts build against core");
