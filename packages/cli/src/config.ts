import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { assertSeed, loadConfig, resolveCore } from "@qinit/core";
import { loadQpiHeader } from "@qinit/compile";

export { loadConfig, resolveCore };
export type { QinitConfig } from "@qinit/core";

// Keep these re-exports free of Ink/React so the VS Code extension can use them.
export function loadConfiguredQpiHeader(explicitCore?: string): string {
  const config = loadConfig();
  return loadQpiHeader(resolveCore(explicitCore, config.core));
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

export type NodeMode = "realnode" | "virtualnode";
export const NODE_MODES: NodeMode[] = ["realnode", "virtualnode"];

export function modeStorePath(): string {
  return join(configDir(), "mode");
}

export function savedMode(): NodeMode | undefined {
  try {
    const mode = readFileSync(modeStorePath(), "utf8").trim();
    return mode === "realnode" || mode === "virtualnode" ? mode : undefined;
  } catch {
    return undefined;
  }
}

export function setSavedMode(mode: NodeMode): void {
  const path = modeStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, mode + "\n");
}

export type Compiler = "native" | "local";
export const COMPILERS: Compiler[] = ["native", "local"];

export function compilerStorePath(): string {
  return join(configDir(), "compiler");
}

export function savedCompiler(): Compiler | undefined {
  try {
    const compiler = readFileSync(compilerStorePath(), "utf8").trim();
    return compiler === "native" || compiler === "local" ? compiler : undefined;
  } catch {
    return undefined;
  }
}

export function setSavedCompiler(compiler: Compiler): void {
  const path = compilerStorePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, compiler + "\n");
}

export function resolveCompiler(options: Record<string, unknown>): Compiler {
  if ("native" in options) {
    return "native";
  }
  if ("local" in options) {
    return "local";
  }
  return savedCompiler() ?? "native";
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
