import { test, expect } from "bun:test";
import { CTX } from "../src/framework";
// Reach the engine's ABI struct directly (it isn't on the package's public index): QpiContext.OFFSETS is
// derived from the C-struct layout via defineStruct and pinned to the real bytes by the engine's abi.test.ts.
// That makes it the single source of truth for the per-call context header the framework forwarders read.
import { QpiContext } from "../../engine/src/abi";

// The framework hardcodes these byte-offsets into the $qpi_invocator / $qpi_originator / $qpi_invocationReward
// WAT forwarders. If core-lite reorders the context header, the engine's defineStruct picks it up but this WAT
// would not — silently reading the wrong identity. Pin them so that drift fails the build instead.
test("framework CTX offsets match the engine's QpiContext layout", () => {
  const O = (QpiContext as unknown as { OFFSETS: Record<string, number> }).OFFSETS;
  expect(CTX.contractIndex).toBe(O.currentContractIndex);
  expect(CTX.originator).toBe(O.originator);
  expect(CTX.invocator).toBe(O.invocator);
  expect(CTX.invocationReward).toBe(O.invocationReward);
});

test("QpiContext header is the 256-byte size the framework carves", () => {
  const SIZE = (QpiContext as unknown as { SIZE: number }).SIZE;
  expect(SIZE).toBe(256);
});
