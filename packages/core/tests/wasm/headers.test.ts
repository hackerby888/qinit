import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { CORE_PATH } from "../../../../test-utils/paths";
import { CORE_WASM_HEADERS } from "../../src/wasm-headers";
import {
  CONTRACT_ENTRY_POINTS,
  SYSTEM_PROCEDURE_COUNT,
  SYSTEM_PROCEDURES,
} from "../../src/lhost-abi";

test("contract entry points follow the generated system-procedure range", () => {
  expect(Object.keys(SYSTEM_PROCEDURES).length).toBe(SYSTEM_PROCEDURE_COUNT as number);
  expect(CONTRACT_ENTRY_POINTS).toEqual({
    userProcedure: 13,
    userFunction: 14,
    registerUserFunctionsAndProcedures: 15,
    userProcedureNotification: 16,
    migrateProcedure: 17,
  });
});

const sourceRoot = join(CORE_PATH, "src");
const extensionRoot = join(sourceRoot, CORE_WASM_HEADERS.root);
const coreOk = existsSync(extensionRoot);

const declaredHeaders = [
  ...Object.values(CORE_WASM_HEADERS.shared),
  ...Object.values(CORE_WASM_HEADERS.sdk),
  ...Object.values(CORE_WASM_HEADERS.runtime),
].sort();

describe.if(coreOk)("canonical core Wasm header layout", () => {
  test("declares every shared, SDK, and runtime source exactly once", () => {
    const diskHeaders = ["shared", "sdk", "runtime"]
      .flatMap((group) =>
        readdirSync(join(extensionRoot, group), { withFileTypes: true })
          .filter((entry) => entry.isFile())
          .map((entry) =>
            relative(sourceRoot, join(extensionRoot, group, entry.name)).split(sep).join("/"),
          ),
      )
      .sort();

    expect(new Set(declaredHeaders).size).toBe(declaredHeaders.length);
    expect(diskHeaders).toEqual(declaredHeaders);
  });

  test("runtime and SDK do not include each other", () => {
    for (const path of Object.values(CORE_WASM_HEADERS.runtime)) {
      expect(readFileSync(join(sourceRoot, path), "utf8")).not.toContain(
        '#include "extensions/wasm/sdk/',
      );
    }
    for (const path of Object.values(CORE_WASM_HEADERS.sdk)) {
      expect(readFileSync(join(sourceRoot, path), "utf8")).not.toContain(
        '#include "extensions/wasm/runtime/',
      );
    }
  });

  test("reserved-slot fragment remains repeatedly includable", () => {
    const source = readFileSync(
      join(sourceRoot, CORE_WASM_HEADERS.runtime.reservedSlotContract),
      "utf8",
    );
    expect(source).not.toContain("#pragma once");
    expect(source).not.toMatch(/^\s*#ifndef\b/m);
  });
});
