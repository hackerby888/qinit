import { resolve } from "node:path";

/** Repository-local paths are derived from this checkout, never from a developer-specific absolute path. */
export const QINIT_ROOT = resolve(import.meta.dir, "..");

/** Tests and developer tools that consume live core-lite source require an explicit external checkout. */
export const CORE_PATH = (() => {
  const configured = process.env.QINIT_CORE?.trim();
  if (!configured) {
    throw new Error("QINIT_CORE is required; set it to the path of a core-lite checkout");
  }
  return resolve(configured);
})();
