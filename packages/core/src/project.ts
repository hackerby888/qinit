// Project config and core resolution shared by the CLI and VS Code extension. Bun-free.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readCurrent } from "./cache/paths";

export interface QinitConfig {
    contractName?: string;
    contract?: string;
    slot?: number;
    coreDir?: string;
    rpc?: string;
    system?: string[]; // built-in system contracts to seed onto the simulator
}

// Notepad, Visual Studio ("UTF-8 with signature") and PowerShell 5.1's `Out-File -Encoding utf8` all prepend U+FEFF, which JSON.parse rejects.
function stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export class QinitConfigError extends Error {
    constructor(
        readonly path: string,
        readonly cause: unknown,
    ) {
        super(`qinit.json at ${path} could not be read: ${String((cause as any)?.message ?? cause)}`);
        this.name = "QinitConfigError";
    }
}

// Per-project config (qinit.json). Precedence at the call site: CLI flag > qinit.json > default.
// a present but unreadable file throws: that is not the same situation as no config at all.
export function loadConfig(path = "qinit.json"): QinitConfig {
    if (!existsSync(path)) {
        return {};
    }
    try {
        return JSON.parse(stripBom(readFileSync(path, "utf8"))) as QinitConfig;
    } catch (error) {
        throw new QinitConfigError(path, error);
    }
}

/** never throws: the editor has to stay alive on a malformed config and show the error rather than read it as absent. */
export function loadConfigSafe(path = "qinit.json"): { config: QinitConfig; error?: string } {
    try {
        return { config: loadConfig(path) };
    } catch (error) {
        return { config: {}, error: String((error as any)?.message ?? error) };
    }
}

// Where to find core headers for compiling: explicit checkout > env > fetched snapshot cache; neither present gives an actionable error.
export function resolveCoreDir(cliCoreDir?: string, configCoreDir?: string): string {
    const explicit = cliCoreDir || configCoreDir || process.env.QINIT_CORE;
    if (explicit) {
        const coreDir = resolve(explicit);
        // checked once here, so a stale path in a cloned qinit.json fails the same way in every command
        if (!existsSync(join(coreDir, "src", "qpi", "qpi.h"))) {
            const origin = cliCoreDir ? "--core-dir" : configCoreDir ? "coreDir in qinit.json" : "QINIT_CORE";
            throw new Error(`${origin} points to ${coreDir}, which is not a core checkout (src/qpi/qpi.h not found) — fix it, or remove it and run \`qinit setup\``);
        }
        return coreDir;
    }
    const cur = readCurrent();
    if (cur?.coreHeaders && existsSync(cur.coreHeaders)) return cur.coreHeaders;
    throw new Error("no core headers: run `qinit setup` (fetch the published snapshot), or set QINIT_CORE=<core-checkout>");
}

// Lean, Bun-free re-exports of the toolchain readers, so a consumer can import everything project-related without dragging in the crypto/rpc barrel.
export { readCurrent, currentPath, cacheRoot } from "./cache/paths";
export type { CurrentPointer } from "./cache/paths";
export { wasiSdkPaths } from "./cache/wasi-sdk";
