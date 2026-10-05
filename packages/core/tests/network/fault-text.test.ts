// how an abort code reads to a developer, on any host: hex for the code, a source line for an assert.
import { expect, test } from "bun:test";
import { assertLine, describeContractError, WASM_TRAP_ERROR_CODE } from "../../src";

test("assertLine reads the source line out of a CC_ASSERT abort, in either spelling", () => {
    expect(assertLine("abort(3422552092)")).toBe(28);
    expect(assertLine(describeContractError("abort(3422552092)"))).toBe(28);
    expect(assertLine("Error calling smart contract function: abort(0xCC00006E)")).toBe(110);
});

test("assertLine leaves runtime codes and plain messages alone", () => {
    // the trap code and the cheat mutator codes sit above the line range.
    expect(assertLine(`abort(${WASM_TRAP_ERROR_CODE})`)).toBeUndefined();
    expect(assertLine("abort(0xCC1E0002)")).toBeUndefined();
    expect(assertLine("abort(7)")).toBeUndefined();
    expect(assertLine("Exception: integer overflow")).toBeUndefined();
});
