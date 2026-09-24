import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { CORE_PATH, HAS_CORE } from "../../../../test-utils/paths";
import { clangErrorExcerpt, systemGtestCorpora, systemGtestTier } from "../../src/ops/corpus-run";

// the campaign saw "compiler IDL analysis failed: lin…" and nothing else; the cause was on the lines the panel cut.
test("a build failure keeps the lines that explain the first error", () => {
    const stderr = [
        "In file included from Probe.wrapper.cpp:9:",
        "Probe.h:12:9: error: unknown type name 'QX'",
        "    QX::Fees_output lastFees;",
        "    ^",
        "1 error generated.",
    ].join("\n");
    expect(clangErrorExcerpt(stderr)).toBe(
        ["Probe.h:12:9: error: unknown type name 'QX'", "    QX::Fees_output lastFees;", "    ^", "1 error generated."].join("\n"),
    );
    expect(clangErrorExcerpt(stderr, 2)).toBe(["Probe.h:12:9: error: unknown type name 'QX'", "    QX::Fees_output lastFees;"].join("\n"));
    expect(clangErrorExcerpt("linker: cannot find libc\n")).toBe("linker: cannot find libc");
    expect(clangErrorExcerpt("")).toBe("");
});

test.skipIf(!HAS_CORE)("system gtest corpora are discovered from core and split into light and heavy tiers", () => {
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
