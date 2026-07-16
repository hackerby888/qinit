// Compile Logger once with the TS compiler, then compare the exact LOG_* bytes produced by Sim and the
// release-configured core-lite WAMR node. QINIT_CORE and a ticking node at QINIT_RPC are required.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initK12, k12Hex, LiteRpc } from "../packages/core/src/index";
import { compileContract, inspectWasmModule, loadQpiHeader } from "../packages/compile/src/index";
import { Sim } from "../packages/engine/src/index";
import { deployContract } from "../packages/cli/src/deploy-ops";
import { invokeProcedure, resolveSlot } from "../packages/proto/src/index";

const core = process.env.QINIT_CORE;
if (!core) throw new Error("QINIT_CORE not set");
const rpcBase = process.env.QINIT_RPC ?? "http://127.0.0.1:41841";
const rpc = new LiteRpc(rpcBase);
const contractPath = resolve("fixtures/Logger.h");
const source = readFileSync(contractPath, "utf8");
const same = (a: Array<{ type: number; size: number; hex: string }>, b: Array<{ type: number; size: number; hex: string }>, label: string) => {
  const shape = (xs: typeof a) => xs.map((x) => [x.type, x.size, x.hex]);
  if (JSON.stringify(shape(a)) !== JSON.stringify(shape(b))) throw new Error(`${label} differs: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
};

await initK12();
const { slot } = await resolveSlot(rpc, "LoggerDual");
const compiled = await compileContract({ source, name: "LoggerDual", slot, qpiHeader: loadQpiHeader(core), arenaSz: 1024 * 1024 * 1024 });
const errors = compiled.diagnostics.filter((d) => d.severity === "error");
if (errors.length) throw new Error(errors.map((d) => d.message).join("; "));
const inspection = inspectWasmModule(compiled.wasm);
if (!inspection.ok) throw new Error(inspection.diagnostics.map((d) => d.message).join("; "));

const sim = new Sim({ mempool: false, fees: "off" });
sim.setDebug(true);
sim.deploy(slot, compiled.wasm);
const input = new Uint8Array(8);
new DataView(input.buffer).setBigUint64(0, 2n, true);
sim.procedure(slot, 1, input);
const simLogs = sim.getTrace().entries.filter((e) => e.index === slot && e.kind === 1).at(-1)?.logs ?? [];
if (simLogs.length !== 2) throw new Error(`Sim emitted ${simLogs.length} logs, expected 2`);

const hash = await k12Hex(compiled.wasm);
const deployed = await deployContract({
  contractPath, name: "LoggerDual", core, rpcBase, slotOverride: slot,
  artifact: {
    wasm: compiled.wasm, hash,
    registration: { functions: compiled.idl.functions.length, procedures: compiled.idl.procedures.length },
  }, rpc,
}, () => {});
if (!deployed.ok || !deployed.armed || !deployed.constructed) throw new Error(`deploy failed: ${JSON.stringify(deployed)}`);

await rpc.setDebug(true);
const seed = (await rpc.fundedSeed()) ?? "a".repeat(55);
const tick = (await rpc.tickInfo()).tick + 6;
const invoked = await invokeProcedure({ seed, rpcBase, contractIndex: slot, procId: 1, amount: 0, inFmt: "2uint64", tick, confirm: true, confirmTimeoutMs: 60_000, rpc });
if (!invoked.ok || !invoked.confirmed || !invoked.included) throw new Error(`invoke failed: ${JSON.stringify(invoked)}`);

let nodeLogs: typeof simLogs = [];
for (let i = 0; i < 10 && !nodeLogs.length; i++) {
  const trace = await rpc.debugTrace(0, 200);
  nodeLogs = trace.entries.filter((e) => e.index === slot && e.kind === 1 && e.logs.length).at(-1)?.logs ?? [];
  if (!nodeLogs.length) await new Promise((r) => setTimeout(r, 1000));
}
same(nodeLogs, simLogs, "LOG_* trace bytes");
console.log(`LOGGING DUAL OK — exact ${compiled.wasm.length}B artifact emitted ${nodeLogs.length} identical logs in Sim and WAMR at slot ${slot}`);
