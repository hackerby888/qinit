import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CORE_PATH } from "../../../../test-utils/paths";
import { systemGtestCorpora, systemGtestTier } from "../../src/corpus-run";

test("system gtest corpora are discovered from core and split into light and heavy tiers", () => {
  const corpora = systemGtestCorpora(CORE_PATH);
  expect(corpora.length).toBeGreaterThan(0);
  expect(corpora.some((entry) => entry.tier === "light")).toBe(true);
  expect(corpora.some((entry) => entry.tier === "heavy")).toBe(true);
  expect(corpora.every((entry) => existsSync(entry.contractPath) && existsSync(entry.corpusPath))).toBe(true);
  expect(new Set(corpora.map((entry) => entry.name)).size).toBe(corpora.length);
});

test("routine and resource-heavy system gtests retain their intended tiers", () => {
  expect(systemGtestTier("QUTIL")).toBe("light");
  expect(systemGtestTier("RANDOM")).toBe("light");
  expect(systemGtestTier("QEARN")).toBe("heavy");
  expect(systemGtestTier("PULSE")).toBe("heavy");
  expect(systemGtestTier("NOST")).toBe("heavy");
});
