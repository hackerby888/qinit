import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeContract } from "@qinit/compile/analyzer";
import { generateClangdConfig, deriveName } from "../../src/clangd-config";

const ADVERSARIAL = [
  "",
  " ".repeat(10000),
  "x".repeat(200000),
  "{".repeat(5000),
  "}".repeat(5000),
  "(".repeat(5000),
  "<".repeat(5000),
  "Array<".repeat(2000),
  '"unterminated string',
  "'",
  "/* unterminated comment",
  "// ".repeat(10000),
  "#if\n#define\n#endif",
  "struct X : public ContractBase {",
  "PUBLIC_PROCEDURE(",
  "STATIC_ASSERT(",
  "for(for(for(",
  "\u0000\u0001\u0002 binary-ish \uffff",
  "a".repeat(50000) + " / " + "b".repeat(50000),
  "Get_output out; ".repeat(2000),
];

test("the source analyzer never throws on adversarial input", () => {
  for (const source of ADVERSARIAL) {
    expect(() => analyzeContract({ source })).not.toThrow();
  }
});

test("findings are always in bounds", () => {
  for (const source of ADVERSARIAL) {
    const findings = analyzeContract({ source }).diagnostics;
    for (const finding of findings) {
      expect(finding.span.start).toBeGreaterThanOrEqual(0);
      expect(finding.span.end).toBeLessThanOrEqual(source.length);
    }
  }
});

test("helpers never throw on odd input", () => {
  for (const source of ["", "no-ext", "a/b\\c.weird", "C:\\x\\Y.h"]) {
    expect(() => deriveName(source)).not.toThrow();
  }
});

test("generateClangdConfig tolerates missing names and odd paths", () => {
  const workspace = mkdtempSync(join(tmpdir(), "qpi-robust-"));
  try {
    expect(() =>
      generateClangdConfig({
        contractPath: join(workspace, "weird.name.h"),
        corePath: "/fake/core",
        workspaceRoot: workspace,
      }),
    ).not.toThrow();
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
