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
import { cachedReleaseRef } from "./node-ops";

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
  updateCurrent?: boolean;
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

    if (options.updateCurrent !== false) {
      deps.updateCurrent({ headersVersion: "local", coreHeaders });
    }
    return { version: "local", coreHeaders, detail: `local ${coreHeaders}` };
  }

  if (options.offline && options.ref !== undefined) {
    throw new Error("--offline cannot be combined with --ref");
  }

  const current = deps.readCurrent();
  const cachedHeaders =
    current?.coreHeaders && deps.existsSync(current.coreHeaders)
      ? current.coreHeaders
      : undefined;
  if (options.offline) {
    if (!cachedHeaders) {
      throw new Error("offline: no synced headers — run `qinit node run` online first");
    }
    return {
      version: current?.headersVersion ?? "cached",
      coreHeaders: cachedHeaders,
      detail: `reuse ${current?.headersVersion ?? "cached"}`,
    };
  }

  if (options.ref === undefined && cachedHeaders) {
    return {
      version: current?.headersVersion ?? "cached",
      coreHeaders: cachedHeaders,
      detail: `cached ${current?.headersVersion ?? "cached"}`,
    };
  }

  let ref = options.ref;
  if (ref === undefined && current?.node && deps.existsSync(current.node)) {
    ref = cachedReleaseRef(current.nodeVersion);
    if (!ref) {
      throw new Error(
        "selected node does not identify a release — run `qinit setup --force` or pass --ref",
      );
    }
  }
  ref ??= "latest";
  const manifest = await deps.loadManifest(ref);
  const version = manifest.version;
  if (current?.headersVersion === version && cachedHeaders) {
    return { version, coreHeaders: cachedHeaders, detail: `cached ${version}` };
  }
  const headersAsset = manifest.headers;
  if (!headersAsset) {
    throw new Error(`manifest ${version} has no headers asset`);
  }

  const coreHeaders = deps.cacheHeaders(version);
  await deps.extractTarGz(
    await deps.downloadVerifiedAsset(headersAsset, onProgress),
    coreHeaders,
  );
  if (options.updateCurrent !== false) {
    deps.updateCurrent({ headersVersion: version, coreHeaders });
  }
  return { version, coreHeaders, detail: `fetched ${version}` };
}
