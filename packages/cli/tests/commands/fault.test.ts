import { expect, test } from "bun:test";
import { describeContractError, formatFault, readFault } from "../../src/ops/fault";

const FAULT = {
    message: "abort(3422552174)",
    phase: "transaction",
    failedTick: 3111,
    failedEpoch: 1,
    lastFinalizedTick: 3110,
    lastFinalizedEpoch: 1,
    slot: 30,
    kind: 1,
    entry: 4,
};

test("formatFault names the contract, the entry, the abort code in hex and the tick", () => {
    expect(formatFault(FAULT, "Probe")).toBe("node halted: Probe proc#4 trapped abort(0xCC00006E) at tick 3111 — run `qinit node run` to restart it");
    // Without a name the slot stands in; a fault outside any contract has neither.
    expect(formatFault(FAULT)).toContain("slot 30 proc#4");
    expect(formatFault({ ...FAULT, slot: undefined, kind: undefined, entry: undefined, message: "log store failed" })).toBe(
        "node halted: trapped log store failed at tick 3111 — run `qinit node run` to restart it",
    );
});

test("describeContractError spells an abort in hex and names the trap code", () => {
    expect(describeContractError("abort(3422552174)")).toBe("abort(0xCC00006E)");
    expect(describeContractError("abort(3424452608)")).toBe("wasm trap");
    expect(describeContractError("Error calling smart contract function: 3424452608")).toBe("Error calling smart contract function: wasm trap");
    expect(describeContractError("Error calling smart contract function: 3422552174")).toBe("Error calling smart contract function: abort(0xCC00006E)");
    expect(describeContractError("Error calling smart contract function: 7")).toBe("Error calling smart contract function: 7");
    expect(formatFault({ ...FAULT, message: "Exception: integer overflow" }, "Probe")).toContain("trapped Exception: integer overflow at tick 3111");
});

test("readFault treats a missing route as healthy and anything else as an error", async () => {
    const missing = Object.assign(new Error("RPC GET /live/v1/dev/fault → HTTP 404"), { status: 404 });
    expect(await readFault({ faultInfo: async () => Promise.reject(missing) })).toBeNull();
    expect(await readFault({ faultInfo: async () => FAULT })).toEqual(FAULT);
    await expect(readFault({ faultInfo: async () => Promise.reject(new Error("node unreachable")) })).rejects.toThrow("node unreachable");
});
