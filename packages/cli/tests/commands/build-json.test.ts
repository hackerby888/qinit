import { expect, test } from "bun:test";
import { buildJsonResult } from "../../src/commands/build";

test("build JSON includes complete failure diagnostics", () => {
  const stderr = Array.from({ length: 80 }, (_, index) => `diagnostic ${index}`).join("\n");
  const result = buildJsonResult({ ok: false, stderr }, "clang");

  expect(result).toEqual({
    ok: false,
    compiler: "clang",
    artifact: null,
    size: null,
    hash: null,
    idl: null,
    idlError: null,
    stderr,
  });
  expect(result.stderr.split("\n")).toHaveLength(80);
});

test("build JSON includes success artifact metadata", () => {
  const result = buildJsonResult(
    {
      ok: true,
      wasmPath: "/tmp/contracts/DigestProbe.wasm",
      wasmSizeBytes: 4096,
      wasmK12DigestHex: "cd".repeat(32),
      idlError: "unsupported layout",
      stderr: "warning: retained in full",
    },
    "typescript",
  );

  expect(result).toEqual({
    ok: true,
    compiler: "typescript",
    artifact: "/tmp/contracts/DigestProbe.wasm",
    size: 4096,
    hash: "cd".repeat(32),
    idl: null,
    idlError: "unsupported layout",
    stderr: "warning: retained in full",
  });
});
