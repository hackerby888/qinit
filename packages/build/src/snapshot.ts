// Core-header snapshot: compiler closures plus contracts and the canonical Wasm SDK layout.
// Self-updating; mirrors core layout so -I resolves 1:1 with a real checkout.
import { mkdirSync, copyFileSync, readdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { genWrapperWasm } from "./recipe";
import { CORE_WASM_HEADERS, loadCoreWasmSlotLayout, wasiSdkPaths } from "@qinit/core";

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
export async function buildSnapshot(corePath: string, outRoot: string): Promise<SnapshotResult> {
  corePath = resolve(corePath);
  if (!existsSync(join(corePath, "src", "contracts", "qpi.h")))
    throw new Error(`not a core checkout (no src/contracts/qpi.h): ${corePath}`);

  const tmp = join(outRoot, ".snap-stub");
  mkdirSync(tmp, { recursive: true });
  const stubH = join(tmp, "Stub.h");
  writeFileSync(stubH, STUB);
  const slot = loadCoreWasmSlotLayout(corePath).slotBase;
  const wrapper = join(tmp, "Stub.wrapper.cpp");
  writeFileSync(wrapper, genWrapperWasm({ contractPath: stubH, name: "Stub", slot, corePath, outDir: tmp }));
  const shim = join(corePath, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics);

  const flatten = (out: string) => out.replace(/\\\n/g, " ").split(/\s+/).filter((s) => s.startsWith(corePath));
  // Compute the closure with the actual Wasm target and sysroot so it matches compileWasmContract.
  // (SDK module runtime, force-included intrinsics, and the simde m256i headers used by the Wasm target).
  const sdk = wasiSdkPaths();
  const wasmClang = process.env.WASM_CLANG ?? sdk?.clang;
  const sysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
  if (!wasmClang || !sysroot) throw new Error("no complete wasi-sdk (WASM_CLANG + WASI_SYSROOT or a fetched SDK) — needed to snapshot the Wasm header closure");
  const rw = Bun.spawnSync([wasmClang, "--target=wasm32-wasi", "-std=c++20", "-fno-exceptions", "-fno-rtti",
    "-DLITEDYN_CONTRACT_TU", `--sysroot=${sysroot}`, "-include", shim,
    `-I${corePath}`, `-I${join(corePath, "src")}`, "-MM", wrapper]);
  if (rw.exitCode !== 0) throw new Error("wasm clang -M failed:\n" + new TextDecoder().decode(rw.stderr));
  const deps = flatten(new TextDecoder().decode(rw.stdout));

  // Inter-contract additions not in a no-callee closure: every contract header, index map, and SDK headers.
  const contractsDir = join(corePath, "src", "contracts");
  const extra = readdirSync(contractsDir).filter((f) => f.endsWith(".h")).map((f) => join(contractsDir, f));
  extra.push(join(corePath, "src", "contract_core", "contract_def.h"));
  for (const sdkHeader of Object.values(CORE_WASM_HEADERS.sdk)) {
    extra.push(join(corePath, "src", sdkHeader));
  }
  for (const sharedHeader of Object.values(CORE_WASM_HEADERS.shared)) {
    extra.push(join(corePath, "src", sharedHeader));
  }

  const root = join(outRoot, "core-headers");
  rmSync(root, { recursive: true, force: true });
  let n = 0;
  for (const f of new Set([...deps, ...extra].map((file) => resolve(file)))) {
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
