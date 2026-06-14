// Per-project config (qinit.json) + core resolution now live in @qinit/core (project.ts) so the
// VS Code extension can share them without pulling in Ink/React. Re-exported here for back-compat:
// every command still does `import { loadConfig, resolveCore } from "../config"`.
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { assertSeed } from "@qinit/core";

export { loadConfig, resolveCore } from "@qinit/core";
export type { QinitConfig } from "@qinit/core";

// qinit's config dir. Honors $XDG_CONFIG_HOME on every platform (tests + power users rely on it); otherwise
// %APPDATA%\qinit on Windows (idiomatic) and ~/.config/qinit elsewhere. Back-compat: an existing
// ~/.config/qinit written by an earlier Windows build is honored so a saved seed is never orphaned by the move.
function configDir(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "qinit");
  if (process.platform === "win32") {
    const appData = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "qinit");
    const legacy = join(homedir(), ".config", "qinit");
    return !existsSync(appData) && existsSync(legacy) ? legacy : appData;
  }
  return join(homedir(), ".config", "qinit");
}

// Globally-chosen signing seed (a key) — stored in qinit's config dir, NOT the committed qinit.json. `qinit seed`
// sets it; every command that needs a seed uses it (so the user picks once and it auto-fills everywhere).
export function seedStorePath(): string {
  return join(configDir(), "seed");
}
export function savedSeed(): string | undefined {
  try { const s = readFileSync(seedStorePath(), "utf8").trim(); return /^[a-z]{55}$/.test(s) ? s : undefined; } catch { return undefined; }
}
export function setSavedSeed(seed: string): void {
  assertSeed(seed);
  const p = seedStorePath(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, seed + "\n", { mode: 0o600 });
}
export function clearSavedSeed(): void { try { rmSync(seedStorePath()); } catch {} }

// Globally-chosen UI color theme (set by `qinit theme`), applied at startup so every command follows it.
export function themeStorePath(): string {
  return join(configDir(), "theme");
}
export function savedTheme(): string | undefined {
  try { return readFileSync(themeStorePath(), "utf8").trim() || undefined; } catch { return undefined; }
}
export function setSavedTheme(name: string): void {
  const p = themeStorePath(); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, name + "\n");
}

// Seed precedence: explicit (--seed) > saved pick (`qinit seed`) > node funded seed > dev default.
export async function resolveSeed(rpc: { fundedSeed(): Promise<string | undefined> }, explicit?: string): Promise<string> {
  if (explicit) { assertSeed(explicit); return explicit; }
  const saved = savedSeed();
  if (saved) return saved;
  const funded = await rpc.fundedSeed();
  return funded ?? "a".repeat(55);
}

