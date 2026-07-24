import { expect, test } from "bun:test";
import { buildJsonResult } from "../../src/commands/build";

test("build JSON includes complete failure diagnostics", () => {
  const stderr = Array.from({ length: 80 }, (_, index) => `diagnostic ${index}`).join("\n");
  const result = buildJsonResult({ ok: false, stderr }, "native");

  expect(result).toEqual({
    ok: false,
    compiler: "native",
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
      so: "/tmp/contracts/DigestProbe.wasm",
      size: 4096,
      hash: "cd".repeat(32),
      idlError: "unsupported layout",
      stderr: "warning: retained in full",
    },
    "local",
  );

  expect(result).toEqual({
    ok: true,
    compiler: "local",
    artifact: "/tmp/contracts/DigestProbe.wasm",
    size: 4096,
    hash: "cd".repeat(32),
    idl: null,
    idlError: "unsupported layout",
    stderr: "warning: retained in full",
  });
});
