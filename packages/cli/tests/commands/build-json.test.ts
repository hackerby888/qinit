import { expect, test } from "bun:test";
import { buildJsonResult } from "../../src/commands/develop/build";

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
        error: stderr,
        // no VerifyResult on the build means the gate did not run and must not read as "passed".
        protocolRules: "skipped",
        warnings: [],
        strippedCheats: [],
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
            verify: { available: true, ok: true, oracle: false, errors: [] },
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
        idlError: null,
        error: null,
        protocolRules: "checked",
        warnings: [],
        strippedCheats: [],
        stderr: "warning: retained in full",
    });
});

test("build JSON reports the protocol gate as skipped when the verifier was unavailable", () => {
    const result = buildJsonResult(
        {
            ok: true,
            wasmPath: "/tmp/contracts/Probe.wasm",
            verify: { available: false, ok: true, oracle: false, errors: [] },
        },
        "clang",
    );

    expect(result.protocolRules).toBe("skipped");
    expect(result.ok).toBe(true);
});

test("build JSON carries non-fatal build warnings", () => {
    const result = buildJsonResult(
        {
            ok: true,
            wasmPath: "/tmp/contracts/Probe.wasm",
            warnings: ["line 12: `Withdraw` is defined but never registered"],
            strippedCheats: ["CC_ASSERT"],
        },
        "clang",
    );

    expect(result.warnings).toEqual(["line 12: `Withdraw` is defined but never registered"]);
    expect(result.strippedCheats).toEqual(["CC_ASSERT"]);
    expect(result.ok).toBe(true);
});

test("build JSON reports a failed IDL as not ok, with the reason, on either backend", () => {
    for (const compiler of ["clang", "typescript"]) {
        const result = buildJsonResult({ ok: false, idlError: "unsupported layout", stderr: "compiler IDL analysis failed: unsupported layout" }, compiler);

        expect(result.ok).toBe(false);
        expect(result.idlError).toBe("unsupported layout");
        expect(result.error).toBe("compiler IDL analysis failed: unsupported layout");
    }
});
