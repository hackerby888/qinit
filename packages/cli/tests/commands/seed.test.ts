import { expect, test } from "bun:test";
import { formatSeedBalance } from "../../src/commands/seed";

test("formatSeedBalance uses compact QUs labels", () => {
  expect(formatSeedBalance("0")).toBe("0 QUs");
  expect(formatSeedBalance("999")).toBe("999 QUs");
  expect(formatSeedBalance("1000")).toBe("1K QUs");
  expect(formatSeedBalance("1500000")).toBe("1.5M QUs");
  expect(formatSeedBalance("2000000000000")).toBe("2T QUs");
});
