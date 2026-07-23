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

export interface SnapshotResult {
  root: string;
  fileCount: number;
}

export interface SnapshotOptions {
  includeSdkHeaders?: boolean;
}

export async function buildSnapshot(
  corePath: string,
  outRoot: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  corePath = resolve(corePath);
  if (!existsSync(join(corePath, "src", "contracts", "qpi.h"))) {
    throw new Error(`not a core checkout (no src/contracts/qpi.h): ${corePath}`);
  }

  const tmp = join(outRoot, ".snap-stub");
  mkdirSync(tmp, { recursive: true });
  const stubH = join(tmp, "Stub.h");
  writeFileSync(stubH, STUB);
  const slot = loadCoreWasmSlotLayout(corePath).slotBase;
  const wrapper = join(tmp, "Stub.wrapper.cpp");
  writeFileSync(
    wrapper,
    genWrapperWasm({
      contractPath: stubH,
      name: "Stub",
      slot,
      corePath,
      outDir: tmp,
    }),
  );
  const shim = join(corePath, "src", CORE_WASM_HEADERS.sdk.platformIntrinsics);

  const dependencies = (out: string) =>
    out
      .replace(/\\\n/g, " ")
      .split(/\s+/)
      .filter((path) => path && existsSync(path));

  const sdk = wasiSdkPaths();
  const wasmClang = process.env.WASM_CLANG ?? sdk?.clang;
  const sysroot = process.env.WASI_SYSROOT ?? sdk?.sysroot;
  if (!wasmClang || !sysroot) {
    throw new Error(
      "no complete wasi-sdk (WASM_CLANG + WASI_SYSROOT or a fetched SDK) — needed to snapshot the Wasm header closure",
    );
  }
  const rw = Bun.spawnSync([
    wasmClang,
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-exceptions",
    "-fno-rtti",
    "-DLITEDYN_CONTRACT_TU",
    `--sysroot=${sysroot}`,
    "-include",
    shim,
    `-I${corePath}`,
    `-I${join(corePath, "src")}`,
    options.includeSdkHeaders ? "-M" : "-MM",
    wrapper,
  ]);
  if (rw.exitCode !== 0) {
    throw new Error("wasm clang -M failed:\n" + new TextDecoder().decode(rw.stderr));
  }
  const deps = dependencies(new TextDecoder().decode(rw.stdout));

  const contractsDir = join(corePath, "src", "contracts");
  const extra = readdirSync(contractsDir)
    .filter((file) => file.endsWith(".h"))
    .map((file) => join(contractsDir, file));
  extra.push(join(corePath, "src", "contract_core", "contract_def.h"));
  for (const sdkHeader of Object.values(CORE_WASM_HEADERS.sdk)) {
    extra.push(join(corePath, "src", sdkHeader));
  }
  for (const sharedHeader of Object.values(CORE_WASM_HEADERS.shared)) {
    extra.push(join(corePath, "src", sharedHeader));
  }

  const root = join(outRoot, "core-headers");
  rmSync(root, { recursive: true, force: true });
  const copied = new Set<string>();
  let fileCount = 0;
  const copy = (source: string, destination: string) => {
    if (copied.has(destination)) return;
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied.add(destination);
    fileCount++;
  };

  for (const f of new Set([...deps, ...extra].map((file) => resolve(file)))) {
    const rel = relative(corePath, f);
    if (rel.startsWith("..") || !existsSync(f)) continue;
    copy(f, join(root, rel));
  }
  if (options.includeSdkHeaders) {
    for (const f of new Set(deps.map((file) => resolve(file)))) {
      const rel = relative(sysroot, f);
      if (rel.startsWith("..") || !existsSync(f)) continue;
      copy(f, join(root, "wasi-sdk", "share", "wasi-sysroot", rel));
    }
  }
  rmSync(tmp, { recursive: true, force: true });
  return { root, fileCount };
}
