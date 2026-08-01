import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  cacheHeaders,
  extractTarGz,
  downloadVerifiedAsset,
  loadManifest,
  readCurrent,
  updateCurrent,
} from "@qinit/core";

const defaultDeps = {
  existsSync,
  cacheHeaders,
  extractTarGz,
  downloadVerifiedAsset,
  loadManifest,
  readCurrent,
  updateCurrent,
};

export type NodeRunCoreDeps = typeof defaultDeps;

export interface NodeRunCoreOptions {
  coreDir?: string;
  nodeBinary?: string;
  ref?: string;
  offline?: boolean;
}

export interface PreparedNodeRunCore {
  version: string;
  coreHeaders: string;
  detail: string;
}

export async function prepareNodeRunCore(
  options: NodeRunCoreOptions,
  useSimulator: boolean,
  injected: Partial<NodeRunCoreDeps> = {},
  onProgress?: (recv: number, total: number) => void,
): Promise<PreparedNodeRunCore> {
  const deps = { ...defaultDeps, ...injected };

  if (options.coreDir !== undefined) {
    if (options.ref !== undefined) {
      throw new Error("--core-dir cannot be combined with --ref");
    }
    if (!options.coreDir) {
      throw new Error("--core-dir requires a path");
    }
    if (!useSimulator && !options.nodeBinary) {
      throw new Error(
        "core backend with --core-dir requires --node-bin <path> to keep node and headers aligned",
      );
    }

    const coreHeaders = resolve(options.coreDir);
    if (!deps.existsSync(coreHeaders)) {
      throw new Error(`--core-dir not found: ${coreHeaders}`);
    }
    if (!deps.existsSync(join(coreHeaders, "src", "qpi", "qpi.h"))) {
      throw new Error(
        `invalid --core-dir path (missing src/qpi/qpi.h): ${coreHeaders}`,
      );
    }

    deps.updateCurrent({ headersVersion: "local", coreHeaders });
    return { version: "local", coreHeaders, detail: `local ${coreHeaders}` };
  }

  let version: string;
  let headersAsset: any;
  if (options.offline) {
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
      if (!useSimulator) {
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
  if (options.offline) {
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
    await deps.downloadVerifiedAsset(headersAsset, onProgress),
    coreHeaders,
  );
  deps.updateCurrent({ headersVersion: version, coreHeaders });
  return { version, coreHeaders, detail: `fetched ${version}` };
}
