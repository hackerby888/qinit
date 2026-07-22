import { CORE_PATH } from "../../../../test-utils/paths";
import { test, expect } from "bun:test";
import { deriveQpiContextLayout } from "../../src/codegen/module";
import { getQpiContext } from "../../src/compiler/qpi-context";
import { loadQpiHeader } from "../../src/compiler/header";
// Compare compiler and engine context layouts derived from core headers.
import { QpiContext } from "../../../engine/src/abi";

test("live qpi.h context layout matches the engine ABI", () => {
  const layout = deriveQpiContextLayout(getQpiContext(loadQpiHeader(CORE_PATH)).lib);
  const O = (QpiContext as unknown as { OFFSETS: Record<string, number> }).OFFSETS;
  expect(layout.size).toBe((QpiContext as unknown as { SIZE: number }).SIZE);
  expect(layout.contractIndex).toBe(O.currentContractIndex);
  expect(layout.originator).toBe(O.originator);
  expect(layout.invocator).toBe(O.invocator);
  expect(layout.invocationReward).toBe(O.invocationReward);
});
