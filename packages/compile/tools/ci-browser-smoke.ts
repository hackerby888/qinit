// Release-CI smoke: the BUILT browser bundle (dist/browser.js, snapshot embedded) must compile a representative contract and the wasm must
import { Sim } from "@qinit/engine";
import { initK12 } from "@qinit/core";

const SOURCE = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 n; uint64 calls; };
  struct Bump_input { uint64 by; };
  struct Bump_output {};
  PUBLIC_PROCEDURE(Bump)
  {
    state.mut().n += input.by;
    state.mut().calls += 1;
  }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_PROCEDURE(Bump, 1); }
};`;

// Computed specifier — the bundle exists only after `bun run build`; a literal import would fail typechecking on
const bundle = "../dist/browser.js";
const browser = await import(bundle);
console.log("compilerInfo:", browser.compilerInfo);

const res = await browser.compileContract({ source: SOURCE, name: "SMOKE", slot: 27, arenaSz: 1 << 20 });
const errors = res.diagnostics.filter((d: { severity: string }) => d.severity === "error");
if (errors.length || res.wasm.byteLength === 0) {
  console.error("browser bundle compile failed:", errors);
  process.exit(1);
}

await initK12();
const sim = new Sim({ mempool: false, fees: "off", liteTicking: true });
const user = new Uint8Array(32).fill(7);
sim.fund(user, 1_000_000n);
sim.deploy(27, res.wasm);
const buf = new Uint8Array(8);
new DataView(buf.buffer).setBigUint64(0, 5n, true);
sim.procedure(27, 1, buf, { invocator: user });
sim.procedure(27, 1, buf, { invocator: user });

const st = sim.contracts.get(27)!.state();
const dv = new DataView(st.buffer, st.byteOffset);
const n = dv.getBigUint64(0, true);
const calls = dv.getBigUint64(8, true);
if (n !== 10n || calls !== 2n) {
  console.error(`state mismatch: n=${n} calls=${calls} (want n=10 calls=2)`);
  process.exit(1);
}
console.log("browser bundle smoke OK — n=10, calls=2");
