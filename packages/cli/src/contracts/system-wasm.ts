// Compile built-in system contracts for simulator execution.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cacheRoot, readCurrent } from "@qinit/core";
import {
  buildSystemContract,
  systemContracts,
  type SystemContract,
  type SystemContractCompiler,
} from "@qinit/build";
import { resolveCoreDir } from "../config";

export function systemCatalog(core?: string): SystemContract[] {
  return systemContracts(core ?? resolveCoreDir());
}

function cacheDir(
  compiler: SystemContractCompiler,
  headersVersion: string,
): string {
  return join(
    cacheRoot(),
    headersVersion,
    "system-wasm",
    compiler,
  );
}

// Snapshot builds use a compiler-specific cache; explicit Core checkouts build in a temporary directory.
export async function systemWasm(
  name: string,
  core?: string,
  compiler: SystemContractCompiler = "clang",
): Promise<{ index: number; name: string; wasm: Uint8Array }> {
  const corePath = core ?? resolveCoreDir();
  const current = readCurrent();
  const cacheable = core === undefined &&
    current?.coreHeaders !== undefined &&
    current.headersVersion !== undefined &&
    resolve(current.coreHeaders) === resolve(corePath);
  const catalog = systemContracts(corePath);
  const c = catalog.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    throw new Error(
      `unknown system contract '${name}' — have: ${catalog.map((x) => x.name).join(", ")}`,
    );
  }

  const dir = cacheable
    ? cacheDir(compiler, current.headersVersion!)
    : mkdtempSync(join(tmpdir(), "qinit-system-wasm-"));
  const file = join(dir, `${c.index}_${c.name}.wasm`);
  if (cacheable && existsSync(file)) {
    return { index: c.index, name: c.name, wasm: new Uint8Array(readFileSync(file)) };
  }

  try {
    const r = await buildSystemContract(c.name, corePath, {
      compiler,
      outDir: dir,
    });
    if (!r.ok || !r.wasmPath) {
      throw new Error(`compile ${c.name} failed: ${r.stderr ?? "unknown error"}`);
    }
    const wasm = new Uint8Array(readFileSync(r.wasmPath));
    if (cacheable) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, wasm);
    }
    return { index: c.index, name: c.name, wasm };
  } finally {
    if (!cacheable) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
