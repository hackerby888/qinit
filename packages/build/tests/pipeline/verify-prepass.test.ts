// Both backends gate on the same pre-pass, so its two outcomes are pinned here once.
import { expect, test } from "bun:test";
import { verifyForBuild, verifyRejection } from "../../src/compile/verify";

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
