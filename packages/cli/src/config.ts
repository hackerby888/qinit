import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { assertSeed, loadConfig, resolveCoreDir } from "@qinit/core";
import { loadQpiHeader } from "@qinit/compiler";
import { invalidArgs } from "./args";

export { loadConfig, resolveCoreDir };
export type { QinitConfig } from "@qinit/core";

// Keep these re-exports free of Ink/React so the VS Code extension can use them.
export function loadConfiguredQpiHeader(explicitCoreDir?: string): string {
  const config = loadConfig();
  return loadQpiHeader(resolveCoreDir(explicitCoreDir, config.coreDir));
}

function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return join(xdg, "qinit");
  }

  if (process.platform === "win32") {
    const appData = join(
      process.env.APPDATA ||
        join(homedir(), "AppData", "Roaming"),
      "qinit",
    );
    const legacy = join(homedir(), ".config", "qinit");
    return !existsSync(appData) && existsSync(legacy) ? legacy : appData;
  }

  return join(homedir(), ".config", "qinit");
}

export function seedStorePath(): string {
  return join(configDir(), "seed");
}

export function savedSeed(): string | undefined {
  try {
    const seed = readFileSync(seedStorePath(), "utf8").trim();
    return /^[a-z]{55}$/.test(seed) ? seed : undefined;
  } catch {
    return undefined;
  }
}

export function setSavedSeed(seed: string): void {
  assertSeed(seed);
  const path = seedStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, seed + "\n", { mode: 0o600 });
}

export function clearSavedSeed(): void {
  try {
    rmSync(seedStorePath());
  } catch {
    // Clearing a missing seed is already complete.
  }
}

export function themeStorePath(): string {
  return join(configDir(), "theme");
}

export function savedTheme(): string | undefined {
  try {
    return readFileSync(themeStorePath(), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

export function setSavedTheme(name: string): void {
  const path = themeStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, name + "\n");
}

export type NodeRuntime = "core" | "simulator";
export const NODE_RUNTIMES: NodeRuntime[] = ["core", "simulator"];

export function runtimeStorePath(): string {
  return join(configDir(), "runtime");
}

export function savedRuntime(): NodeRuntime | undefined {
  try {
    const runtime = readFileSync(runtimeStorePath(), "utf8").trim();
    return runtime === "core" || runtime === "simulator" ? runtime : undefined;
  } catch {
    return undefined;
  }
}

export function setSavedRuntime(runtime: NodeRuntime): void {
  const path = runtimeStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, runtime + "\n");
}

export function resolveRuntime(requested?: string): NodeRuntime {
  if (requested === undefined) {
    return savedRuntime() ?? "core";
  }
  if (requested === "core" || requested === "simulator") {
    return requested;
  }
  return invalidArgs("--runtime must be core or simulator");
}

export type CompilerBackend = "clang" | "typescript";
export const COMPILER_BACKENDS: CompilerBackend[] = ["clang", "typescript"];

export function compilerBackendStorePath(): string {
  return join(configDir(), "compiler-backend");
}

export function savedCompilerBackend(): CompilerBackend | undefined {
  try {
    const backend = readFileSync(compilerBackendStorePath(), "utf8").trim();
    return backend === "clang" || backend === "typescript" ? backend : undefined;
  } catch {
    return undefined;
  }
}

export function setSavedCompilerBackend(backend: CompilerBackend): void {
  const path = compilerBackendStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, backend + "\n");
}

export function resolveCompilerBackend(requested?: string): CompilerBackend {
  if (requested === undefined) {
    return savedCompilerBackend() ?? "clang";
  }
  if (requested === "clang" || requested === "typescript") {
    return requested;
  }
  return invalidArgs("--compiler must be clang or typescript");
}

export async function resolveSeed(
  rpc: { fundedSeed(): Promise<string | undefined> },
  explicit?: string,
): Promise<string> {
  if (explicit) {
    assertSeed(explicit);
    return explicit;
  }
  const saved = savedSeed();
  if (saved) {
    return saved;
  }

  const funded = await rpc.fundedSeed();
  return funded ?? "a".repeat(55);
}
