// The VS Code integration host does not inherit this process's environment, so the clangd server
// binary is resolved here and pinned into the fixture workspace settings before the tests launch.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

function which(binary: string): string | undefined {
  const finder = process.platform === "win32" ? "where" : "which";
  try {
    const found = execFileSync(finder, [binary]).toString().split("\n")[0].trim();
    return found || undefined;
  } catch {
    return undefined;
  }
}

const clangd = process.env.CLANGD?.trim() || which("clangd");

const settingsDir = resolve(import.meta.dir, "..", "test-fixtures", "ws", ".vscode");
const settingsFile = join(settingsDir, "settings.json");
let settings: Record<string, unknown> = {};
if (existsSync(settingsFile)) {
  try {
    settings = JSON.parse(readFileSync(settingsFile, "utf8"));
  } catch {}
}

if (clangd) {
  settings["clangd.path"] = clangd;
} else {
  delete settings["clangd.path"];
}
mkdirSync(settingsDir, { recursive: true });
writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
console.log(`itest clangd server: ${clangd ?? "not found — clangd cases will fail"}`);
