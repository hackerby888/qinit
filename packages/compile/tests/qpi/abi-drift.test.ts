import { test, expect } from "bun:test";
import { CTX } from "../../src/framework";
// Reach the engine's ABI struct directly (it isn't on the package's public index): QpiContext.OFFSETS is derived from the
import { QpiContext } from "../../../engine/src/abi";

// The framework hardcodes these byte-offsets into the $qpi_invocator / $qpi_originator / $qpi_invocationReward WAT forwarders. If core-lite reorders the
test("framework CTX offsets match the engine's QpiContext layout", () => {
  const O = (QpiContext as unknown as { OFFSETS: Record<string, number> }).OFFSETS;
  // CTX's as-const literal types would pin toBe's generic to the literal — compare as plain numbers.
  expect<number>(CTX.contractIndex).toBe(O.currentContractIndex);
  expect<number>(CTX.originator).toBe(O.originator);
  expect<number>(CTX.invocator).toBe(O.invocator);
  expect<number>(CTX.invocationReward).toBe(O.invocationReward);
});

test("QpiContext header is the 256-byte size the framework carves", () => {
  const SIZE = (QpiContext as unknown as { SIZE: number }).SIZE;
  expect(SIZE).toBe(256);
});
