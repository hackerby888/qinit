import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { genWrapperWasm } from "./recipe";
import {
  CORE_WASM_HEADERS,
  loadCoreWasmSlotLayout,
  wasiSdkPaths,
} from "@qinit/core";

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

  const scratchDir = join(outRoot, ".snap-stub");
  mkdirSync(scratchDir, { recursive: true });

  const stubHeader = join(scratchDir, "Stub.h");
  writeFileSync(stubHeader, STUB);

  const slot = loadCoreWasmSlotLayout(corePath).slotBase;
  const wrapperPath = join(scratchDir, "Stub.wrapper.cpp");
  writeFileSync(
    wrapperPath,
    genWrapperWasm({
      contractPath: stubHeader,
      name: "Stub",
      slot,
      corePath,
      outDir: scratchDir,
    }),
  );

  const platformIntrinsics = join(
    corePath,
    "src",
    CORE_WASM_HEADERS.sdk.platformIntrinsics,
  );

  const parseDependencies = (output: string) =>
    output
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

  const clang = Bun.spawnSync([
    wasmClang,
    "--target=wasm32-wasi",
    "-std=c++20",
    "-fno-exceptions",
    "-fno-rtti",
    "-DLITEDYN_CONTRACT_TU",
    `--sysroot=${sysroot}`,
    "-include",
    platformIntrinsics,
    `-I${corePath}`,
    `-I${join(corePath, "src")}`,
    options.includeSdkHeaders ? "-M" : "-MM",
    wrapperPath,
  ]);

  if (clang.exitCode !== 0) {
    const stderr = new TextDecoder().decode(clang.stderr);
    throw new Error("wasm clang -M failed:\n" + stderr);
  }

  const dependencies = parseDependencies(
    new TextDecoder().decode(clang.stdout),
  );

  const contractsDir = join(corePath, "src", "contracts");
  const extraFiles = readdirSync(contractsDir)
    .filter((file) => file.endsWith(".h"))
    .map((file) => join(contractsDir, file));

  extraFiles.push(
    join(corePath, "src", "contract_core", "contract_def.h"),
  );
  for (const sdkHeader of Object.values(CORE_WASM_HEADERS.sdk)) {
    extraFiles.push(join(corePath, "src", sdkHeader));
  }
  for (const sharedHeader of Object.values(CORE_WASM_HEADERS.shared)) {
    extraFiles.push(join(corePath, "src", sharedHeader));
  }

  const root = join(outRoot, "core-headers");
  rmSync(root, { recursive: true, force: true });

  const copied = new Set<string>();
  let fileCount = 0;

  const copy = (source: string, destination: string): void => {
    if (copied.has(destination)) {
      return;
    }

    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    copied.add(destination);
    fileCount++;
  };

  const projectFiles = new Set(
    [...dependencies, ...extraFiles].map((file) => resolve(file)),
  );
  for (const file of projectFiles) {
    const relativePath = relative(corePath, file);
    if (relativePath.startsWith("..") || !existsSync(file)) {
      continue;
    }

    copy(file, join(root, relativePath));
  }

  if (options.includeSdkHeaders) {
    const sdkFiles = new Set(
      dependencies.map((file) => resolve(file)),
    );
    for (const file of sdkFiles) {
      const relativePath = relative(sysroot, file);
      if (relativePath.startsWith("..") || !existsSync(file)) {
        continue;
      }

      copy(
        file,
        join(
          root,
          "wasi-sdk",
          "share",
          "wasi-sysroot",
          relativePath,
        ),
      );
    }
  }

  rmSync(scratchDir, { recursive: true, force: true });
  return { root, fileCount };
}
