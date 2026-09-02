import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { wasiSdkPaths } from "@qinit/core/project";

/** Repository-local paths are derived from this checkout, never from a developer-specific absolute path. */
export const QINIT_ROOT = resolve(import.meta.dir, "..");

const raw = process.env.QINIT_CORE?.trim() ?? "";

/** Tests and developer tools that consume live core-lite source require an explicit external checkout. */
export const CORE_PATH = raw ? resolve(raw) : "";

/** True when CORE_PATH points at an actual core-lite checkout; gated suites skip rather than fail without it. */
export const HAS_CORE = raw !== "" && existsSync(join(CORE_PATH, "src", "qpi", "qpi.h"));

/** True when a wasm clang and sysroot resolve, from the cached SDK or WASM_CLANG/WASI_SYSROOT. */
export const HAS_WASI = wasiSdkPaths() !== null;

/** Hard-require a core checkout; for standalone tools/scripts that cannot meaningfully skip. */
export function requireCorePath(): string {
    if (!HAS_CORE) {
        throw new Error("QINIT_CORE is required; set it to the path of a core-lite checkout");
    }
    return CORE_PATH;
}

/**
 * The live qpi.h with the `cheat` host import removed, standing in for core headers that predate the
 * cheatcodes. Both halves have to go: dropping one alone trips the canonical-ABI check on the other.
 */
export function qpiHeaderWithoutCheatImport(header: string): string {
    return header
        .split("\n")
        .filter((line) => !line.includes("__lhost_cheat"))
        .join("\n")
        .replace(',{"name":"cheat","params":["i32","i64","i64","i32","i32"],"results":["i64"]}', "");
}
