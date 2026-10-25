// Both backends gate on the same pre-pass, so its two outcomes are pinned here once.
import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyContract, verifyForBuild, verifyRejection } from "../../src/compile/verify";

test("a skipped verify reads as unavailable and never rejects", async () => {
    const verify = await verifyForBuild({ contractPath: "/nowhere/X.h", stateType: "X", calleeNames: [], skipVerify: true });

    expect(verify).toEqual({ available: false, ok: true, oracle: false, errors: [] });
    expect(verifyRejection(verify)).toBeNull();
});

test("a failed verify becomes the build result's own failure shape", () => {
    const verify = { available: true, ok: false, oracle: false, errors: ["Shapes_input is not allowed as input/output type."] };

    expect(verifyRejection(verify)).toEqual({
        ok: false,
        verify,
        stderr: "Qubic protocol violations:\n  • Shapes_input is not allowed as input/output type.",
    });
    expect(verifyRejection({ ...verify, ok: true, errors: [] })).toBeNull();
});

// the verifier's prefix rule reads the state struct, so a deploy name that differs from it must never reach the tool.
test.skipIf(process.platform === "win32")("the verifier is handed the struct, not the deploy name", async () => {
    const directory = mkdtempSync(join(tmpdir(), "qinit-verify-struct-"));
    const tool = join(directory, "contractverify");
    writeFileSync(tool, '#!/bin/sh\ngrep -o "struct [A-Za-z0-9_]*" "$1"\necho "[ ERROR ] seen"\nexit 1\n');
    chmodSync(tool, 0o755);
    const file = join(directory, "MyQutil.h");
    writeFileSync(file, "struct CONTRACT_STATE_TYPE : public ContractBase {};\n");
    const previous = process.env.QINIT_VERIFY;
    process.env.QINIT_VERIFY = tool;
    try {
        const explicit = await verifyContract(file, "MyQutil", { stateType: "QUTIL" });
        expect(explicit.errors[0]).toBe("seen\nstruct QUTIL");

        writeFileSync(file, "struct QUTIL : public ContractBase {};\n");
        const detected = await verifyContract(file, "MyQutil");
        expect(detected.errors[0]).toBe("seen\nstruct QUTIL");
    } finally {
        if (previous === undefined) {
            delete process.env.QINIT_VERIFY;
        } else {
            process.env.QINIT_VERIFY = previous;
        }
        rmSync(directory, { recursive: true, force: true });
    }
});
