import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cacheHeaders,
  extractTarGz,
  fetchVerify,
  loadManifest,
  readCurrent,
  updateCurrent,
} from "@qinit/core";

const defaultDeps = {
  existsSync,
  cacheHeaders,
  extractTarGz,
  fetchVerify,
  loadManifest,
  readCurrent,
  updateCurrent,
};

export type NodeRunCoreDeps = typeof defaultDeps;

export interface PreparedNodeRunCore {
  version: string;
  coreHeaders: string;
  detail: string;
}

export async function prepareNodeRunCore(
  options: Record<string, string>,
  virtual: boolean,
  injected: Partial<NodeRunCoreDeps> = {},
  onProgress?: (recv: number, total: number) => void,
): Promise<PreparedNodeRunCore> {
  const deps = { ...defaultDeps, ...injected };

  if ("core" in options) {
    if ("ref" in options) {
      throw new Error("--core cannot be combined with --ref");
    }
    if (!options.core) {
      throw new Error("--core requires a path");
    }
    if (!virtual && !options.bin) {
      throw new Error(
        "real node with --core requires --bin <path> to keep node and headers aligned",
      );
    }

    const coreHeaders = resolve(options.core);
    if (!deps.existsSync(coreHeaders)) {
      throw new Error(`--core not found: ${coreHeaders}`);
    }
    if (!deps.existsSync(join(coreHeaders, "src", "contracts", "qpi.h"))) {
      throw new Error(
        `invalid --core path (missing src/contracts/qpi.h): ${coreHeaders}`,
      );
    }

    deps.updateCurrent({ headersVersion: "local", coreHeaders });
    return { version: "local", coreHeaders, detail: `local ${coreHeaders}` };
  }

  let version: string;
  let headersAsset: any;
  if ("offline" in options) {
    const current = deps.readCurrent();
    if (!current?.coreHeaders || !deps.existsSync(current.coreHeaders)) {
      throw new Error("offline: no synced headers — run `qinit node run` online first");
    }
    version = current.headersVersion ?? "cached";
  } else {
    try {
      const manifest = await deps.loadManifest(options.ref || "latest");
      version = manifest.version;
      headersAsset = manifest.headers;
    } catch (error) {
      if (!virtual) {
        throw error;
      }
      const current = deps.readCurrent();
      if (!current?.coreHeaders || !deps.existsSync(current.coreHeaders)) {
        throw new Error(
          "no cached headers — run `qinit node run` online once to sync headers + wasi-sdk",
        );
      }
      version = current.headersVersion ?? "cached";
    }
  }

  const current = deps.readCurrent();
  if ("offline" in options) {
    return {
      version,
      coreHeaders: current!.coreHeaders!,
      detail: `reuse ${version}`,
    };
  }
  if (
    current?.headersVersion === version &&
    current.coreHeaders &&
    deps.existsSync(current.coreHeaders)
  ) {
    return {
      version,
      coreHeaders: current.coreHeaders,
      detail: `cached ${version}`,
    };
  }
  if (!headersAsset) {
    throw new Error(`manifest ${version} has no headers asset`);
  }

  const coreHeaders = deps.cacheHeaders(version);
  await deps.extractTarGz(
    await deps.fetchVerify(headersAsset, onProgress),
    coreHeaders,
  );
  deps.updateCurrent({ headersVersion: version, coreHeaders });
  return { version, coreHeaders, detail: `fetched ${version}` };
}
