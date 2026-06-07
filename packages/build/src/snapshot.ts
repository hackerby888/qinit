// Core-header snapshot: clang -M closure ∪ all contracts ∪ contract_def.h ∪ lite_contract_calls.h.
// Self-updating; mirrors core layout so -I resolves 1:1 with a real checkout.
import { mkdirSync, copyFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { genWrapper, genWrapperWasm, resolveClang } from "./recipe";
import { wasiSdkPaths } from "@qinit/core";

const STUB = `using namespace QPI;
struct CONTRACT_STATE2_TYPE {};
struct CONTRACT_STATE_TYPE : public ContractBase {
  struct StateData { uint64 x; };
  struct G_input {}; struct G_output { uint64 v; };
  PUBLIC_FUNCTION(G) { output.v = state.get().x; }
  REGISTER_USER_FUNCTIONS_AND_PROCEDURES() { REGISTER_USER_FUNCTION(G, 1); }
  INITIALIZE() { state.mut().x = 0; }
};
`;

export interface SnapshotResult { root: string; fileCount: number; }

// Produce <outRoot>/core-headers/ (extracted, ready to use as a corePath).
export async function buildSnapshot(corePath: string, outRoot: string, clangPref?: string): Promise<SnapshotResult> {
  corePath = resolve(corePath);
  if (!existsSync(join(corePath, "src", "contracts", "qpi.h")))
    throw new Error(`not a core checkout (no src/contracts/qpi.h): ${corePath}`);

  const tmp = join(outRoot, ".snap-stub");
  mkdirSync(tmp, { recursive: true });
  const stubH = join(tmp, "Stub.h");
  writeFileSync(stubH, STUB);
  const wrapper = join(tmp, "Stub.wrapper.cpp");
  writeFileSync(wrapper, genWrapper({ contractPath: stubH, name: "Stub", slot: 28, corePath, outDir: tmp }));
  // wasm wrapper swaps lite_dyn_abi.h -> lite_wasm_tu.h; the wasm compile also force-includes the intrinsics shim.
  const shim = join(corePath, "src", "extensions", "lite_wasm_intrinsics.h");
  const wasmWrapper = join(tmp, "Stub.wasm.wrapper.cpp");
  writeFileSync(wasmWrapper, genWrapperWasm({ contractPath: stubH, name: "Stub", slot: 28, corePath, outDir: tmp }));

  const flatten = (out: string) => out.replace(/\\\n/g, " ").split(/\s+/).filter((s) => s.startsWith(corePath));
  // native (.so) closure — general headers under the real-intrinsics path.
  const clang = resolveClang(clangPref);
  const rn = Bun.spawnSync([clang, "-std=c++20", "-fPIC", "-mavx2", `-I${corePath}`, `-I${join(corePath, "src")}`, "-M", wrapper]);
  if (rn.exitCode !== 0) throw new Error("clang -M failed:\n" + new TextDecoder().decode(rn.stderr));
  // WASM closure — computed with the actual wasm target+sysroot so it matches what compileWasmContract pulls
  // (lite_wasm_tu.h, the -include'd intrinsics shim, AND the simde m256i headers the wasm path takes — none of
  // which the native -mavx2 closure references). This is the bug: the snapshot must mirror the wasm compile.
  const sdk = wasiSdkPaths();
  const wasmClang = process.env.WASM_CLANG ?? sdk?.clang;
  const sysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
  if (!wasmClang) throw new Error("no wasm clang (WASM_CLANG or a fetched wasi-sdk) — needed to snapshot the wasm header closure");
  const rw = Bun.spawnSync([wasmClang, "--target=wasm32-wasi", "-std=c++20", "-fno-exceptions", "-fno-rtti",
    ...(sysroot ? [`--sysroot=${sysroot}`] : []), "-include", shim, `-I${corePath}`, `-I${join(corePath, "src")}`, "-M", wasmWrapper]);
  if (rw.exitCode !== 0) throw new Error("wasm clang -M failed:\n" + new TextDecoder().decode(rw.stderr));
  const deps = [...flatten(new TextDecoder().decode(rn.stdout)), ...flatten(new TextDecoder().decode(rw.stdout))];

  // Inter-contract additions not in a no-callee closure: every contract header + the index map +
  // the lite call-macro header (only pulled when a contract has callees).
  const contractsDir = join(corePath, "src", "contracts");
  const extra = readdirSync(contractsDir).filter((f) => f.endsWith(".h")).map((f) => join(contractsDir, f));
  extra.push(join(corePath, "src", "contract_core", "contract_def.h"));
  extra.push(join(corePath, "src", "extensions", "lite_contract_calls.h"));
  extra.push(join(corePath, "src", "extensions", "lite_wasm_intrinsics.h"));   // -include'd by the wasm compile
  extra.push(join(corePath, "src", "extensions", "lite_wasm_tu.h"));           // wasm TU binding (swapped in)

  const root = join(outRoot, "core-headers");
  rmSync(root, { recursive: true, force: true });
  let n = 0;
  for (const f of new Set([...deps, ...extra])) {
    const rel = relative(corePath, f);
    if (rel.startsWith("..") || !existsSync(f)) continue;
    const dst = join(root, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
    n++;
  }
  rmSync(tmp, { recursive: true, force: true });
  return { root, fileCount: n };
}
