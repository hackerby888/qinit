import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";

export const REQUIRE_CONTAINER_TOOLCHAINS = process.env.QINIT_REQUIRE_CONTAINER_TOOLCHAINS === "1";

export interface ToolchainStatus {
  available: boolean;
  detail: string;
  path?: string;
}

export function wasiToolchain(): ToolchainStatus {
  const configuredClang = process.env.WASM_CLANG?.trim();
  const configuredSysroot = process.env.WASI_SYSROOT?.trim();
  if (
    configuredClang &&
    configuredSysroot &&
    existsSync(configuredClang) &&
    existsSync(configuredSysroot)
  ) {
    return { available: true, detail: configuredClang, path: configuredClang };
  }
  try {
    const { wasiSdkPaths } = require("@qinit/core/project") as {
      wasiSdkPaths: () => { clang: string; sysroot: string } | null;
    };
    const paths = wasiSdkPaths();
    if (paths && existsSync(paths.clang) && existsSync(paths.sysroot)) {
      return { available: true, detail: paths.clang, path: paths.clang };
    }
  } catch {}
  return { available: false, detail: "WASI SDK clang/sysroot not found" };
}

export function wamrToolchain(corePath: string): ToolchainStatus {
  const configured = process.env.QINIT_WAMR_GTEST?.trim();
  const candidates = [
    configured,
    join(corePath, "build-wtests", "test", "qubic_wasm_tests"),
    join(corePath, "build-container-parity", "test", "qubic_wasm_tests"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const path = candidates.find((candidate) => existsSync(candidate));
  return path
    ? { available: true, detail: path, path }
    : { available: false, detail: `WAMR qubic_wasm_tests not found (${candidates.join(", ")})` };
}

export function toolchainTest(
  name: string,
  status: ToolchainStatus,
  body: () => void | Promise<void>,
  timeout = 180_000,
): void {
  const run = status.available || REQUIRE_CONTAINER_TOOLCHAINS ? test : test.skip;
  run(
    name,
    async () => {
      if (!status.available) {
        throw new Error(
          `${status.detail}; QINIT_REQUIRE_CONTAINER_TOOLCHAINS=1 forbids skipping container parity`,
        );
      }
      await body();
    },
    timeout,
  );
}
