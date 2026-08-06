// Compile and cache built-in system contracts for simulator startup.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cacheRoot, readCurrent } from "@qinit/core";
import { buildSystemContract, systemContracts, type SystemContract } from "@qinit/build";
import { resolveCoreDir } from "../config";

export function systemCatalog(core?: string): SystemContract[] {
  return systemContracts(core ?? resolveCoreDir());
}

function cacheDir(): string {
  return join(cacheRoot(), readCurrent()?.headersVersion ?? "current", "system-wasm");
}

// Compiled wasm for a named system contract — loaded from cache when present, else compiled (skipVerify) and
// cached. Returns the bytes + the contract's canonical slot index.
export async function systemWasm(
  name: string,
  core = resolveCoreDir(),
): Promise<{ index: number; name: string; wasm: Uint8Array }> {
  const catalog = systemContracts(core);
  const c = catalog.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!c) {
    throw new Error(
      `unknown system contract '${name}' — have: ${catalog.map((x) => x.name).join(", ")}`,
    );
  }

  const dir = cacheDir();
  const file = join(dir, `${c.index}_${c.name}.wasm`);
  if (existsSync(file)) {
    return { index: c.index, name: c.name, wasm: new Uint8Array(readFileSync(file)) };
  }

  const r = await buildSystemContract(c.name, core, { outDir: dir });
  if (!r.ok || !r.wasmPath) {
    throw new Error(`compile ${c.name} failed: ${r.stderr ?? "unknown error"}`);
  }
  const wasm = new Uint8Array(readFileSync(r.wasmPath));
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, wasm);
  return { index: c.index, name: c.name, wasm };
}
